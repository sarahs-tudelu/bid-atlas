import {
  compileDocumentFtsQuery,
  sha256Hex,
  type DocumentMetadataInput,
  type DocumentPayloadClassification,
} from "./contracts.ts";
import { ensureDocumentMetadataIndex } from "./metadata-index.ts";

export class DocumentStorageError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "DocumentStorageError";
    this.status = status;
    this.code = code;
  }
}

export interface StoredDocumentPayload {
  bytes: Uint8Array;
  contentHash: string;
  objectKey: string;
  fileName: string;
  classification: DocumentPayloadClassification;
}

export interface PersistDocumentRequest {
  metadata: DocumentMetadataInput;
  method: "url-import" | "upload";
  actor: string;
  sourceUrl: string;
  fileName?: string;
  payload?: StoredDocumentPayload;
  processingStatus: string;
  processingError?: string;
  reportedBytes?: number;
  reportedMimeType?: string;
}

export interface PersistedDocument {
  documentId: string;
  versionId: string;
  projectId: string;
  contentHash?: string;
  bytes?: number;
  mimeType?: string;
  processingStatus: string;
  deduplicated: boolean;
}

export interface ExtractionChunkInput {
  text: string;
  pageStart?: number;
  pageEnd?: number;
}

export interface ExtractionInput {
  documentId: string;
  versionId: string;
  extractor: string;
  extractorVersion: string;
  method: string;
  language?: string;
  pages?: number;
  confidence?: number;
  chunks: ExtractionChunkInput[];
  actor: string;
}

export interface DocumentDownloadRecord {
  id: string;
  name: string;
  fileName: string | null;
  mimeType: string | null;
  bytes: number | null;
  contentHash: string | null;
  objectKey: string | null;
  visibility: string;
  accessMode: string;
  licenseCode: string | null;
  redistributionAllowed: number;
  storageStatus: string | null;
  securityStatus: string | null;
  uploadedBy: string | null;
}

export interface DocumentSearchOptions {
  query?: string;
  projectId?: string;
  documentType?: string;
  processingStatus?: string;
  publicOnly: boolean;
  actorId?: string;
  internalAccess?: boolean;
  page: number;
  pageSize: number;
}

interface DocumentD1Result<T> {
  results: T[];
}

interface DocumentD1Statement {
  bind(...values: unknown[]): DocumentD1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DocumentD1Result<T>>;
  run(): Promise<unknown>;
}

interface DocumentD1Database {
  prepare(query: string): DocumentD1Statement;
  batch(statements: DocumentD1Statement[]): Promise<unknown[]>;
}

interface DocumentR2Head {
  httpEtag?: string;
  customMetadata?: Record<string, string>;
}

interface DocumentR2Object extends DocumentR2Head {
  body: ReadableStream<Uint8Array>;
}

interface DocumentR2Bucket {
  head(key: string): Promise<DocumentR2Head | null>;
  get(key: string): Promise<DocumentR2Object | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string; contentDisposition?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<DocumentR2Head | null>;
}

export type DocumentStorageBindings = {
  db: DocumentD1Database;
  bucket?: DocumentR2Bucket;
};

type BlobRow = {
  content_hash: string;
  object_key: string;
};

type ExistingDocumentRow = {
  id: string;
  visibility?: string;
  uploaded_by?: string | null;
};

type VersionProjectRow = {
  document_id: string;
  project_id: string;
  content_hash: string | null;
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function internalDocumentActor(actor: string): boolean {
  return actor === "internal-service";
}

function privateOwnershipConflict(): DocumentStorageError {
  return new DocumentStorageError(
    409,
    "private_document_conflict",
    "A private document already owns this project and source URL, or this update would take over a document owned by another user.",
  );
}

function assertDocumentUpdateAllowed(
  existing: ExistingDocumentRow | null,
  actor: string,
): void {
  if (!existing || internalDocumentActor(actor)) return;
  if (existing.uploaded_by !== actor) {
    throw privateOwnershipConflict();
  }
}

function cleanSearchText(metadata: DocumentMetadataInput): string {
  return [
    metadata.name,
    metadata.documentType,
    metadata.description,
    metadata.discipline,
    ...metadata.sheetNumbers,
    ...metadata.keywords,
    metadata.provenance.publisher,
    metadata.provenance.jurisdiction,
    metadata.provenance.sourceName,
    metadata.provenance.sourceRecordId,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);
}

function parsedJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return (value as T | null | undefined) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizedMetadataRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    sheetNumbers: parsedJson<string[]>(row.sheetNumbers, []),
    keywords: parsedJson<string[]>(row.keywords, []),
    ...(row.provenance === undefined
      ? {}
      : { provenance: parsedJson<Record<string, unknown>>(row.provenance, {}) }),
  };
}

