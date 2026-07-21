import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-extension-loader.mjs", import.meta.url);

const {
  completedRefreshPageTransition,
  failedRefreshPageTransition,
} = await import("../worker/ingestion-pagination.ts");
const { parseCursorState } = await import("../worker/ingestion.ts");
const { PROJECT_SOURCE_IDS } = await import("../app/lib/connectors.ts");

const sourceId = "los-angeles-building-permits-submitted";

function page(currentCursor, nextCursor, hasMore = true, recordsRead = 50) {
  return {
    offset: currentCursor.offset,
    recordsRead,
    nextOffset: nextCursor.offset,
    hasMore,
    currentCursor,
    nextCursor,
  };
}

test("refresh pages rotate sources while retaining independent page-51 continuations", () => {
  const firstContinuation = {
    offset: 50,
    lastRecordUniqueId: "permit-050",
    lastRecordSortValue: "2026-07-01T00:00:00.000",
  };
  const head = completedRefreshPageTransition({
    sourceId,
    sourceIndex: 3,
    sourceCount: 12,
    phase: "head",
    page: page({ offset: 0 }, firstContinuation),
    refreshCursors: {
      "another-source": { offset: 25, lastRecordUniqueId: "other-025" },
    },
    refreshPhases: { "another-source": "continuation" },
  });
  assert.equal(head.refreshSourceIndex, 4, "the next source gets the next refresh turn");
  assert.equal(head.backfillRunsSinceRefresh, 0, "normal backfill cadence resumes first");
  assert.deepEqual(head.refreshCursors[sourceId], firstContinuation);
  assert.equal(head.refreshPhases[sourceId], "continuation");
  assert.deepEqual(head.refreshCursors["another-source"], {
    offset: 25,
    lastRecordUniqueId: "other-025",
  });

  const secondContinuation = {
    offset: 100,
    lastRecordUniqueId: "permit-100",
    lastRecordSortValue: "2026-06-01T00:00:00.000",
  };
  const continuation = completedRefreshPageTransition({
    sourceId,
    sourceIndex: 3,
    sourceCount: 12,
    phase: "continuation",
    page: page(firstContinuation, secondContinuation),
    refreshCursors: head.refreshCursors,
    refreshPhases: head.refreshPhases,
  });
  assert.equal(continuation.refreshSourceIndex, 4);
  assert.deepEqual(continuation.refreshCursors[sourceId], secondContinuation);
  assert.equal(
    continuation.refreshPhases[sourceId],
    "head",
    "the source must revisit its head before consuming another older page",
  );
});

test("a periodic head check never overwrites an older saved continuation", () => {
  const savedContinuation = {
    offset: 100,
    lastRecordUniqueId: "permit-100",
    lastRecordSortValue: "2026-06-01T00:00:00.000",
  };
  const newHeadContinuation = {
    offset: 50,
    lastRecordUniqueId: "new-permit-050",
    lastRecordSortValue: "2026-07-15T00:00:00.000",
  };
  const revisitedHead = completedRefreshPageTransition({
    sourceId,
    sourceIndex: 3,
    sourceCount: 12,
    phase: "head",
    page: page({ offset: 0 }, newHeadContinuation),
    refreshCursors: { [sourceId]: savedContinuation },
    refreshPhases: { [sourceId]: "head" },
  });
  assert.deepEqual(revisitedHead.refreshCursors[sourceId], savedContinuation);
  assert.equal(revisitedHead.refreshPhases[sourceId], "continuation");

  const drained = completedRefreshPageTransition({
    sourceId,
    sourceIndex: 3,
    sourceCount: 12,
    phase: "continuation",
    page: page(savedContinuation, { offset: 0 }, false, 17),
    refreshCursors: revisitedHead.refreshCursors,
    refreshPhases: revisitedHead.refreshPhases,
  });
  assert.equal(drained.refreshCursors[sourceId], undefined);
  assert.equal(drained.refreshPhases[sourceId], "head");
});

