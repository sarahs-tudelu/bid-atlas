import { MAX_EXTRACTION_TEXT_BYTES } from "../../../../lib/project-documents/contracts";
import {
  ingestDocumentExtraction,
  parseExtractionInput,
} from "../../../../lib/project-documents/extraction";
import {
  documentErrorResponse,
  privateJson,
  readDocumentJson,
  requireInternalDocumentActor,
} from "../../../../lib/project-documents/http";

export const dynamic = "force-dynamic";

interface ExtractionRouteProps {
  params: Promise<{ documentId: string }>;
}

export async function POST(request: Request, { params }: ExtractionRouteProps) {
  try {
    const actor = await requireInternalDocumentActor(request);
    const { documentId } = await params;
    const input = parseExtractionInput(
      documentId.trim().slice(0, 200),
      await readDocumentJson(request, MAX_EXTRACTION_TEXT_BYTES + 256 * 1024),
      actor.id,
    );
    const result = await ingestDocumentExtraction(input);
    return privateJson(
      {
        ...result,
        documentId: input.documentId,
        versionId: input.versionId,
        processingStatus: "text-indexed",
      },
      { status: 201 },
    );
  } catch (error) {
    return documentErrorResponse(error);
  }
}