async function stableId(prefix: string, value: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(value)).slice(0, 32)}`;
}

async function getBindings(requireBucket: boolean): Promise<DocumentStorageBindings> {
  try {
    // The Cloudflare plugin provides this runtime-only module to the worker build.
    // @ts-expect-error cloudflare:workers is injected by the deployment runtime.
    const { env } = await import("cloudflare:workers");
    if (!env.DB) {
      throw new DocumentStorageError(503, "document_database_unavailable", "Document metadata storage is unavailable.");
    }
    if (requireBucket && !env.DOCUMENTS) {
      throw new DocumentStorageError(503, "document_bucket_unavailable", "Document object storage is unavailable.");
    }
    return {
      db: env.DB as DocumentD1Database,
      bucket: env.DOCUMENTS as DocumentR2Bucket | undefined,
    };
  } catch (error) {
    if (error instanceof DocumentStorageError) throw error;
    throw new DocumentStorageError(503, "document_storage_unavailable", "Document storage bindings are unavailable.");
  }
}

export async function getDocumentDatabase(): Promise<DocumentD1Database> {
  return (await getBindings(false)).db;
}

export async function getDocumentBucket(): Promise<DocumentR2Bucket> {
  const bucket = (await getBindings(true)).bucket;
  if (!bucket) {
    throw new DocumentStorageError(503, "document_bucket_unavailable", "Document object storage is unavailable.");
  }
  return bucket;
}

export async function assertDocumentProjectLinkage(
  projectId: string,
  sourceId: string,
): Promise<void> {
  await assertProjectAndSource(await getDocumentDatabase(), projectId, sourceId);
}

async function assertProjectAndSource(
  db: DocumentD1Database,
  projectId: string,
  sourceId: string,
): Promise<void> {
  const [project, source] = await Promise.all([
    db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").bind(projectId).first<{ id: string }>(),
    db.prepare("SELECT id FROM sources WHERE id = ? LIMIT 1").bind(sourceId).first<{ id: string }>(),
  ]);
  if (!project) {
    throw new DocumentStorageError(404, "project_not_found", "The linked project does not exist in the durable index.");
  }
  if (!source) {
    throw new DocumentStorageError(404, "source_not_found", "The linked source does not exist in the source registry.");
  }
}

async function ensureBlob(
  db: DocumentD1Database,
  bucket: DocumentR2Bucket,
  payload: StoredDocumentPayload,
): Promise<boolean> {
  const existing = await db
    .prepare("SELECT content_hash, object_key FROM document_blobs WHERE content_hash = ? LIMIT 1")
    .bind(payload.contentHash)
    .first<BlobRow>();
  const objectKey = existing?.object_key ?? payload.objectKey;
  const object = await bucket.head(objectKey);
  let r2Etag = object?.httpEtag ?? null;
  if (!object) {
    const stored = await bucket.put(objectKey, payload.bytes, {
      httpMetadata: {
        contentType: payload.classification.mimeType,
        contentDisposition: `attachment; filename="${payload.fileName.replaceAll('"', "-")}"`,
      },
      customMetadata: {
        sha256: payload.contentHash,
        ingestion: "bidatlas-project-document",
      },
    });
    r2Etag = stored?.httpEtag ?? null;
  }
  await db
    .prepare(
      `INSERT INTO document_blobs (
         content_hash, object_key, bytes, mime_type, extension, storage_status,
         security_status, r2_etag, created_at, last_verified_at
       ) VALUES (?, ?, ?, ?, ?, 'ready', 'unscanned', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(content_hash) DO UPDATE SET
         object_key=excluded.object_key,
         bytes=excluded.bytes,
         mime_type=excluded.mime_type,
         extension=excluded.extension,
         storage_status='ready',
         r2_etag=coalesce(excluded.r2_etag, document_blobs.r2_etag),
         last_verified_at=CURRENT_TIMESTAMP`,
    )
    .bind(
      payload.contentHash,
      objectKey,
      payload.bytes.byteLength,
      payload.classification.mimeType,
      payload.classification.extension ?? null,
      r2Etag,
    )
    .run();
  return Boolean(existing && object);
}

