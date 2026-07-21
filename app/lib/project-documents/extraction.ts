import {
  DocumentInputError,
  MAX_EXTRACTION_TEXT_BYTES,
} from "./contracts.ts";
import { persistDocumentExtraction, type ExtractionInput } from "./storage.ts";

const EXTRACTION_METHODS = ["native-text", "ocr", "cad-converter", "manual"] as const;

function textField(
  record: Record<string, unknown>,
  field: string,
  maxLength: number,
  required = true,
): string | undefined {
  const raw = record[field];
  if (raw === undefined || raw === null || raw === "") {
    if (!required) return undefined;
    throw new DocumentInputError(400, `missing_${field}`, `${field} is required.`);
  }
  if (typeof raw !== "string") {
    throw new DocumentInputError(400, `invalid_${field}`, `${field} must be text.`);
  }
  const value = raw.trim();
  if (!value || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new DocumentInputError(400, `invalid_${field}`, `${field} is invalid or too long.`);
  }
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
  integer = false,
): number | undefined {
  if (record[field] === undefined || record[field] === null || record[field] === "") return undefined;
  const value = Number(record[field]);
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new DocumentInputError(400, `invalid_${field}`, `${field} is outside its allowed range.`);
  }
  return value;
}

export function parseExtractionInput(
  documentId: string,
  body: unknown,
  actor: string,
): ExtractionInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DocumentInputError(400, "invalid_extraction", "Extraction input must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const method = textField(record, "method", 40) ?? "";
  if (!EXTRACTION_METHODS.includes(method as (typeof EXTRACTION_METHODS)[number])) {
    throw new DocumentInputError(
      400,
      "invalid_method",
      `method must be one of: ${EXTRACTION_METHODS.join(", ")}.`,
    );
  }
  if (!Array.isArray(record.chunks) || record.chunks.length === 0 || record.chunks.length > 200) {
    throw new DocumentInputError(400, "invalid_chunks", "chunks must contain between 1 and 200 extracted-text chunks.");
  }
  let textBytes = 0;
  const chunks = record.chunks.map((rawChunk, index) => {
    if (!rawChunk || typeof rawChunk !== "object" || Array.isArray(rawChunk)) {
      throw new DocumentInputError(400, "invalid_chunks", `Chunk ${index + 1} must be an object.`);
    }
    const chunk = rawChunk as Record<string, unknown>;
    const text = textField(chunk, "text", 100_000) ?? "";
    textBytes += new TextEncoder().encode(text).byteLength;
    const pageStart = optionalNumber(chunk, "pageStart", 1, 100_000, true);
    const pageEnd = optionalNumber(chunk, "pageEnd", 1, 100_000, true);
    if (pageStart !== undefined && pageEnd !== undefined && pageEnd < pageStart) {
      throw new DocumentInputError(400, "invalid_page_range", `Chunk ${index + 1} has an invalid page range.`);
    }
    return { text, pageStart, pageEnd };
  });
  if (textBytes > MAX_EXTRACTION_TEXT_BYTES) {
    throw new DocumentInputError(413, "extraction_too_large", "Extracted text exceeds the indexing limit.");
  }
  return {
    documentId,
    versionId: textField(record, "versionId", 200) ?? "",
    extractor: textField(record, "extractor", 100) ?? "",
    extractorVersion: textField(record, "extractorVersion", 100) ?? "",
    method,
    language: textField(record, "language", 20, false),
    pages: optionalNumber(record, "pages", 1, 100_000, true),
    confidence: optionalNumber(record, "confidence", 0, 1),
    chunks,
    actor,
  };
}

export async function ingestDocumentExtraction(input: ExtractionInput): Promise<{ extractionId: string }> {
  return { extractionId: await persistDocumentExtraction(input) };
}
