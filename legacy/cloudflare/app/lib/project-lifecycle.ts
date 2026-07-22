import type { ProjectStage } from "./types";

/**
 * Archived search state is driven only by the canonical project lifecycle.
 * Dates and bid/award statuses intentionally do not participate: an awarded
 * project or one already under construction stays actionable until the source
 * reports actual completion (or cancellation).
 */
export function isArchivedProjectStage(stage: ProjectStage): boolean {
  return stage === "completed" || stage === "cancelled";
}