export async function persistProjectDocument(
  request: PersistDocumentRequest,
  providedBindings?: DocumentStorageBindings,
): Promise<PersistedDocument> {
  const { db, bucket } = providedBindings ?? await getBindings(Boolean(request.payload));
  await ensureDocumentMetadataIndex(db);
  await assertProjectAndSource(db, request.metadata.projectId, request.metadata.sourceId);

  const existing = await db
    .prepare(
      "SELECT id, visibility, uploaded_by FROM documents WHERE project_id = ? AND source_url = ? LIMIT 1",
    )
    .bind(request.metadata.projectId, request.sourceUrl)
    .first<ExistingDocumentRow>();
  assertDocumentUpdateAllowed(existing, request.actor);

  let deduplicated = false;
  if (request.payload) {
    if (!bucket) {
      throw new DocumentStorageError(503, "document_bucket_unavailable", "Document object storage is unavailable.");
    }
    deduplicated = await ensureBlob(db, bucket, request.payload);
  }

  const documentId = existing?.id ?? await stableId(
    "doc",
    `${request.metadata.projectId}\u0000${request.metadata.sourceId}\u0000${request.sourceUrl}`,
  );
  const versionIdentity = request.payload?.contentHash ?? [
    request.sourceUrl,
    request.metadata.sourceVersionId ?? "",
    request.metadata.publishedAt ?? "",
    "metadata-only",
  ].join("\u0000");
  const existingVersion = request.payload?.contentHash
    ? await db
        .prepare(
          "SELECT id FROM document_versions WHERE document_id = ? AND content_hash = ? LIMIT 1",
        )
        .bind(documentId, request.payload.contentHash)
        .first<ExistingDocumentRow>()
    : null;
  const versionId = existingVersion?.id ?? await stableId(
    "dver",
    `${documentId}\u0000${versionIdentity}`,
  );
  const now = new Date().toISOString();
  const provenance = {
    ...request.metadata.provenance,
    acquisitionMethod: request.method,
    importedAt: now,
    importedBy: request.actor,
  };
  const payloadMimeType = request.payload?.classification.mimeType ?? request.reportedMimeType;
  const payloadBytes = request.payload?.bytes.byteLength ?? request.reportedBytes;
  const fileName = request.fileName ?? request.payload?.fileName;
  const contentHash = request.payload?.contentHash;
  const objectKey = request.payload?.objectKey;

  await db
    .prepare(
      `INSERT INTO documents (
         id, project_id, source_id, name, document_type, description, discipline,
         sheet_numbers, keywords, source_url, access_mode, visibility, license_code,
         license_url, redistribution_allowed, provenance, ingestion_method,
         processing_status, processing_error, search_text, mime_type, content_hash,
         object_key, file_name, bytes, uploaded_by, published_at, first_seen_at,
         last_seen_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )
       ON CONFLICT(project_id, source_url) DO UPDATE SET
         source_id=excluded.source_id,
         name=excluded.name,
         document_type=excluded.document_type,
         description=excluded.description,
         discipline=excluded.discipline,
         sheet_numbers=excluded.sheet_numbers,
         keywords=excluded.keywords,
         access_mode=excluded.access_mode,
         visibility=excluded.visibility,
         license_code=excluded.license_code,
         license_url=excluded.license_url,
         redistribution_allowed=excluded.redistribution_allowed,
         provenance=excluded.provenance,
         ingestion_method=excluded.ingestion_method,
         processing_status=CASE
           WHEN documents.processing_status='text-indexed' THEN documents.processing_status
           WHEN excluded.processing_status='metadata-only' AND documents.object_key IS NOT NULL
             THEN documents.processing_status
           ELSE excluded.processing_status
         END,
         processing_error=CASE
           WHEN excluded.processing_status='metadata-only' AND documents.object_key IS NOT NULL
             THEN documents.processing_error
           ELSE excluded.processing_error
         END,
         search_text=excluded.search_text,
         mime_type=coalesce(excluded.mime_type, documents.mime_type),
         content_hash=coalesce(excluded.content_hash, documents.content_hash),
         object_key=coalesce(excluded.object_key, documents.object_key),
         file_name=coalesce(excluded.file_name, documents.file_name),
         bytes=coalesce(excluded.bytes, documents.bytes),
          uploaded_by=documents.uploaded_by,
         published_at=coalesce(excluded.published_at, documents.published_at),
         last_seen_at=excluded.last_seen_at
        WHERE ? = 1 OR documents.uploaded_by = excluded.uploaded_by`,
    )
    .bind(
      documentId,
      request.metadata.projectId,
      request.metadata.sourceId,
      request.metadata.name,
      request.metadata.documentType,
      request.metadata.description,
      request.metadata.discipline ?? null,
      json(request.metadata.sheetNumbers),
      json(request.metadata.keywords),
      request.sourceUrl,
      request.metadata.accessMode,
      request.metadata.visibility,
      request.metadata.licenseCode ?? null,
      request.metadata.licenseUrl ?? null,
      request.metadata.redistributionAllowed ? 1 : 0,
      json(provenance),
      request.method,
      request.processingStatus,
      request.processingError ?? null,
      cleanSearchText(request.metadata),
      payloadMimeType ?? null,
      contentHash ?? null,
      objectKey ?? null,
      fileName ?? null,
      payloadBytes ?? null,
      request.actor,
      request.metadata.publishedAt ?? null,
      now,
      now,
      internalDocumentActor(request.actor) ? 1 : 0,
    )
    .run();

  const storedDocument = await db
    .prepare("SELECT id, visibility, uploaded_by FROM documents WHERE id = ? LIMIT 1")
    .bind(documentId)
    .first<ExistingDocumentRow>();
  if (!storedDocument) {
    throw new DocumentStorageError(500, "document_write_failed", "The document metadata was not stored.");
  }
  assertDocumentUpdateAllowed(storedDocument, request.actor);
  if (
    !internalDocumentActor(request.actor) &&
    request.metadata.visibility === "private" &&
    storedDocument.uploaded_by !== request.actor
  ) {
    throw privateOwnershipConflict();
  }

  await db
    .prepare(
      `INSERT INTO document_versions (
         id, document_id, source_version_id, normalized_url, content_hash,
         object_key, mime_type, extension, bytes, file_name, access_mode,
         archive_policy, retrieval_status, ingestion_method, processing_status,
         processing_error, created_by, authoritative, posted_at, retrieved_at,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content_hash=coalesce(excluded.content_hash, document_versions.content_hash),
         object_key=coalesce(excluded.object_key, document_versions.object_key),
         mime_type=coalesce(excluded.mime_type, document_versions.mime_type),
         extension=coalesce(excluded.extension, document_versions.extension),
         bytes=coalesce(excluded.bytes, document_versions.bytes),
         file_name=coalesce(excluded.file_name, document_versions.file_name),
         retrieval_status=excluded.retrieval_status,
         processing_status=CASE
           WHEN document_versions.processing_status='text-indexed' THEN document_versions.processing_status
           WHEN excluded.processing_status='metadata-only' AND document_versions.object_key IS NOT NULL
             THEN document_versions.processing_status
           ELSE excluded.processing_status
         END,
         processing_error=CASE
           WHEN excluded.processing_status='metadata-only' AND document_versions.object_key IS NOT NULL
             THEN document_versions.processing_error
           ELSE excluded.processing_error
         END,
         retrieved_at=coalesce(excluded.retrieved_at, document_versions.retrieved_at)`,
    )
    .bind(
      versionId,
      documentId,
      request.metadata.sourceVersionId ?? null,
      request.sourceUrl,
      contentHash ?? null,
      objectKey ?? null,
      payloadMimeType ?? null,
      request.payload?.classification.extension ?? null,
      payloadBytes ?? null,
      fileName ?? null,
      request.metadata.accessMode,
      request.payload ? "content-addressed-r2" : "source-link-only",
      request.payload ? "stored" : "metadata-only",
      request.method,
      request.processingStatus,
      request.processingError ?? null,
      request.actor,
      request.metadata.publishedAt ?? null,
      request.payload ? now : null,
      now,
    )
    .run();

  return {
    documentId,
    versionId,
    projectId: request.metadata.projectId,
    contentHash,
    bytes: payloadBytes,
    mimeType: payloadMimeType,
    processingStatus: request.processingStatus,
    deduplicated,
  };
}

