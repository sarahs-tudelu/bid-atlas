import {
  parseCreateSourceMonitor,
  parseMonitorStatus,
  sourceMonitorErrorResponse,
  SourceMonitorInputError,
} from "../../lib/source-monitors/contracts";
import {
  createSourceMonitor,
  getSourceMonitorDatabase,
  listSourceMonitors,
  setSourceMonitorStatus,
} from "../../lib/source-monitors/repository";
import {
  getDocumentActor,
  privateJson,
  readDocumentJson,
} from "../../lib/project-documents/http";

export const dynamic = "force-dynamic";

async function workspaceOwner(request: Request): Promise<string> {
  const actor = await getDocumentActor(request);
  if (!actor || actor.kind !== "workspace-user") {
    throw new SourceMonitorInputError(
      401,
      "authentication_required",
      "Sign in before managing monitored sources.",
    );
  }
  return actor.id;
}

export async function GET(request: Request) {
  try {
    const ownerKey = await workspaceOwner(request);
    const db = await getSourceMonitorDatabase();
    return privateJson(await listSourceMonitors(db, ownerKey));
  } catch (error) {
    return sourceMonitorErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ownerKey = await workspaceOwner(request);
    const input = parseCreateSourceMonitor(await readDocumentJson(request));
    const db = await getSourceMonitorDatabase();
    const monitor = await createSourceMonitor(db, ownerKey, input);
    return privateJson({ monitor }, { status: 201 });
  } catch (error) {
    return sourceMonitorErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ownerKey = await workspaceOwner(request);
    const input = parseMonitorStatus(await readDocumentJson(request));
    const db = await getSourceMonitorDatabase();
    const monitor = await setSourceMonitorStatus(db, ownerKey, input.id, input.status);
    return privateJson({ monitor });
  } catch (error) {
    return sourceMonitorErrorResponse(error);
  }
}
