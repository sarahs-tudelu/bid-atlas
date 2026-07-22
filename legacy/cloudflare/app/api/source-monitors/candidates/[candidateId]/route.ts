import {
  getDocumentActor,
  privateJson,
  readDocumentJson,
} from "../../../../lib/project-documents/http";
import {
  parseReviewCandidate,
  SourceMonitorInputError,
  sourceMonitorErrorResponse,
} from "../../../../lib/source-monitors/contracts";
import {
  getSourceMonitorDatabase,
  reviewSourceCandidate,
} from "../../../../lib/source-monitors/repository";

export const dynamic = "force-dynamic";

type CandidateRouteProps = { params: Promise<{ candidateId: string }> };

export async function PATCH(request: Request, { params }: CandidateRouteProps) {
  try {
    const actor = await getDocumentActor(request);
    if (!actor || actor.kind !== "workspace-user") {
      throw new SourceMonitorInputError(401, "authentication_required", "Sign in before reviewing a posting.");
    }
    const { candidateId: rawCandidateId } = await params;
    const candidateId = rawCandidateId.trim().slice(0, 100);
    if (!candidateId) {
      throw new SourceMonitorInputError(404, "candidate_not_found", "The posting candidate was not found.");
    }
    const input = parseReviewCandidate(await readDocumentJson(request));
    const db = await getSourceMonitorDatabase();
    const candidate = await reviewSourceCandidate(db, actor.id, candidateId, input);
    return privateJson({ candidate });
  } catch (error) {
    return sourceMonitorErrorResponse(error);
  }
}