function statementBatches<T>(values: readonly T[], size = 40): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

export async function persistDocumentExtraction(input: ExtractionInput): Promise<string> {
  const db = await getDocumentDatabase();
  const link = await db
    .prepare(
      `SELECT dv.document_id, d.project_id, dv.content_hash
         FROM document_versions dv
         JOIN documents d ON d.id = dv.document_id
        WHERE dv.id = ? AND d.id = ?
        LIMIT 1`,
    )
    .bind(input.versionId, input.documentId)
    .first<VersionProjectRow>();
  if (!link) {
    throw new DocumentStorageError(404, "document_version_not_found", "The document version was not found.");
  }
  const existingExtraction = await db
    .prepare(
      `SELECT id FROM document_extractions
        WHERE document_version_id = ? AND extractor = ? AND extractor_version = ?
        LIMIT 1`,
    )
    .bind(input.versionId, input.extractor, input.extractorVersion)
    .first<ExistingDocumentRow>();
  const extractionId = existingExtraction?.id ?? await stableId(
    "dext",
    `${input.versionId}\u0000${input.extractor}\u0000${input.extractorVersion}`,
  );
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `DELETE FROM document_chunk_fts
        WHERE chunk_id IN (SELECT id FROM document_chunks WHERE extraction_id = ?)`,
    ).bind(extractionId),
    db.prepare("DELETE FROM document_chunks WHERE extraction_id = ?").bind(extractionId),
    db.prepare(
      `INSERT INTO document_extractions (
         id, document_version_id, source_hash, extractor, extractor_version, method,
         status, language, pages, confidence, indexed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?, ?)
       ON CONFLICT(document_version_id, extractor, extractor_version) DO UPDATE SET
         source_hash=excluded.source_hash,
         method=excluded.method,
         status='complete',
         language=excluded.language,
         pages=excluded.pages,
         confidence=excluded.confidence,
         error=NULL,
         indexed_at=excluded.indexed_at`,
    ).bind(
      extractionId,
      input.versionId,
      link.content_hash ?? "metadata-only",
      input.extractor,
      input.extractorVersion,
      input.method,
      input.language ?? null,
      input.pages ?? null,
      input.confidence ?? null,
      now,
      now,
    ),
    db.prepare("UPDATE document_versions SET processing_status = 'text-indexed', processing_error = NULL WHERE id = ?")
      .bind(input.versionId),
    db.prepare("UPDATE documents SET processing_status = 'text-indexed', processing_error = NULL, last_seen_at = ? WHERE id = ?")
      .bind(now, input.documentId),
  ]);

  const statements = input.chunks.flatMap((chunk, index) => {
    const chunkId = `${extractionId}:${String(index + 1).padStart(5, "0")}`;
    return [
      db.prepare(
        `INSERT INTO document_chunks (
           id, extraction_id, project_id, document_version_id, page_start,
           page_end, chunk_order, chunk_text
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        chunkId,
        extractionId,
        link.project_id,
        input.versionId,
        chunk.pageStart ?? null,
        chunk.pageEnd ?? null,
        index,
        chunk.text,
      ),
      db.prepare(
        `INSERT INTO document_chunk_fts (chunk_id, project_id, document_version_id, chunk_text)
         VALUES (?, ?, ?, ?)`,
      ).bind(chunkId, link.project_id, input.versionId, chunk.text),
    ];
  });
  for (const batch of statementBatches(statements)) {
    await db.batch(batch);
  }
  return extractionId;
}

export async function getDocumentDownloadRecord(documentId: string): Promise<DocumentDownloadRecord | null> {
  const db = await getDocumentDatabase();
  return db
    .prepare(
      `SELECT d.id, d.name, d.file_name AS fileName, d.mime_type AS mimeType,
              d.bytes, d.content_hash AS contentHash, d.object_key AS objectKey,
              d.visibility, d.access_mode AS accessMode,
              d.license_code AS licenseCode,
              d.redistribution_allowed AS redistributionAllowed,
              b.storage_status AS storageStatus, b.security_status AS securityStatus,
              d.uploaded_by AS uploadedBy
         FROM documents d
         LEFT JOIN document_blobs b ON b.content_hash = d.content_hash
        WHERE d.id = ?
        LIMIT 1`,
    )
    .bind(documentId)
    .first<DocumentDownloadRecord>();
}

export async function getDocumentMetadata(documentId: string): Promise<Record<string, unknown> | null> {
  const db = await getDocumentDatabase();
  const document = await db
    .prepare(
      `SELECT id, project_id AS projectId, source_id AS sourceId, name,
              document_type AS documentType, description, discipline, sheet_numbers AS sheetNumbers,
              keywords, source_url AS sourceUrl, access_mode AS accessMode, visibility,
              license_code AS licenseCode, license_url AS licenseUrl,
              redistribution_allowed AS redistributionAllowed, provenance, ingestion_method AS ingestionMethod,
              processing_status AS processingStatus, processing_error AS processingError,
              mime_type AS mimeType, content_hash AS contentHash, file_name AS fileName,
              bytes, uploaded_by AS uploadedBy, published_at AS publishedAt, first_seen_at AS firstSeenAt,
              last_seen_at AS lastSeenAt, last_seen_at AS updatedAt
         FROM documents WHERE id = ? LIMIT 1`,
    )
    .bind(documentId)
    .first<Record<string, unknown>>();
  if (!document) return null;
  const versions = await db
    .prepare(
      `SELECT id, source_version_id AS sourceVersionId, normalized_url AS normalizedUrl,
              content_hash AS contentHash, mime_type AS mimeType, extension, bytes,
              file_name AS fileName, access_mode AS accessMode, retrieval_status AS retrievalStatus,
              processing_status AS processingStatus, processing_error AS processingError,
              posted_at AS postedAt, retrieved_at AS retrievedAt, created_at AS createdAt
         FROM document_versions WHERE document_id = ? ORDER BY created_at DESC`,
    )
    .bind(documentId)
    .all<Record<string, unknown>>();
  return { ...normalizedMetadataRow(document), versions: versions.results };
}

export async function searchDocumentMetadata(options: DocumentSearchOptions): Promise<{
  documents: Record<string, unknown>[];
  total: number;
}> {
  const db = await getDocumentDatabase();
  await ensureDocumentMetadataIndex(db);
  const fts = compileDocumentFtsQuery(options.query ?? "");
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (options.projectId) {
    clauses.push("d.project_id = ?");
    bindings.push(options.projectId);
  }
  if (options.documentType) {
    clauses.push("d.document_type = ?");
    bindings.push(options.documentType);
  }
  if (options.processingStatus) {
    clauses.push("d.processing_status = ?");
    bindings.push(options.processingStatus);
  }
  if (options.publicOnly) {
    clauses.push(
      "d.visibility = 'public' AND d.access_mode = 'public' AND trim(coalesce(d.license_code, '')) <> '' AND d.redistribution_allowed = 1",
    );
  } else if (!options.internalAccess) {
    if (!options.actorId) {
      throw new DocumentStorageError(401, "unauthorized", "A workspace identity is required for non-public document search.");
    }
    clauses.push("(d.visibility <> 'private' OR d.uploaded_by = ?)");
    bindings.push(options.actorId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const cte = fts
    ? `WITH raw_matches AS (
         SELECT document_id, 'metadata' AS matched_in
           FROM document_metadata_fts
          WHERE document_metadata_fts MATCH ?
         UNION ALL
         SELECT dv.document_id, 'extracted-text' AS matched_in
           FROM document_chunk_fts
           JOIN document_versions dv ON dv.id = document_chunk_fts.document_version_id
          WHERE document_chunk_fts MATCH ?
       ), matches AS (
         SELECT document_id, group_concat(DISTINCT matched_in) AS matched_in
           FROM raw_matches GROUP BY document_id
       )`
    : "";
  const matchJoin = fts ? "JOIN matches m ON m.document_id = d.id" : "";
  const matchedIn = fts ? "m.matched_in" : "'unfiltered'";
  const queryBindings = fts ? [fts, fts, ...bindings] : bindings;
  const offset = (options.page - 1) * options.pageSize;
  const result = await db
    .prepare(
      `${cte}
       SELECT d.id, d.project_id AS projectId, d.source_id AS sourceId, d.name,
              d.document_type AS documentType, d.description, d.discipline,
              d.sheet_numbers AS sheetNumbers, d.keywords, d.source_url AS sourceUrl,
              d.access_mode AS accessMode, d.visibility, d.license_code AS licenseCode,
              d.license_url AS licenseUrl, d.redistribution_allowed AS redistributionAllowed,
              d.processing_status AS processingStatus, d.processing_error AS processingError,
              d.mime_type AS mimeType, d.content_hash AS contentHash, d.file_name AS fileName,
              d.bytes, d.published_at AS publishedAt, d.last_seen_at AS updatedAt,
              ${matchedIn} AS matchedIn, count(*) OVER() AS totalCount
         FROM documents d
         ${matchJoin}
         ${where}
        ORDER BY coalesce(d.published_at, d.last_seen_at) DESC, d.id
        LIMIT ? OFFSET ?`,
    )
    .bind(...queryBindings, options.pageSize, offset)
    .all<Record<string, unknown>>();
  const documents = result.results.map((row) => {
    const document = { ...row };
    delete document.totalCount;
    return normalizedMetadataRow(document);
  });
  const total = Number(result.results[0]?.totalCount ?? 0);
  return { documents, total: Number.isFinite(total) ? total : 0 };
}
