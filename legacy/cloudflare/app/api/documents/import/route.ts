import { parseDocumentMetadata } from "../../../lib/project-documents/contracts";
import {
  documentErrorResponse,
  privateJson,
  readDocumentJson,
  requireDocumentActor,
} from "../../../lib/project-documents/http";
import { importProjectDocumentFromUrl } from "../../../lib/project-documents/ingestion";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const actor = await requireDocumentActor(request);
    const metadata = parseDocumentMetadata(await readDocumentJson(request), "url-import");
    const document = await importProjectDocumentFromUrl(metadata, actor.id);
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
