export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_INDEX_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_JSON_BYTES = 128 * 1024;
export const MAX_EXTRACTION_TEXT_BYTES = 5 * 1024 * 1024;

export const DOCUMENT_TYPES = [
  "plans",
  "specifications",
  "addenda",
  "drawings",
  "cad",
  "bid-form",
  "schedule",
  "report",
  "other",
] as const;

export const DOCUMENT_ACCESS_MODES = [
  "public",
  "free-account",
  "restricted",
  "private",
] as const;

export const DOCUMENT_VISIBILITIES = ["workspace", "private", "public"] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type DocumentAccessMode = (typeof DOCUMENT_ACCESS_MODES)[number];
export type DocumentVisibility = (typeof DOCUMENT_VISIBILITIES)[number];
export type DocumentIngestionMethod = "url-import" | "upload";

export interface DocumentAccessActor {
  id: string;
  kind: "workspace-user" | "internal-service";
}

export interface DocumentAccessRecord {
  visibility: string;
  uploadedBy?: string | null;
}

export interface DocumentMetadataInput {
  projectId: string;
  sourceId: string;
  name: string;
  documentType: DocumentType;
  description: string;
  discipline?: string;
  sheetNumbers: string[];
  keywords: string[];
  sourceUrl?: string;
  sourceVersionId?: string;
  accessMode: DocumentAccessMode;
  visibility: DocumentVisibility;
  licenseCode?: string;
  licenseUrl?: string;
  redistributionAllowed: boolean;
  publishedAt?: string;
  fetchBytes: boolean;
  provenance: Record<string, string>;
}

export interface DocumentPayloadClassification {
  supported: boolean;
  extension?: string;
  mimeType: string;
  directText: boolean;
  conversionPending: boolean;
}

export class DocumentInputError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "DocumentInputError";
    this.status = status;
    this.code = code;
  }
}

const ALLOWED_EXTENSIONS = new Set([
  "pdf",
  "txt",
  "csv",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "zip",
  "png",
  "jpg",
  "jpeg",
  "tif",
  "tiff",
  "dwg",
  "dxf",
  "dgn",
  "ifc",
  "rvt",
  "rfa",
  "skp",
  "pln",
]);

const CAD_EXTENSIONS = new Set(["dwg", "dxf", "dgn", "ifc", "rvt", "rfa", "skp", "pln"]);
const DIRECT_TEXT_EXTENSIONS = new Set(["txt", "csv", "dxf"]);
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/vnd.dwg",
  "image/x-dwg",
  "application/acad",
  "application/dxf",
  "application/x-dxf",
  "application/vnd.autodesk.revit",
]);

