import { getDocumentActor, requireDocumentActor } from "../../../../lib/project-documents/http";
import {
  normalizeProjectId,
  parseResearchRequest,
  readOptionalResearchJson,
  researchErrorResponse,
  ProjectResearchError,
} from "../../../../lib/project-research/contracts";
import {
  getProjectResearchDatabase,
  getProjectResearchRecord,
} from "../../../../lib/project-research/repository";
import { triggerProjectResearch } from "../../../../lib/project-research/service";

export const dynamic = "force-dynamic";

type ResearchRouteProps = {
  params: Promise<{ projectId: string }>;
};

export async function GET(request: Request, { params }: ResearchRouteProps) {
  try {
    const { projectId: rawProjectId } = await params;
    const projectId = normalizeProjectId(rawProjectId);
    const actor = await getDocumentActor(request);
    const db = await getProjectResearchDatabase();
    const research = await getProjectResearchRecord(db, projectId, {
      authenticated: Boolean(actor),
      cached: true,
    });
    if (!research) {
      // Anonymous callers cannot distinguish an unknown project from a
      // workspace-only/unapproved cache.
      throw new ProjectResearchError(404, "project_research_not_found", "No readable cached research exists for this project.");
    }
    return Response.json(
      { research },
      {
        headers: actor
          ? { "Cache-Control": "private, no-store" }
          : { "Cache-Control": "public, max-age=60, s-maxage=60", Vary: "Accept-Encoding" },
      },
    );
  } catch (error) {
    return researchErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: ResearchRouteProps) {
  try {
    const actor = await requireDocumentActor(request);
    const { projectId: rawProjectId } = await params;
    const projectId = normalizeProjectId(rawProjectId);
    const input = parseResearchRequest(await readOptionalResearchJson(request));
    const db = await getProjectResearchDatabase();
    const research = await triggerProjectResearch(db, projectId, actor.id, input.force);
    const status = research.status === "queued" || research.status === "running"
      ? 202
      : research.cached
        ? 200
        : 201;
    return Response.json(
      { research },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return researchErrorResponse(error);
  }
}
