import {
  DOCUMENT_TYPES,
  DocumentInputError,
} from "../../../lib/project-documents/contracts";
import {
  documentErrorResponse,
  getDocumentActor,
  privateJson,
} from "../../../lib/project-documents/http";
import { searchDocumentMetadata } from "../../../lib/project-documents/storage";

export const dynamic = "force-dynamic";

const PROCESSING_STATUSES = new Set([
  "metadata-only",
  "stored-awaiting-extraction",
  "stored-conversion-pending",
  "text-indexed",
]);

function bounded(value: string | null, maxLength: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DocumentInputError(400, "invalid_search_filter", "A document search filter is invalid or too long.");
  }
  return normalized;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const publicOnly = url.searchParams.get("public") === "1";
    const actor = await getDocumentActor(request);
    if (!actor && !publicOnly) {
      throw new DocumentInputError(
        401,
        "unauthorized",
        "An authenticated workspace user is required unless explicit public scope is requested.",
      );
    }
    const documentType = bounded(url.searchParams.get("documentType"), 40);
    if (documentType && !DOCUMENT_TYPES.includes(documentType as (typeof DOCUMENT_TYPES)[number])) {
      throw new DocumentInputError(400, "invalid_documentType", "documentType is not supported.");
    }
    const processingStatus = bounded(url.searchParams.get("processingStatus"), 60);
    if (processingStatus && !PROCESSING_STATUSES.has(processingStatus)) {
      throw new DocumentInputError(400, "invalid_processingStatus", "processingStatus is not supported.");
    }
    const requestedPage = Number(url.searchParams.get("page") ?? 1);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 20);
    const page = Number.isFinite(requestedPage) ? Math.max(1, Math.trunc(requestedPage)) : 1;
    const pageSize = Number.isFinite(requestedLimit)
      ? Math.min(50, Math.max(1, Math.trunc(requestedLimit)))
      : 20;
    const searchOptions = {
      query: bounded(url.searchParams.get("q"), 300),
      projectId: bounded(url.searchParams.get("projectId"), 300),
      documentType,
      processingStatus,
      publicOnly,
      actorId: actor?.id,
      internalAccess: actor?.kind === "internal-service",
      page,
      pageSize,
    };
    let result = await searchDocumentMetadata(searchOptions);
    const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
    const responsePage = Math.min(page, totalPages);
    if (responsePage !== page) {
      result = await searchDocumentMetadata({ ...searchOptions, page: responsePage });
    }
    const body = {
      ...result,
      page: responsePage,
      pageSize,
      totalPages,
    };
    if (publicOnly && !actor) {
      return Response.json(body, {
        headers: { "Cache-Control": "public, max-age=60, s-maxage=60" },
      });
    }
    return privateJson(body);
  } catch (error) {
    return documentErrorResponse(error);
  }
}