const PROVENANCE_FIELDS = [
  "publisher",
  "jurisdiction",
  "sourceName",
  "sourceRecordId",
  "acquisitionNotes",
  "licenseEvidenceUrl",
] as const;

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DocumentInputError(400, "invalid_document_metadata", "Document metadata must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = typeof record[field] === "string" ? record[field].trim() : "";
  if (!value) {
    throw new DocumentInputError(400, `missing_${field}`, `${field} is required.`);
  }
  if (value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DocumentInputError(400, `invalid_${field}`, `${field} is invalid or too long.`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined {
  if (record[field] === undefined || record[field] === null || record[field] === "") return undefined;
  if (typeof record[field] !== "string") {
    throw new DocumentInputError(400, `invalid_${field}`, `${field} must be text.`);
  }
  const value = record[field].trim();
  if (!value) return undefined;
  if (value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new DocumentInputError(400, `invalid_${field}`, `${field} is invalid or too long.`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  record: Record<string, unknown>,
  field: string,
  allowed: T,
  fallback?: T[number],
): T[number] {
  const raw = record[field];
  if ((raw === undefined || raw === null || raw === "") && fallback !== undefined) return fallback;
  if (typeof raw !== "string" || !allowed.includes(raw.trim() as T[number])) {
    throw new DocumentInputError(
      400,
      `invalid_${field}`,
      `${field} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return raw.trim() as T[number];
}

function booleanValue(record: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = record[field];
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true" || value === "1" || value === 1) return true;
  if (value === false || value === "false" || value === "0" || value === 0) return false;
  throw new DocumentInputError(400, `invalid_${field}`, `${field} must be true or false.`);
}

function stringList(record: Record<string, unknown>, field: string, maxItems: number): string[] {
  const raw = record[field];
  if (raw === undefined || raw === null || raw === "") return [];
  let values: unknown[];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      values = Array.isArray(parsed) ? parsed : trimmed.split(",");
    } catch {
      values = trimmed.split(",");
    }
  } else {
    throw new DocumentInputError(400, `invalid_${field}`, `${field} must be a list of text values.`);
  }
  const normalized = values.map((value) => {
    if (typeof value !== "string") {
      throw new DocumentInputError(400, `invalid_${field}`, `${field} must contain only text values.`);
    }
    const item = value.trim();
    if (!item || item.length > 100 || /[\u0000-\u001f\u007f]/.test(item)) {
      throw new DocumentInputError(400, `invalid_${field}`, `${field} contains an invalid value.`);
    }
    return item;
  });
  const unique = [...new Set(normalized)];
  if (unique.length > maxItems) {
    throw new DocumentInputError(400, `invalid_${field}`, `${field} contains too many values.`);
  }
  return unique;
}

function normalizedDate(record: Record<string, unknown>, field: string): string | undefined {
  const raw = optionalString(record, field, 80);
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || timestamp <= 86_400_000) {
    throw new DocumentInputError(400, `invalid_${field}`, `${field} must be a real published date.`);
  }
  return new Date(timestamp).toISOString();
}

function canonicalIpAddress(value: string): string | undefined {
  const candidate = value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4Parts = candidate.split(".");
  if (
    ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  ) {
    return ipv4Parts.map((part) => String(Number(part))).join(".");
  }
  if (!candidate.includes(":")) return undefined;
  try {
    const hostname = new URL(`https://[${candidate}]/`).hostname.replace(/^\[|\]$/g, "");
    return hostname.includes(":") ? hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function blockedIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255)) return true;
  const [a, b] = numbers;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function blockedIpv6(hostname: string): boolean {
  return hostname === "::" || hostname === "::1" || hostname.startsWith("::ffff:") ||
    hostname.startsWith("fc") || hostname.startsWith("fd") ||
    hostname.startsWith("fe8") || hostname.startsWith("fe9") ||
    hostname.startsWith("fea") || hostname.startsWith("feb") ||
    hostname.startsWith("fec") || hostname.startsWith("fed") ||
    hostname.startsWith("fee") || hostname.startsWith("fef") ||
    hostname.startsWith("ff");
}

export function classifyIpAddress(value: string): "public" | "blocked" | "not-ip" {
  const address = canonicalIpAddress(value);
  if (!address) return "not-ip";
  const blocked = address.includes(":") ? blockedIpv6(address) : blockedIpv4(address);
  return blocked ? "blocked" : "public";
}

export function normalizePublicHttpsUrl(value: string, field = "sourceUrl"): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DocumentInputError(400, `invalid_${field}`, `${field} must be a valid HTTPS URL.`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const blockedName =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".invalid");
  const ipAddressClass = classifyIpAddress(hostname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hostname ||
    blockedName ||
    ipAddressClass === "blocked"
  ) {
    throw new DocumentInputError(
      400,
      `unsafe_${field}`,
      `${field} must use public HTTPS without credentials or a private-network host.`,
    );
  }
  url.hash = "";
  return url.toString();
}

export function canReadDocumentAsActor(
  record: DocumentAccessRecord,
  actor: DocumentAccessActor | null | undefined,
): boolean {
  if (!actor) return false;
  if (actor.kind === "internal-service") return true;
  if (record.visibility !== "private") return true;
  return Boolean(record.uploadedBy && record.uploadedBy === actor.id);
}

const INTERNAL_PUBLIC_METADATA_FIELDS = [
  "actor",
  "actorId",
  "createdBy",
  "importedBy",
  "internalActor",
  "serviceActor",
  "updatedBy",
  "uploadedBy",
] as const;

export function sanitizePublicDocumentMetadata(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = { ...document };
  delete sanitized.uploadedBy;

  if (
    sanitized.provenance &&
    typeof sanitized.provenance === "object" &&
    !Array.isArray(sanitized.provenance)
  ) {
    const provenance = {
      ...(sanitized.provenance as Record<string, unknown>),
    };
    for (const field of INTERNAL_PUBLIC_METADATA_FIELDS) delete provenance[field];
    sanitized.provenance = provenance;
  }

  return sanitized;
}

export function parseDocumentMetadata(
  input: unknown,
  method: DocumentIngestionMethod,
): DocumentMetadataInput {
  const record = objectValue(input);
  const sourceUrlValue = optionalString(record, "sourceUrl", 2_048);
  if (method === "url-import" && !sourceUrlValue) {
    throw new DocumentInputError(400, "missing_sourceUrl", "sourceUrl is required for a URL import.");
  }
  const sourceUrl = sourceUrlValue ? normalizePublicHttpsUrl(sourceUrlValue) : undefined;
  const licenseUrlValue = optionalString(record, "licenseUrl", 2_048);
  const licenseUrl = licenseUrlValue
    ? normalizePublicHttpsUrl(licenseUrlValue, "licenseUrl")
    : undefined;
  const accessMode = enumValue(record, "accessMode", DOCUMENT_ACCESS_MODES, "public");
  const visibility = enumValue(record, "visibility", DOCUMENT_VISIBILITIES, "workspace");
  const redistributionAllowed = booleanValue(record, "redistributionAllowed", false);
  const licenseCode = optionalString(record, "licenseCode", 100);
  if (visibility === "public" && (accessMode !== "public" || !redistributionAllowed || !licenseCode)) {
    throw new DocumentInputError(
      400,
      "public_visibility_requires_rights",
      "Public visibility requires public source access, a recorded license, and explicit redistribution permission.",
    );
  }

  const rawProvenance = record.provenance === undefined
    ? {}
    : objectValue(
        typeof record.provenance === "string"
          ? (() => {
              try {
                return JSON.parse(record.provenance) as unknown;
              } catch {
                throw new DocumentInputError(400, "invalid_provenance", "provenance must be valid JSON.");
              }
            })()
          : record.provenance,
      );
  const provenance: Record<string, string> = {};
  for (const field of PROVENANCE_FIELDS) {
    const value = optionalString(rawProvenance, field, field === "acquisitionNotes" ? 1_000 : 300);
    if (value) provenance[field] = value;
  }

  return {
    projectId: requiredString(record, "projectId", 300),
    sourceId: requiredString(record, "sourceId", 200),
    name: requiredString(record, "name", 300),
    documentType: enumValue(record, "documentType", DOCUMENT_TYPES),
    description: optionalString(record, "description", 4_000) ?? "",
    discipline: optionalString(record, "discipline", 100),
    sheetNumbers: stringList(record, "sheetNumbers", 100),
    keywords: stringList(record, "keywords", 100),
    sourceUrl,
    sourceVersionId: optionalString(record, "sourceVersionId", 300),
    accessMode,
    visibility,
    licenseCode,
    licenseUrl,
    redistributionAllowed,
    publishedAt: normalizedDate(record, "publishedAt"),
    fetchBytes: method === "url-import" ? booleanValue(record, "fetchBytes", true) : true,
    provenance,
  };
}

export function normalizeFileName(value: string): string {
  const leaf = value.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  const sanitized = leaf
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 180)
    .trim();
  return sanitized || "project-document";
}

export function extensionFromName(value: string): string | undefined {
  const match = /\.([a-z0-9]{1,10})$/i.exec(normalizeFileName(value));
  return match?.[1].toLowerCase();
}

export function normalizedMimeType(value?: string | null): string {
  return (value ?? "application/octet-stream").split(";", 1)[0].trim().toLowerCase() ||
    "application/octet-stream";
}

const INLINE_PREVIEW_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
]);

export function canPreviewDocumentInline(value?: string | null): boolean {
  return INLINE_PREVIEW_MIME_TYPES.has(normalizedMimeType(value));
}

export function classifyDocumentPayload(
  fileName: string,
  declaredMimeType?: string | null,
): DocumentPayloadClassification {
  const extension = extensionFromName(fileName);
  const mimeType = normalizedMimeType(declaredMimeType);
  const supportedExtension = extension ? ALLOWED_EXTENSIONS.has(extension) : false;
  const supportedMime = ALLOWED_MIME_TYPES.has(mimeType);
  return {
    supported: supportedExtension && supportedMime,
    extension,
    mimeType,
    directText: Boolean(extension && DIRECT_TEXT_EXTENSIONS.has(extension)) &&
      (mimeType.startsWith("text/") || mimeType === "application/octet-stream" || mimeType === "application/dxf" || mimeType === "application/x-dxf"),
    conversionPending: Boolean(extension && (CAD_EXTENSIONS.has(extension) || extension === "zip")),
  };
}

export function processingStatusFor(
  payload: DocumentPayloadClassification | undefined,
): "metadata-only" | "stored-awaiting-extraction" | "stored-conversion-pending" {
  if (!payload) return "metadata-only";
  return payload.conversionPending ? "stored-conversion-pending" : "stored-awaiting-extraction";
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  const source = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? value
      : new Uint8Array(value);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function objectKeyForHash(contentHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new DocumentInputError(500, "invalid_content_hash", "A valid SHA-256 content hash is required.");
  }
  return `project-documents/sha256/${contentHash.slice(0, 2)}/${contentHash}`;
}

export function compileDocumentFtsQuery(value: string): string | undefined {
  const terms = value
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 12);
  return terms.length ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ") : undefined;
}

export interface PublicDownloadRecord {
  visibility: string;
  accessMode: string;
  licenseCode: string | null;
  redistributionAllowed: number | boolean;
  storageStatus: string | null;
  securityStatus: string | null;
}

export function canServeDocumentPublicly(record: PublicDownloadRecord): boolean {
  return (
    record.visibility === "public" &&
    record.accessMode === "public" &&
    Boolean(record.licenseCode) &&
    Boolean(record.redistributionAllowed) &&
    record.storageStatus === "ready" &&
    record.securityStatus === "approved"
  );
}
