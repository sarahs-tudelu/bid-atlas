import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const {
  MAX_DOCUMENT_BYTES,
  DocumentInputError,
  canReadDocumentAsActor,
  canServeDocumentPublicly,
  classifyIpAddress,
  classifyDocumentPayload,
  compileDocumentFtsQuery,
  normalizePublicHttpsUrl,
  objectKeyForHash,
  parseDocumentMetadata,
  sanitizePublicDocumentMetadata,
  sha256Hex,
} = await import("../app/lib/project-documents/contracts.ts");
const { parseExtractionInput } = await import("../app/lib/project-documents/extraction.ts");
const { ensureDocumentMetadataIndex } = await import("../app/lib/project-documents/metadata-index.ts");
const { readRemoteProjectDocument } = await import("../app/lib/project-documents/ingestion.ts");
const { persistProjectDocument } = await import("../app/lib/project-documents/storage.ts");

const PUBLIC_DNS = async () => ["93.184.216.34"];

function metadata(overrides = {}) {
  return {
    projectId: "source:project-1",
    sourceId: "official-source",
    name: "Architectural drawing set",
    documentType: "drawings",
    sourceUrl: "https://procurement.example.gov/projects/1/drawings.pdf",
    ...overrides,
  };
}

test("document metadata supports plans, specs, addenda, drawings, and CAD without making blobs public", () => {
  for (const documentType of ["plans", "specifications", "addenda", "drawings", "cad"]) {
    const parsed = parseDocumentMetadata(metadata({ documentType, fetchBytes: false }), "url-import");
    assert.equal(parsed.documentType, documentType);
    assert.equal(parsed.visibility, "workspace");
    assert.equal(parsed.redistributionAllowed, false);
    assert.equal(parsed.fetchBytes, false);
  }

  assert.throws(
    () => parseDocumentMetadata(metadata({ visibility: "public" }), "url-import"),
    (error) => error instanceof DocumentInputError && error.code === "public_visibility_requires_rights",
  );
  const publicRecord = parseDocumentMetadata(
    metadata({
      visibility: "public",
      accessMode: "public",
      licenseCode: "source-terms-reviewed",
      redistributionAllowed: true,
    }),
    "url-import",
  );
  assert.equal(publicRecord.visibility, "public");
});

test("URL imports reject insecure and private-network targets, including unsafe redirects", async () => {
  for (const value of [
    "http://example.gov/plans.pdf",
    "https://localhost/plans.pdf",
    "https://127.0.0.1/plans.pdf",
    "https://10.1.2.3/plans.pdf",
    "https://[::ffff:127.0.0.1]/plans.pdf",
    "https://user:secret@example.gov/plans.pdf",
  ]) {
    assert.throws(() => normalizePublicHttpsUrl(value), DocumentInputError);
  }
  assert.equal(
    normalizePublicHttpsUrl("https://public.example.gov/plans.pdf#sheet-1"),
    "https://public.example.gov/plans.pdf",
  );

  await assert.rejects(
    () => readRemoteProjectDocument(
      "https://public.example.gov/plans.pdf",
      "Plans",
      async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private.pdf" } }),
      PUBLIC_DNS,
    ),
    (error) => error instanceof DocumentInputError && error.code === "unsafe_sourceUrl",
  );
});

