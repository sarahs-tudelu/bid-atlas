import {
  DocumentInputError,
  MAX_DOCUMENT_BYTES,
  parseDocumentMetadata,
} from "../../../lib/project-documents/contracts";
import {
  documentErrorResponse,
  privateJson,
  requireDocumentActor,
} from "../../../lib/project-documents/http";
import { uploadProjectDocument } from "../../../lib/project-documents/ingestion";

export const dynamic = "force-dynamic";

const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

function metadataFromForm(form: FormData): unknown {
  const encoded = form.get("metadata");
  if (typeof encoded === "string" && encoded.trim()) {
    try {
      return JSON.parse(encoded) as unknown;
    } catch {
      throw new DocumentInputError(400, "invalid_metadata_json", "metadata must contain valid JSON.");
    }
  }
  const metadata: Record<string, unknown> = {};
  for (const field of [
    "projectId",
    "sourceId",
    "name",
    "documentType",
    "description",
    "discipline",
    "sheetNumbers",
    "keywords",
    "sourceUrl",
    "sourceVersionId",
    "accessMode",
    "visibility",
    "licenseCode",
    "licenseUrl",
    "redistributionAllowed",
    "publishedAt",
    "provenance",
  ]) {
    const value = form.get(field);
    if (typeof value === "string") metadata[field] = value;
  }
  return metadata;
}

export async function POST(request: Request) {
  try {
    const actor = await requireDocumentActor(request);
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
      throw new DocumentInputError(415, "multipart_required", "Content-Type must be multipart/form-data.");
    }
    const declaredHeader = request.headers.get("content-length")?.trim();
    if (!declaredHeader) {
      throw new DocumentInputError(
        411,
        "content_length_required",
        "Multipart uploads require a Content-Length header so the byte limit can be enforced before buffering.",
      );
    }
    if (!/^\d+$/.test(declaredHeader)) {
      throw new DocumentInputError(400, "invalid_content_length", "Content-Length must be a whole number of bytes.");
    }
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared <= 0) {
      throw new DocumentInputError(400, "invalid_content_length", "Content-Length is invalid.");
    }
    if (declared > MAX_DOCUMENT_BYTES + MAX_MULTIPART_OVERHEAD_BYTES) {
      throw new DocumentInputError(413, "request_too_large", "The multipart upload is too large.");
    }
    const form = await request.formData();
    const value = form.get("file");
    if (!(value instanceof File)) {
      throw new DocumentInputError(400, "file_required", "A single file field is required.");
    }
    const metadata = parseDocumentMetadata(metadataFromForm(form), "upload");
    const document = await uploadProjectDocument(metadata, value, actor.id);
    return privateJson(
      {
        document,
        links: {
          metadata: `/api/documents/${encodeURIComponent(document.documentId)}`,
          download: `/api/documents/${encodeURIComponent(document.documentId)}/download`,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return documentErrorResponse(error);
  }
}
