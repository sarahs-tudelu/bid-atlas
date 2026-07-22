import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register("./ts-extension-loader.mjs", import.meta.url);

const { projectFilterSql } = await import("../db/search-repository.ts");
const { projectLeadReasons, projectMatchesLeadFilter } = await import(
  "../app/lib/project-leads.ts"
);
const { projectMatchesSearch } = await import("../app/lib/search.ts");

const NOW = new Date("2026-07-22T14:00:00.000Z");

function project(overrides = {}) {
  return {
    id: "lead-1",
    sourceId: "official-source",
    sourceRecordId: "ROW-1",
    title: "Municipal building renovation",
    summary: "Replace roofing and storefront systems",
    stage: "bidding",
    status: "Open",
    agency: "Example Agency",
    city: "Newark",
    state: "NJ",
    postedAt: "2026-07-20T00:00:00.000Z",
    bidDate: "2026-08-15T17:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    sourceName: "Official source",
    sourceUrl: "https://example.gov/bids/ROW-1",
    provenance: "live-api",
    confidence: "official",
    documents: [{
      name: "Plans",
      kind: "plans",
      url: "https://example.gov/bids/ROW-1/plans.pdf",
      access: "public",
    }],
    participants: [
      { name: "Example Owner LLC", role: "owner", participantType: "organization" },
      { name: "Example Construction Corp", role: "contractor", participantType: "organization" },
    ],
    ...overrides,
  };
}

const baseOptions = {
  keywords: [],
  match: "all",
  stage: "all",
  state: "all",
  freshness: "all",
  due: "all",
  readiness: "all",
  includeArchived: false,
};

test("lead filters separate partial evidence from the qualified bid queue", () => {
  const ready = project();
  const documentless = project({ documents: [] });
  const permit = project({
    stage: "permitting",
    bidDate: undefined,
    documents: [{
      name: "Permit row",
      kind: "permit",
      url: "https://example.gov/permits/ROW-1",
      access: "public",
    }],
    participants: [],
  });

  assert.equal(projectMatchesLeadFilter(ready, "partial", NOW), false);
  assert.equal(projectMatchesLeadFilter(documentless, "partial", NOW), true);
  assert.equal(projectMatchesLeadFilter(documentless, "missing-documents", NOW), true);
  assert.equal(projectMatchesLeadFilter(permit, "early-stage", NOW), true);
  assert.equal(projectMatchesLeadFilter(permit, "missing-owner", NOW), true);
  assert.equal(projectMatchesLeadFilter(permit, "missing-contractor", NOW), true);
  assert.equal(projectMatchesLeadFilter(permit, "missing-deadline", NOW), true);
  assert.deepEqual(projectLeadReasons(permit, NOW), [
    "not-bidding",
    "missing-deadline",
    "missing-bid-documents",
    "missing-owner",
    "missing-contractor",
  ]);

  assert.equal(projectMatchesSearch(documentless, {
    ...baseOptions,
    leadFilter: "partial",
  }, NOW), true);
  assert.equal(projectMatchesSearch(ready, {
    ...baseOptions,
    leadFilter: "partial",
  }, NOW), false);
});

test("persisted lead filters compile before paging and counting", () => {
  const partial = projectFilterSql({ ...baseOptions, leadFilter: "partial" }, NOW);
  assert.match(partial.sql, /NOT \(\(p\.stage = 'bidding'/);
  assert.match(partial.sql, /bid_ready_d/);
  assert.ok(partial.bindings.length > 0);

  assert.match(
    projectFilterSql({ ...baseOptions, leadFilter: "missing-owner" }, NOW).sql,
    /project_participants lead_owner[\s\S]*lead_owner\.role='owner'/,
  );
  assert.match(
    projectFilterSql({ ...baseOptions, leadFilter: "missing-contractor" }, NOW).sql,
    /project_participants lead_contractor[\s\S]*lead_contractor\.role='contractor'/,
  );
  assert.match(
    projectFilterSql({ ...baseOptions, leadFilter: "missing-documents" }, NOW).sql,
    /documents lead_document[\s\S]*official_document_ps/,
  );
  assert.match(
    projectFilterSql({ ...baseOptions, leadFilter: "missing-deadline" }, NOW).sql,
    /datetime\(p\.bid_date\) IS NULL/,
  );
  assert.match(
    projectFilterSql({ ...baseOptions, leadFilter: "early-stage" }, NOW).sql,
    /p\.stage IN \('planning', 'design', 'permitting'\)/,
  );
});

test("Project Leads is a server-submitted, shareable workspace with explicit pipeline gaps", async () => {
  const [page, styles, dashboard, queue, companies, monitor] = await Promise.all([
    readFile(new URL("../app/leads/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/leads/leads.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/DashboardClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/BidQueueClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/companies/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/source-monitor/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<form method="get" action="\/leads">/);
  assert.match(page, /queryConnectedProjects/);
  assert.match(page, /readiness:\s*"all"/);
  assert.match(page, /leadFilter/);
  assert.match(page, /Missing named owner/);
  assert.match(page, /Missing general contractor/);
  assert.match(page, /Missing bid documents/);
  assert.match(page, /Missing bid deadline/);
  assert.match(page, /Not loaded yet/);
  assert.match(page, /Source Monitor/);
  assert.match(page, /Audit source coverage/);
  assert.match(styles, /@media \(max-width: 600px\)/);
  for (const navigation of [dashboard, queue, companies, monitor]) {
    assert.match(navigation, /href="\/leads"/);
  }
});
