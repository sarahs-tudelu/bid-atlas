import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  assessProjectOutreach,
  buildProjectContactSheet,
  classifyProjectFreshness,
  contactSheetAsCsv,
  freshnessMatchesFilter,
  participantHasPublishedName,
  publishedParticipantName,
  rankProjectContactRoutes,
} = await import("../app/lib/outreach-intelligence.ts");

const NOW = "2026-07-16T12:00:00.000Z";

function project(overrides = {}) {
  return {
    id: "source:1",
    sourceId: "source",
    sourceRecordId: "1",
    title: "Canopy project",
    summary: "Public project",
    stage: "design",
    status: "Active",
    agency: "Example owner",
    postedAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    sourceName: "Official source",
    sourceUrl: "https://example.gov/project/1",
    provenance: "live-api",
    confidence: "official",
    documents: [],
    participants: [],
    ...overrides,
  };
}

test("freshness classifier separates new, current, stale, closed, inactive, and unclassified", () => {
  assert.equal(classifyProjectFreshness(project(), NOW).freshness, "new");
  assert.equal(
    classifyProjectFreshness(
      project({ postedAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-15T00:00:00.000Z" }),
      NOW,
    ).freshness,
    "current",
  );
  assert.equal(
    classifyProjectFreshness(
      project({ postedAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-02-01T00:00:00.000Z" }),
      NOW,
    ).freshness,
    "stale",
  );
  assert.equal(
    classifyProjectFreshness(project({ stage: "completed", status: "Complete" }), NOW).freshness,
    "closed",
  );
  assert.equal(
    classifyProjectFreshness(project({ stage: "cancelled", status: "Withdrawn" }), NOW).freshness,
    "inactive",
  );
  assert.equal(
    classifyProjectFreshness(
      project({ stage: "unclassified", status: "Unknown", postedAt: undefined, updatedAt: "invalid" }),
      NOW,
    ).freshness,
    "unclassified",
  );
  assert.equal(freshnessMatchesFilter("closed", "closed-or-inactive"), true);
  assert.equal(freshnessMatchesFilter("current", "closed-or-inactive"), false);
});

test("bounded status matching does not classify Incomplete as complete", () => {
  const assessment = classifyProjectFreshness(
    project({ status: "Incomplete design review", postedAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-15T00:00:00.000Z" }),
    NOW,
  );
  assert.equal(assessment.freshness, "current");
  assert.notEqual(assessment.buildStatus.confidence, "source-reported");
});

test("paused and on-hold records are inactive and epoch sentinels are not activity", () => {
  for (const status of ["Paused", "On hold", "Temporarily on-hold"]) {
    const assessment = assessProjectOutreach(project({ status }), NOW);
    assert.equal(assessment.freshness.freshness, "inactive");
    assert.equal(assessment.recommendation.action, "do-not-contact");
  }

  const epochOnly = classifyProjectFreshness(
    project({
      postedAt: undefined,
      updatedAt: "1970-01-01T00:00:00.000Z",
    }),
    NOW,
  );
  assert.equal(epochOnly.freshness, "unclassified");
  assert.match(epochOnly.label, /verify/i);
  assert.equal(epochOnly.latestActivityAt, undefined);
  assert.equal(epochOnly.ageDays, undefined);
});

test("actionable freshness includes dated new/current records and active post-bid stages", () => {
  assert.equal(freshnessMatchesFilter("new", "actionable"), true);
  assert.equal(freshnessMatchesFilter("current", "actionable"), true);
  for (const freshness of ["stale", "closed", "inactive", "unclassified"]) {
    assert.equal(freshnessMatchesFilter(freshness, "actionable"), false);
  }

  const undatedActive = classifyProjectFreshness(
    project({ postedAt: undefined, updatedAt: undefined, status: "Active" }),
    NOW,
  );
  assert.equal(undatedActive.freshness, "unclassified");
  assert.equal(freshnessMatchesFilter(undatedActive.freshness, "actionable"), false);

  for (const [stage, status] of [["bid-opened", "Bids opened"], ["awarded", "Awarded"]]) {
    const postBid = classifyProjectFreshness(
      project({ stage, status, bidDate: "2026-05-01T12:00:00.000Z" }),
      NOW,
    );
    assert.equal(postBid.freshness, "new", stage);
    assert.equal(freshnessMatchesFilter(postBid.freshness, "actionable"), true, stage);
  }
});

test("passed bid deadline overrides a recent update while a future deadline overrides old activity", () => {
  const passed = assessProjectOutreach(
    project({
      stage: "bidding",
      bidDate: "2026-05-01T12:00:00.000Z",
      updatedAt: "2026-07-16T08:00:00.000Z",
    }),
    NOW,
  );
  assert.equal(passed.freshness.freshness, "stale");
  assert.equal(passed.recommendation.action, "verify-first");

  const future = classifyProjectFreshness(
    project({
      stage: "bidding",
      bidDate: "2026-08-01T12:00:00.000Z",
      postedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-02-01T00:00:00.000Z",
    }),
    NOW,
  );
  assert.equal(future.freshness, "current");
  assert.match(future.reasons.join(" "), /future|bid date|2026-08-01/i);
});

test("contact sheet and routing use sourced names, mark every missing channel, and never invent a homeowner", () => {
  const record = project({
    stage: "bidding",
    participants: [
      { name: "Example Architects", role: "architect" },
      { name: "Example GC", role: "contractor" },
      { name: "=HYPERLINK(\"https://bad.example\")", role: "bidder" },
    ],
  });
  const sheet = buildProjectContactSheet(record);
  assert.equal(sheet.namedContacts, 3);
  assert.ok(sheet.missingRoles.includes("owner"));
  assert.ok(sheet.groups.flatMap((group) => group.contacts).every((contact) => contact.channels.length === 0));
  assert.match(sheet.notice, /No email, phone number, homeowner identity/i);

  const routes = rankProjectContactRoutes(record);
  assert.equal(routes[0].role, "bidder");
  assert.equal(routes[0].sourceNamed, true);
  assert.equal(routes[0].authorityStatus, "unverified");
  assert.equal(routes[0].channelStatus, "missing");
  assert.equal(routes[0].verifyBeforeOutreach, true);

  const csv = contactSheetAsCsv(sheet);
  assert.match(csv, /"'=HYPERLINK/);
  assert.doesNotMatch(csv, /owner@example|555-|homeowner name/i);
});

test("contact sheet and routing preserve literal channels from the official source", () => {
  const sourceUrl = "https://a856-cityrecord.nyc.gov/RequestDetail/20260313031";
  const record = project({
    stage: "bidding",
    participants: [
      {
        name: "Ping Zhi Chan",
        role: "agency",
        organization: "Environmental Protection",
        email: "pzchan@dep.nyc.gov",
        phone: "(718) 555-2410",
        sourceUrl,
      },
    ],
  });
  const sheet = buildProjectContactSheet(record);
  const contact = sheet.groups.flatMap((group) => group.contacts)[0];
  assert.deepEqual(contact.channels, [
    { kind: "email", value: "pzchan@dep.nyc.gov" },
    { kind: "phone", value: "(718) 555-2410" },
    { kind: "official portal", value: sourceUrl },
  ]);
  assert.deepEqual(contact.missingChannels, []);

  const route = rankProjectContactRoutes(record).find((candidate) => candidate.name === "Ping Zhi Chan");
  assert.equal(route.channelStatus, "published");
  assert.equal(route.email, "pzchan@dep.nyc.gov");
  assert.equal(route.phone, "(718) 555-2410");

  const csv = contactSheetAsCsv(sheet);
  assert.match(csv, /pzchan@dep\.nyc\.gov/);
  assert.match(csv, /\(718\) 555-2410/);
  assert.match(csv, /RequestDetail\/20260313031/);
});

test("channel-only evidence remains visible but is never called a named contact", async () => {
  const channelOnly = {
    name: "bids@example.gov",
    role: "agency",
    organization: "Example Agency",
    email: "bids@example.gov",
    phone: "(212) 555-0100",
    sourceUrl: "https://example.gov/opportunity/1",
  };
  const phoneOnly = {
    name: "212-555-0199",
    role: "agency",
    phone: "(212) 555-0199",
    sourceUrl: "https://example.gov/opportunity/1",
  };
  const record = project({ participants: [channelOnly, phoneOnly] });

  assert.equal(participantHasPublishedName(channelOnly), false);
  assert.equal(publishedParticipantName(phoneOnly), undefined);
  const sheet = buildProjectContactSheet(record);
  assert.equal(sheet.namedContacts, 0);
  assert.equal(sheet.groups.flatMap((group) => group.contacts).length, 2);
  assert.ok(
    sheet.groups.flatMap((group) => group.contacts).every(
      (contact) => contact.name === "Name not published" && contact.sourceNamed === false,
    ),
  );
  assert.match(sheet.notice, /Channel-only evidence.*not treated as a bid recipient/i);

  const routes = rankProjectContactRoutes(record).filter(
    (candidate) => candidate.role === "agency" && candidate.channelStatus === "published",
  );
  assert.equal(routes.length, 2);
  assert.ok(routes.every((route) => route.sourceNamed === false && route.name === undefined));
  assert.match(routes[0].reason, /does not identify a named person or organization/i);

  const bidDesk = await readFile(new URL("../app/BidDesk.tsx", import.meta.url), "utf8");
  assert.match(bidDesk, /project\.participants\s*\.filter\(participantHasPublishedName\)/);
});

test("persisted freshness SQL keeps bounded status terms and bid-date precedence guards", async () => {
  const repository = await readFile(
    new URL("../db/search-repository.ts", import.meta.url),
    "utf8",
  );
  assert.match(repository, /instr\('\s' \|\| \$\{normalizedStatusSql\} \|\| '\s', '\s\$\{token\}\s'\)/);
  assert.match(repository, /const newSignal = .*NOT \$\{passedBidSignal\}/);
  assert.match(repository, /const staleSignal = .*\$\{passedBidSignal\} OR/);
  assert.match(repository, /NOT \$\{futureBidSignal\}.*staleBefore/);
  assert.match(repository, /const currentSignal = .*\$\{futureBidSignal\} OR \$\{latestActivity\} IS NOT NULL/);
  assert.match(repository, /options\.freshness === "actionable".*newSignal.*currentSignal/);
  assert.match(repository, /const unclassifiedSignal = .*NOT \$\{currentSignal\}/);
  assert.match(repository, /1970-01-02T00:00:00\.000Z/);
});

test("Bid Desk approval includes an official-status freshness gate", async () => {
  const bidDesk = await readFile(new URL("../app/BidDesk.tsx", import.meta.url), "utf8");
  assert.match(bidDesk, /const officialStatusReady =/);
  assert.match(bidDesk, /officialStatusReady &&\s*checklistComplete/);
  assert.match(bidDesk, /<dt>Official status<\/dt>/);
  assert.match(bidDesk, /Revalidate the official project status before approval/);
});

test("user-facing dates suppress epoch sentinels and show coverage assessment time", async () => {
  const [dashboard, jurisdictionExplorer] = await Promise.all([
    readFile(new URL("../app/DashboardClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/JurisdictionExplorer.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /timestamp <= 86_400_000\) return "Not published"/);
  assert.match(jurisdictionExplorer, /metricsRefreshedAt\?: string \| null/);
  assert.match(jurisdictionExplorer, /assessmentLabel\(row\.metricsRefreshedAt\)/);
  assert.match(jurisdictionExplorer, /No assessment recorded/);
});

test("Bid Desk page attempts an exact Seattle lookup for linked source records", async () => {
  const page = await readFile(new URL("../app/bid-desk/page.tsx", import.meta.url), "utf8");
  assert.match(page, /lookupSeattlePermitProject/);
  assert.match(page, /startsWith\("seattle-building-permits:"\)/);
  assert.match(page, /mergeProjectRecords/);
});
