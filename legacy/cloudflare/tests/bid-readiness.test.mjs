import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./ts-extension-loader.mjs", import.meta.url));

const {
  actionableBidDocuments,
  assessBidReadiness,
  isBidReadyProject,
} = await import("../app/lib/bid-readiness.ts");
const { projectFilterSql } = await import("../db/search-repository.ts");

const NOW = new Date("2026-07-20T16:00:00.000Z");

function readyProject(overrides = {}) {
  return {
    id: "fixture:ready",
    sourceId: "fixture-procurement",
    sourceRecordId: "IFB-2026-101",
    title: "Community center canopy replacement",
    summary: "Furnish and install architectural canopy assemblies.",
    stage: "bidding",
    status: "Open",
    agency: "Fixture Public Works",
    city: "Albany",
    state: "NY",
    bidDate: "2026-07-21T18:00:00.000Z",
    bidDateTimeZone: "America/New_York",
    updatedAt: "2026-07-20T12:00:00.000Z",
    sourceName: "Fixture bids",
    sourceUrl: "https://bids.example.gov/IFB-2026-101",
    provenance: "live-public-page",
    confidence: "official",
    documents: [
      {
        name: "Plans and specifications",
        kind: "plans",
        url: "https://bids.example.gov/files/IFB-2026-101.pdf",
        access: "public",
        indexStatus: "metadata-only",
      },
    ],
    participants: [],
    ...overrides,
  };
}

test("a complete, current official solicitation is bid-ready", () => {
  const project = readyProject();
  assert.equal(isBidReadyProject(project, NOW), true);
  assert.deepEqual(assessBidReadiness(project, NOW).reasons, []);
  assert.equal(actionableBidDocuments(project).length, 1);
});

test("planning leads, inferred records, insecure sources, and missing facts are rejected", () => {
  const cases = [
    [readyProject({ stage: "planning" }), "not-bidding"],
    [readyProject({ confidence: "inferred" }), "not-official"],
    [readyProject({ sourceUrl: "http://example.gov/bid" }), "missing-official-source"],
    [readyProject({ summary: "" }), "missing-bid-facts"],
    [readyProject({ city: undefined, state: undefined }), "missing-location"],
    [readyProject({ bidDate: undefined }), "missing-deadline"],
  ];

  for (const [project, reason] of cases) {
    const result = assessBidReadiness(project, NOW);
    assert.equal(result.ready, false, reason);
    assert.ok(result.reasons.includes(reason), reason);
  }
});

test("timed deadlines expire immediately but date-only deadlines remain through their day", () => {
  const timedClosed = readyProject({ bidDate: "2026-07-20T15:59:59.000Z" });
  assert.ok(assessBidReadiness(timedClosed, NOW).reasons.includes("deadline-passed"));

  const dateOnlyToday = readyProject({
    bidDate: "2026-07-20T00:00:00.000Z",
    bidDateTimeZone: "UTC",
  });
  assert.equal(isBidReadyProject(dateOnlyToday, new Date("2026-07-20T23:59:59.000Z")), true);

  const dateOnlyYesterday = readyProject({
    bidDate: "2026-07-19T00:00:00.000Z",
    bidDateTimeZone: "UTC",
  });
  assert.ok(assessBidReadiness(dateOnlyYesterday, NOW).reasons.includes("deadline-passed"));

  const centralDateOnly = readyProject({
    sourceId: "texas-dot-state-let-construction",
    bidDate: "2026-07-20T00:00:00.000Z",
    bidDateTimeZone: "America/Chicago",
  });
  assert.equal(
    isBidReadyProject(centralDateOnly, new Date("2026-07-21T03:59:59.000Z")),
    true,
    "the date-only sentinel remains open through its source-local calendar day",
  );
  assert.ok(
    assessBidReadiness(centralDateOnly, new Date("2026-07-21T05:00:00.000Z"))
      .reasons.includes("deadline-passed"),
  );
});

test("only actionable plan, specification, and addendum routes qualify", () => {
  const sourceRecordOnly = readyProject({
    documents: [{
      name: "Opportunity detail",
      kind: "source-record",
      url: "https://bids.example.gov/IFB-2026-101",
      access: "public",
    }],
  });
  assert.ok(assessBidReadiness(sourceRecordOnly, NOW).reasons.includes("missing-bid-documents"));

  const hiddenPlan = readyProject({
    documents: [{
      name: "Restricted plan",
      kind: "plans",
      url: "https://bids.example.gov/restricted.pdf",
      access: "free-account",
      indexStatus: "not-public",
    }],
  });
  assert.ok(assessBidReadiness(hiddenPlan, NOW).reasons.includes("missing-bid-documents"));

  const accountPlan = readyProject({
    documents: [{
      name: "Portal plan room",
      kind: "specifications",
      url: "https://bids.example.gov/plan-room",
      access: "free-account",
      indexStatus: "account-gated",
    }],
  });
  assert.equal(isBidReadyProject(accountPlan, NOW), true);
});

test("persisted search applies the bid-ready gate before result counting and paging", () => {
  const filter = projectFilterSql(
    {
      keywords: [],
      match: "all",
      freshness: "all",
      includeArchived: false,
      readiness: "bid-ready",
    },
    NOW,
  );

  assert.match(filter.sql, /p\.stage = 'bidding'/);
  assert.match(filter.sql, /bid_ready_s\.source_class = 'procurement'/);
  assert.match(filter.sql, /FROM documents bid_ready_d/);
  assert.match(filter.sql, /time\(p\.bid_date\) = '00:00:00'/);
  assert.match(filter.sql, /bid_ready_d\.ingestion_method = 'source-link'/);
  assert.deepEqual(filter.bindings.slice(0, 2), [
    "michigan-dot-bid-lettings",
    "2026-07-20",
  ]);
  assert.ok(filter.bindings.includes("texas-dot-state-let-construction"));
  assert.ok(filter.bindings.includes("2026-07-20T16:00:00.000Z"));
  assert.match(filter.sql, /date\(p\.bid_date\) >= date\(\?\)/);
});
