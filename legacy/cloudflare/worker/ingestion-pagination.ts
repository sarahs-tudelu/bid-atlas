import type { SourceCursorRecord, SourcePageRecord } from "../app/lib/types";

export type RefreshPhase = "head" | "continuation";

export interface CompletedRefreshPageTransition {
  refreshSourceIndex: number;
  refreshCursors: Record<string, SourceCursorRecord>;
  refreshPhases: Record<string, RefreshPhase>;
  backfillRunsSinceRefresh: number;
}

interface CompletedRefreshPageInput {
  sourceId: string;
  sourceIndex: number;
  sourceCount: number;
  phase: RefreshPhase;
  page: SourcePageRecord;
  refreshCursors: Record<string, SourceCursorRecord>;
  refreshPhases: Record<string, RefreshPhase>;
}

function assertSourcePosition(sourceIndex: number, sourceCount: number): void {
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0) {
    throw new Error("Refresh source index must be a nonnegative integer.");
  }
  if (!Number.isInteger(sourceCount) || sourceCount <= 0 || sourceIndex >= sourceCount) {
    throw new Error("Refresh source count must include the selected source.");
  }
}

function assertAdvancedContinuation(page: SourcePageRecord): void {
  const nextIsWatermark = page.nextCursor.refreshAfter === true;
  const currentIsWatermark = page.currentCursor.refreshAfter === true;
  if (nextIsWatermark) {
    if (
      page.nextCursor.offset !== 0 ||
      page.nextCursor.lastRecordUniqueId === undefined ||
      page.nextCursor.lastRecordSortValue === undefined
    ) {
      throw new Error("Refresh watermark cursor is incomplete.");
    }
    if (currentIsWatermark && page.recordsRead > 0) {
      const sameBoundary =
        page.nextCursor.lastRecordUniqueId === page.currentCursor.lastRecordUniqueId &&
        page.nextCursor.lastRecordSortValue === page.currentCursor.lastRecordSortValue;
      if (sameBoundary) throw new Error("Refresh watermark cursor did not advance.");
    }
    return;
  }
  if (currentIsWatermark) {
    throw new Error("Refresh watermark cursor cannot be discarded.");
  }
  if (page.hasMore && page.nextCursor.offset <= page.currentCursor.offset) {
    throw new Error("Refresh continuation cursor did not advance.");
  }
}

/**
 * Publish one fully materialized refresh page without monopolizing the worker.
 * Forward-watermark adapters retain a zero-offset sort/id boundary and query
 * strictly after it on their next fair turn. Legacy adapters keep their older
 * alternating head/continuation behavior until they can provide a comparable
 * source-native update watermark.
 */
export function completedRefreshPageTransition({
  sourceId,
  sourceIndex,
  sourceCount,
  phase,
  page,
  refreshCursors,
  refreshPhases,
}: CompletedRefreshPageInput): CompletedRefreshPageTransition {
  assertSourcePosition(sourceIndex, sourceCount);
  if (!sourceId) throw new Error("Refresh source identity is required.");
  assertAdvancedContinuation(page);

  const nextCursors = { ...refreshCursors };
  const nextPhases = { ...refreshPhases };
  if (page.nextCursor.refreshAfter === true) {
    // Forward-only refresh watermarks replace legacy descending continuations.
    // They remain durable even though their offset is zero and even when a
    // delta page is empty or final.
    nextCursors[sourceId] = page.nextCursor;
    nextPhases[sourceId] = "continuation";
  } else if (phase === "continuation") {
    if (page.hasMore) nextCursors[sourceId] = page.nextCursor;
    else delete nextCursors[sourceId];
    nextPhases[sourceId] = "head";
  } else {
    // A head check must not replace an older saved continuation, or frequent
    // new rows could keep resetting this source to page two forever.
    if (!nextCursors[sourceId] && page.hasMore) {
      nextCursors[sourceId] = page.nextCursor;
    }
    nextPhases[sourceId] = nextCursors[sourceId] ? "continuation" : "head";
  }

  return {
    refreshSourceIndex: (sourceIndex + 1) % sourceCount,
    refreshCursors: nextCursors,
    refreshPhases: nextPhases,
    backfillRunsSinceRefresh: 0,
  };
}

export function failedRefreshPageTransition(
  sourceIndex: number,
  sourceCount: number,
): Pick<CompletedRefreshPageTransition, "refreshSourceIndex" | "backfillRunsSinceRefresh"> {
  assertSourcePosition(sourceIndex, sourceCount);
  return {
    refreshSourceIndex: (sourceIndex + 1) % sourceCount,
    backfillRunsSinceRefresh: 0,
  };
}