test("safe type and byte limits retain oversize URL metadata while hashing allowed payloads", async () => {
  assert.equal(classifyDocumentPayload("plans.pdf", "application/pdf").supported, true);
  assert.equal(classifyDocumentPayload("model.rvt", "application/octet-stream").conversionPending, true);
  assert.equal(classifyDocumentPayload("payload.html", "text/html").supported, false);

  const bytes = new TextEncoder().encode("sample drawing bytes");
  const firstHash = await sha256Hex(bytes);
  const secondHash = await sha256Hex(bytes);
  assert.equal(firstHash, secondHash);
  assert.equal(objectKeyForHash(firstHash), `project-documents/sha256/${firstHash.slice(0, 2)}/${firstHash}`);

  const remote = await readRemoteProjectDocument(
    "https://public.example.gov/plans.pdf",
    "Plans",
    async () => new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="issued-plans.pdf"',
      },
    }),
    PUBLIC_DNS,
  );
  assert.equal(remote.payload?.contentHash, firstHash);
  assert.equal(remote.fileName, "issued-plans.pdf");

  const oversize = await readRemoteProjectDocument(
    "https://public.example.gov/large-model.rvt",
    "Model",
    async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(MAX_DOCUMENT_BYTES + 1),
      },
    }),
    PUBLIC_DNS,
  );
  assert.equal(oversize.payload, undefined);
  assert.match(oversize.processingError ?? "", /exceeds.*limit.*metadata/i);
});

test("remote imports fail closed on private DNS answers and enforce a whole-operation timeout", async () => {
  let fetched = false;
  await assert.rejects(
    () => readRemoteProjectDocument(
      "https://public.example.gov/plans.pdf",
      "Plans",
      async () => {
        fetched = true;
        return new Response("not reached");
      },
      async () => ["127.0.0.1"],
    ),
    (error) => error instanceof DocumentInputError && error.code === "unsafe_source_resolution",
  );
  assert.equal(fetched, false);

  await assert.rejects(
    () => readRemoteProjectDocument(
      "https://public.example.gov/plans.pdf",
      "Plans",
      async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      }),
      PUBLIC_DNS,
      5,
    ),
    (error) => error instanceof DocumentInputError && error.code === "source_fetch_timeout",
  );
});

test("private document access is owner-only while workspace records remain shared", () => {
  const alice = { id: "alice@example.com", kind: "workspace-user" };
  const bob = { id: "bob@example.com", kind: "workspace-user" };
  const internal = { id: "internal-service", kind: "internal-service" };
  assert.equal(canReadDocumentAsActor({ visibility: "workspace", uploadedBy: "alice@example.com" }, bob), true);
  assert.equal(canReadDocumentAsActor({ visibility: "private", uploadedBy: "alice@example.com" }, alice), true);
  assert.equal(canReadDocumentAsActor({ visibility: "private", uploadedBy: "alice@example.com" }, bob), false);
  assert.equal(canReadDocumentAsActor({ visibility: "private", uploadedBy: null }, alice), false);
  assert.equal(canReadDocumentAsActor({ visibility: "private", uploadedBy: null }, internal), true);
  assert.equal(classifyIpAddress("10.0.0.1"), "blocked");
  assert.equal(classifyIpAddress("2606:4700:4700::1111"), "public");
  assert.equal(classifyIpAddress("public.example.gov"), "not-ip");
});

test("anonymous public metadata redacts actor identity but preserves source provenance", () => {
  const sanitized = sanitizePublicDocumentMetadata({
    id: "doc_public",
    uploadedBy: "alice@example.com",
    provenance: {
      publisher: "City Building Department",
      jurisdiction: "Example City",
      sourceRecordId: "permit-42",
      licenseEvidenceUrl: "https://example.gov/terms",
      acquisitionMethod: "url-import",
      importedAt: "2026-07-16T12:00:00.000Z",
      importedBy: "alice@example.com",
      actorId: "internal-service",
    },
  });

  assert.equal("uploadedBy" in sanitized, false);
  assert.deepEqual(sanitized.provenance, {
    publisher: "City Building Department",
    jurisdiction: "Example City",
    sourceRecordId: "permit-42",
    licenseEvidenceUrl: "https://example.gov/terms",
    acquisitionMethod: "url-import",
    importedAt: "2026-07-16T12:00:00.000Z",
  });
});

