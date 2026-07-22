import { getDocumentActor, privateJson } from "../../../../lib/project-documents/http";
import {
  SourceMonitorInputError,
  sourceMonitorErrorResponse,
} from "../../../../lib/source-monitors/contracts";
import { getSourceMonitorDatabase } from "../../../../lib/source-monitors/repository";
import { scanOwnedSourceMonitor } from "../../../../lib/source-monitors/service";

export const dynamic = "force-dynamic";

type ScanRouteProps = { params: Promise<{ monitorId: string }> };

export async function POST(request: Request, { params }: ScanRouteProps) {
  try {
    const actor = await getDocumentActor(request);
    if (!actor || actor.kind !== "workspace-user") {
      throw new SourceMonitorInputError(401, "authentication_required", "Sign in before scanning a monitored source.");
    }
    const { monitorId: rawMonitorId } = await params;
    const monitorId = rawMonitorId.trim().slice(0, 100);
    if (!monitorId) {
      throw new SourceMonitorInputError(404, "source_monitor_not_found", "The source monitor was not found.");
    }
    const db = await getSourceMonitorDatabase();
    const scan = await scanOwnedSourceMonitor(db, actor.id, monitorId);
    return privateJson({ scan });
  } catch (error) {
    return sourceMonitorErrorResponse(error);
  }
}
