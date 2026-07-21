import {
  DocumentInputError,
  canReadDocumentAsActor,
  sanitizePublicDocumentMetadata,
} from "../../../lib/project-documents/contracts";
import {
  documentErrorResponse,
  getDocumentActor,
  privateJson,
} from "../../../lib/project-documents/http";
import { getDocumentMetadata } from "../../../lib/project-documents/storage";

export const dynamic = "force-dynamic";

interface DocumentRouteProps {
  params: Promise<{ documentId: string }>;
}

function isPublicMetadata(document: Record<string, unknown>): boolean {
  return document.visibility === "public" &&
    document.accessMode === "public" &&
    Boolean(document.licenseCode) &&
    Boolean(document.redistributionAllowed);
}

export async function GET(request: Request, { params }: DocumentRouteProps) {
  try {
    const { documentId: rawDocumentId } = await params;
    const documentId = rawDocumentId.trim().slice(0, 200);
    if (!documentId) throw new DocumentInputError(404, "document_not_found", "Document not found.");
    const document = await getDocumentMetadata(documentId);
    if (!document) throw new DocumentInputError(404, "document_not_found", "Document not found.");
    const actor = await getDocumentActor(request);
    const explicitPublic = new URL(request.url).searchParams.get("public") === "1";
    const actorCanRead = canReadDocumentAsActor(
      {
        visibility: typeof document.visibility === "string" ? document.visibility : "private",
        uploadedBy: typeof document.uploadedBy === "string" ? document.uploadedBy : null,
      },
      actor,
    );
    if (!actorCanRead && !(explicitPublic && isPublicMetadata(document))) {
      throw new DocumentInputError(404, "document_not_found", "Document not found.");
    }
    const responseDocument = actor
      ? { ...document }
      : sanitizePublicDocumentMetadata(document);
    delete responseDocument.uploadedBy;
    const response = { document: responseDocument };
    return actor
      ? privateJson(response)
      : Response.json(response, { headers: { "Cache-Control": "public, max-age=60, s-maxage=60" } });
  } catch (error) {
    return documentErrorResponse(error);
  }
}