test("public download requires explicit rights, stored bytes, and security approval", () => {
  const eligible = {
    visibility: "public",
    accessMode: "public",
    licenseCode: "source-terms-reviewed",
    redistributionAllowed: 1,
    storageStatus: "ready",
    securityStatus: "approved",
  };
  assert.equal(canServeDocumentPublicly(eligible), true);
  for (const override of [
    { visibility: "workspace" },
    { accessMode: "free-account" },
    { licenseCode: null },
    { redistributionAllowed: 0 },
    { storageStatus: "missing" },
    { securityStatus: "unscanned" },
  ]) {
    assert.equal(canServeDocumentPublicly({ ...eligible, ...override }), false);
  }
});

test("metadata search compiles bounded literal FTS terms", () => {
  assert.equal(compileDocumentFtsQuery("canopy partition wall"), '"canopy" AND "partition" AND "wall"');
  assert.equal(compileDocumentFtsQuery("  a ; OR * "), '"or"');
  assert.equal(compileDocumentFtsQuery(""), undefined);
});

test("extraction handoff preserves page provenance and bounds searchable text", () => {
  const parsed = parseExtractionInput(
    "doc_1",
    {
      versionId: "dver_1",
      extractor: "example-ocr",
      extractorVersion: "2026-07",
      method: "ocr",
      language: "en",
      pages: 2,
      confidence: 0.91,
      chunks: [{ pageStart: 1, pageEnd: 2, text: "A-101 canopy detail" }],
    },
    "tester@example.com",
  );
  assert.equal(parsed.documentId, "doc_1");
  assert.deepEqual(parsed.chunks[0], { pageStart: 1, pageEnd: 2, text: "A-101 canopy detail" });
  assert.throws(
    () => parseExtractionInput(
      "doc_1",
      {
        versionId: "dver_1",
        extractor: "x",
        extractorVersion: "1",
        method: "unknown",
        chunks: [{ text: "text" }],
      },
      "tester@example.com",
    ),
    DocumentInputError,
  );
});