test("a forward watermark replaces legacy descending state and survives final or empty pages", () => {
  const legacy = {
    offset: 100,
    lastRecordUniqueId: "legacy-100",
    lastRecordSortValue: "2026-01-01T00:00:00.000",
  };
  const watermark = {
    offset: 0,
    refreshAfter: true,
    lastRecordUniqueId: "new-001",
    lastRecordSortValue: "2026-07-16T00:00:00.000",
  };
  const seeded = completedRefreshPageTransition({
    sourceId,
    sourceIndex: 3,
    sourceCount: 12,
    phase: "head",
    page: page({ offset: 0 }, watermark, false),
    refreshCursors: { [sourceId]: legacy },
    refreshPhases: { [sourceId]: "head" },
  });
  assert.deepEqual(seeded.refreshCursors[sourceId], watermark);
  assert.equal(seeded.refreshPhases[sourceId], "continuation");
  assert.equal(seeded.refreshSourceIndex, 4, "watermark sources still rotate fairly");

  const advanced = {
    ...watermark,
    lastRecordUniqueId: "new-075",
  };
  const final = completedRefreshPageTransition({
    sourceId,
    sourceIndex: 3,
    sourceCount: 12,
    phase: "continuation",
    page: page(watermark, advanced, false, 17),
    refreshCursors: seeded.refreshCursors,
    refreshPhases: seeded.refreshPhases,
  });
  assert.deepEqual(final.refreshCursors[sourceId], advanced);
  assert.equal(final.refreshPhases[sourceId], "continuation");

  const empty = completedRefreshPageTransition({
    sourceId,
    sourceIndex: 3,
    sourceCount: 12,
    phase: "continuation",
    page: page(advanced, advanced, false, 0),
    refreshCursors: final.refreshCursors,
    refreshPhases: final.refreshPhases,
  });
  assert.deepEqual(empty.refreshCursors[sourceId], advanced);
});

test("failed refresh pages rotate fairly without changing any per-source continuation", () => {
  assert.deepEqual(failedRefreshPageTransition(3, 12), {
    refreshSourceIndex: 4,
    backfillRunsSinceRefresh: 0,
  });
});

test("legacy single refresh cursors migrate into per-source continuation state", () => {
  const legacySourceIndex = 2;
  const legacySourceId = PROJECT_SOURCE_IDS[legacySourceIndex];
  const continuation = {
    offset: 50,
    lastRecordUniqueId: "legacy-050",
    lastRecordSortValue: "2026-01-01T00:00:00.000",
  };
  const migrated = parseCursorState(JSON.stringify({
    refreshSourceIndex: legacySourceIndex,
    refreshCursor: continuation,
  }));
  assert.deepEqual(migrated.refreshCursors[legacySourceId], continuation);
  assert.equal(migrated.refreshPhases[legacySourceId], "continuation");

  const activeHead = parseCursorState(JSON.stringify({
    refreshSourceIndex: legacySourceIndex,
    activeLane: "refresh",
    activeSourceIndex: legacySourceIndex,
    refreshCursor: { offset: 0 },
  }));
  assert.deepEqual(activeHead.activeRefreshCursor, { offset: 0 });
  assert.equal(activeHead.activeRefreshPhase, "head");
  assert.equal(activeHead.refreshCursors[legacySourceId], undefined);

  const watermark = {
    offset: 0,
    refreshAfter: true,
    lastRecordUniqueId: "current-001",
    lastRecordSortValue: "2026-07-16T00:00:00.000",
  };
  const parsedWatermark = parseCursorState(JSON.stringify({
    refreshSourceIndex: legacySourceIndex,
    refreshCursors: { [legacySourceId]: watermark },
    refreshPhases: { [legacySourceId]: "head" },
  }));
  assert.deepEqual(parsedWatermark.refreshCursors[legacySourceId], watermark);
  assert.equal(parsedWatermark.refreshPhases[legacySourceId], "continuation");
});

test("scheduled refresh fails closed when a connector claims more rows without advancing", () => {
  assert.throws(
    () =>
      completedRefreshPageTransition({
        sourceId,
        sourceIndex: 0,
        sourceCount: 2,
        phase: "continuation",
        page: page(
          { offset: 50, lastRecordUniqueId: "same" },
          { offset: 50, lastRecordUniqueId: "same" },
        ),
        refreshCursors: {},
        refreshPhases: {},
      }),
    /did not advance/i,
  );
});