test("migration 0010 adds metadata FTS and runtime initialization maintains its triggers", async () => {
  const migration = await readFile(new URL("../drizzle/0010_sticky_mephisto.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE `document_blobs`/);
  assert.match(migration, /`content_hash` text PRIMARY KEY NOT NULL/);
  assert.match(migration, /CREATE UNIQUE INDEX `document_blobs_object_key_uidx`/);
  assert.match(migration, /CREATE VIRTUAL TABLE `document_metadata_fts` USING fts5/);
  assert.doesNotMatch(migration, /CREATE TRIGGER/);
  assert.match(migration, /ALTER TABLE `documents` ADD `visibility` text DEFAULT 'workspace' NOT NULL/);
  assert.match(migration, /ALTER TABLE `documents` ADD `redistribution_allowed` integer DEFAULT false NOT NULL/);

  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_id TEXT NOT NULL,
        name TEXT NOT NULL, document_type TEXT NOT NULL, source_url TEXT NOT NULL,
        access_mode TEXT NOT NULL, mime_type TEXT, content_hash TEXT, object_key TEXT,
        published_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX documents_source_url_uidx ON documents(project_id, source_url);
      CREATE TABLE document_versions (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL, source_version_id TEXT,
        normalized_url TEXT NOT NULL, content_hash TEXT, object_key TEXT, mime_type TEXT,
        extension TEXT, bytes INTEGER, access_mode TEXT NOT NULL, archive_policy TEXT NOT NULL,
        retrieval_status TEXT NOT NULL, authoritative INTEGER NOT NULL DEFAULT 1,
        posted_at TEXT, retrieved_at TEXT, supersedes_id TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO documents VALUES (
        'doc_existing', 'project_1', 'source_1', 'Old plans', 'plans',
        'https://example.gov/old.pdf', 'public', 'application/pdf', NULL, NULL,
        NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `);
    for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      database.exec(statement);
    }
    await ensureDocumentMetadataIndex({
      prepare(sql) {
        return { run: async () => database.prepare(sql).run() };
      },
    });
    assert.equal(
      database.prepare("SELECT name FROM document_metadata_fts WHERE document_id='doc_existing'").get()?.name,
      "Old plans",
    );
    database.prepare("UPDATE documents SET name='Issued canopy plans' WHERE id='doc_existing'").run();
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM document_metadata_fts WHERE document_metadata_fts MATCH 'canopy'").get()?.count,
      1,
    );
    database.prepare("DELETE FROM documents WHERE id='doc_existing'").run();
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM document_metadata_fts WHERE document_id='doc_existing'").get()?.count,
      0,
    );
  } finally {
    database.close();
  }
});

test("D1/R2 persistence deduplicates bytes and prevents cross-user workspace takeover", async () => {
  const migration = await readFile(new URL("../drizzle/0010_sticky_mephisto.sql", import.meta.url), "utf8");
  const database = new DatabaseSync(":memory:");
  class TestStatement {
    constructor(statement, bindings = []) {
      this.statement = statement;
      this.bindings = bindings;
    }
    bind(...bindings) {
      return new TestStatement(this.statement, bindings);
    }
    async first() {
      return this.statement.get(...this.bindings) ?? null;
    }
    async all() {
      return { results: this.statement.all(...this.bindings) };
    }
    async run() {
      return this.statement.run(...this.bindings);
    }
  }
  const d1 = {
    prepare(sql) {
      return new TestStatement(database.prepare(sql));
    },
    async batch(statements) {
      const output = [];
      for (const statement of statements) output.push(await statement.run());
      return output;
    },
  };
  const objects = new Map();
  let putCalls = 0;
  const bucket = {
    async head(key) {
      return objects.get(key) ?? null;
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async put(key, value, options) {
      putCalls += 1;
      const copy = new Uint8Array(value);
      const object = {
        body: new ReadableStream({ start(controller) { controller.enqueue(copy); controller.close(); } }),
        httpEtag: `"etag-${putCalls}"`,
        customMetadata: options?.customMetadata ?? {},
      };
      objects.set(key, object);
      return object;
    },
  };

  try {
    database.exec(`
      CREATE TABLE sources (id TEXT PRIMARY KEY);
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_id TEXT NOT NULL,
        name TEXT NOT NULL, document_type TEXT NOT NULL, source_url TEXT NOT NULL,
        access_mode TEXT NOT NULL, mime_type TEXT, content_hash TEXT, object_key TEXT,
        published_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX documents_source_url_uidx ON documents(project_id, source_url);
      CREATE TABLE document_versions (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL, source_version_id TEXT,
        normalized_url TEXT NOT NULL, content_hash TEXT, object_key TEXT, mime_type TEXT,
        extension TEXT, bytes INTEGER, access_mode TEXT NOT NULL, archive_policy TEXT NOT NULL,
        retrieval_status TEXT NOT NULL, authoritative INTEGER NOT NULL DEFAULT 1,
        posted_at TEXT, retrieved_at TEXT, supersedes_id TEXT, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX document_versions_hash_uidx ON document_versions(document_id, content_hash);
      INSERT INTO sources(id) VALUES ('official-source');
      INSERT INTO projects(id) VALUES ('source:project-1');
    `);
    for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      database.exec(statement);
    }
    const parsedMetadata = parseDocumentMetadata(metadata(), "url-import");
    const bytes = new TextEncoder().encode("same durable plan bytes");
    const contentHash = await sha256Hex(bytes);
    const payload = {
      bytes,
      contentHash,
      objectKey: objectKeyForHash(contentHash),
      fileName: "drawings.pdf",
      classification: classifyDocumentPayload("drawings.pdf", "application/pdf"),
    };
    const request = {
      metadata: parsedMetadata,
      method: "url-import",
      actor: "tester@example.com",
      sourceUrl: parsedMetadata.sourceUrl,
      fileName: payload.fileName,
      payload,
      processingStatus: "stored-awaiting-extraction",
    };
    const first = await persistProjectDocument(request, { db: d1, bucket });
    const second = await persistProjectDocument(request, { db: d1, bucket });
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(first.objectKey, undefined);
    assert.equal(first.documentId, second.documentId);
    assert.equal(first.versionId, second.versionId);
    assert.equal(putCalls, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM document_blobs").get().count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM documents").get().count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM document_versions").get().count, 1);

    await assert.rejects(
      () => persistProjectDocument(
        {
          ...request,
          actor: "another-user@example.com",
          metadata: {
            ...parsedMetadata,
            name: "Attacker replacement",
            visibility: "public",
            accessMode: "public",
            licenseCode: "attacker-asserted-rights",
            redistributionAllowed: true,
          },
        },
        { db: d1, bucket },
      ),
      (error) => error?.code === "private_document_conflict",
    );
    const workspaceRow = database.prepare(
      `SELECT name, visibility, access_mode AS accessMode,
              redistribution_allowed AS redistributionAllowed,
              uploaded_by AS uploadedBy
         FROM documents WHERE id = ?`,
    ).get(first.documentId);
    assert.deepEqual({ ...workspaceRow }, {
      name: parsedMetadata.name,
      visibility: "workspace",
      accessMode: "public",
      redistributionAllowed: 0,
      uploadedBy: "tester@example.com",
    });

    await persistProjectDocument(
      {
        ...request,
        actor: "internal-service",
        metadata: { ...parsedMetadata, name: "Internal service review" },
      },
      { db: d1, bucket },
    );
    assert.deepEqual(
      {
        ...database.prepare(
          "SELECT name, uploaded_by AS uploadedBy FROM documents WHERE id = ?",
        ).get(first.documentId),
      },
      { name: "Internal service review", uploadedBy: "tester@example.com" },
    );

    const privateRequest = {
      ...request,
      metadata: { ...parsedMetadata, visibility: "private" },
    };
    await persistProjectDocument(privateRequest, { db: d1, bucket });
    await assert.rejects(
      () => persistProjectDocument(
        { ...privateRequest, actor: "another-user@example.com" },
        { db: d1, bucket },
      ),
      (error) => error?.code === "private_document_conflict",
    );
    const privateRow = database.prepare(
      "SELECT visibility, uploaded_by AS uploadedBy FROM documents WHERE id = ?",
    ).get(first.documentId);
    assert.deepEqual({ ...privateRow }, { visibility: "private", uploadedBy: "tester@example.com" });
  } finally {
    database.close();
  }
});

test("storage and routes keep R2 keys private and enforce document boundaries", async () => {
  const [storage, downloadRoute, searchRoute, extractionRoute, uploadRoute, documentsClient, schema, integration] = await Promise.all([
    readFile(new URL("../app/lib/project-documents/storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/[documentId]/download/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/search/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/[documentId]/extractions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/upload/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/DocumentsClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/project-documents/INTEGRATION.md", import.meta.url), "utf8"),
  ]);
  assert.match(storage, /bucket\.head\(objectKey\)/);
  assert.match(storage, /if \(!object\)[\s\S]*bucket\.put\(objectKey/);
  assert.match(storage, /ON CONFLICT\(content_hash\) DO UPDATE/);
  assert.match(storage, /document_metadata_fts[\s\S]*document_chunk_fts/);
  assert.doesNotMatch(storage, /objectKey: d\.object_key/);
  assert.match(downloadRoute, /explicitPublic && canServeDocumentPublicly\(record\)/);
  assert.match(downloadRoute, /Content-Disposition/);
  assert.match(downloadRoute, /X-Content-Type-Options/);
  assert.match(searchRoute, /!actor && !publicOnly/);
  assert.match(searchRoute, /actorId: actor\?\.id/);
  assert.match(storage, /d\.visibility <> 'private' OR d\.uploaded_by = \?/);
  assert.match(extractionRoute, /requireInternalDocumentActor/);
  assert.match(uploadRoute, /content_length_required/);
  assert.match(documentsClient, /licenseCode: licenseCode\.trim\(\)/);
  assert.match(schema, /export const documentBlobs = sqliteTable/);
  assert.match(schema, /processingStatus: text\("processing_status"\)/);
  assert.match(integration, /OCR, PDF, or CAD-conversion text/);
});
