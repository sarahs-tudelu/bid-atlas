import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

register(new URL("./ts-extension-loader.mjs", import.meta.url));

const { isArchivedProjectStage } = await import("../app/lib/project-lifecycle.ts");
const {
  connectedProjectMergeWindow,
  mergeConnectedProjectPage,
} = await import("../app/lib/connected-project-pagination.ts");
const {
  calendarDayWindow,
  bidDateTimeZoneForSource,
  formatBidDeadline,
  sourceLocalDateTimeToIso,
} = await import("../app/lib/deadline-time.ts");

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: path.startsWith("/api") ? "application/json" : "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the focused BidAtlas qualified-bid queue", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>BidAtlas/);
  assert.match(html, /Projects you can actually bid\./i);
  assert.match(html, /Search open bids/i);
  assert.match(html, /Permits, expired bids, inferred leads, and documentless notices are excluded/i);
  assert.match(html, /not yet nationally complete/i);
  assert.doesNotMatch(html, /Find private homes|Find commercial projects|NATIONAL BUILDOUT LEDGER/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/);
});

test("search, Bid Desk, and coverage render as separate routed work areas", async () => {
  const [projectsResponse, bidDeskResponse, coverageResponse] = await Promise.all([
    render("/projects"),
    render("/bid-desk"),
    render("/coverage"),
  ]);
  assert.equal(projectsResponse.status, 200);
  assert.equal(bidDeskResponse.status, 200);
  assert.equal(coverageResponse.status, 200);

  const [projectsHtml, bidDeskHtml, coverageHtml] = await Promise.all([
    projectsResponse.text(),
    bidDeskResponse.text(),
    coverageResponse.text(),
  ]);
  assert.match(projectsHtml, /VERIFIED OPEN BIDS/i);
  assert.match(projectsHtml, /Projects you can actually bid\./i);
  assert.match(projectsHtml, /Search open bids/i);
  assert.match(projectsHtml, /Due today/i);
  assert.match(projectsHtml, /Next 14 days/i);
  assert.match(bidDeskHtml, /View plans\/drawings/i);
  assert.match(bidDeskHtml, /Files are pulled only when requested/i);
  assert.match(projectsHtml, /Per page/i);
  assert.doesNotMatch(projectsHtml, /Include completed\/cancelled|PROJECT \+ PRODUCT SEARCH/i);
  assert.doesNotMatch(projectsHtml, /NATIONAL BUILDOUT LEDGER/i);

  assert.match(bidDeskHtml, /Prepare this bid/i);
  assert.match(bidDeskHtml, /Workflow ·/i);
  assert.match(bidDeskHtml, /Contact research ·/i);
  assert.match(bidDeskHtml, /PROJECT DOCUMENTS/i);
  assert.match(bidDeskHtml, /connector not configured/i);
  assert.doesNotMatch(bidDeskHtml, /PROJECT \+ PRODUCT SEARCH/i);

  assert.match(coverageHtml, /National buildout ledger/i);
  assert.match(coverageHtml, /Federal Permitting Dashboard/);
  assert.match(coverageHtml, /Seattle building permits/);
  assert.match(coverageHtml, /Every registry jurisdiction gets its own coverage row/i);
  assert.doesNotMatch(coverageHtml, /Build the package\. Verify the recipient/i);
});

test("project route restores only focused search, location, and paging parameters", async () => {
  const response = await render(
    "/projects?keywords=trash%2C%20lighting&location=CA&stage=bidding&state=CA&match=all&freshness=current&includeArchived=1&page=1&limit=25",
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /value="trash, lighting"/);
  assert.match(html, /value="CA"/);
  assert.match(html, /"limit","25"/);
  assert.doesNotMatch(
    html,
    /Include completed\/cancelled|value="bidding"[^>]*selected|value="current"[^>]*selected/i,
  );
  assert.match(html, /qualified open bids/i);
});

test("project route restores a shareable bid-deadline shortcut", async () => {
  const response = await render("/projects?due=7-days");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<button[^>]*class="active"[^>]*aria-pressed="true"[^>]*>Next 7 days<\/button>/);
});

test("project route keeps freshness controls out of the primary bid queue", async () => {
  const response = await render("/projects?freshness=all");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /All open bids/);
  assert.doesNotMatch(html, />Freshness<|value="actionable"[^>]*selected/i);
});

test("terminal project parameters cannot populate the qualified open-bid queue", async () => {
  const [defaultResponse, explicitResponse] = await Promise.all([
    render("/projects?stage=completed"),
    render("/projects?stage=cancelled&freshness=actionable"),
  ]);
  const [defaultHtml, explicitHtml] = await Promise.all([
    defaultResponse.text(),
    explicitResponse.text(),
  ]);

  assert.match(defaultHtml, /0<!-- --> qualified open bids/);
  assert.match(explicitHtml, /0<!-- --> qualified open bids/);
  assert.doesNotMatch(defaultHtml, /value="completed"|Include completed\/cancelled/);
  assert.doesNotMatch(explicitHtml, /value="cancelled"|Include completed\/cancelled/);
});

test("sector quick links search only conservative normalized tags", async () => {
  const dashboard = await readFile(new URL("../app/DashboardClient.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /href="\/projects\?keywords=residential"/);
  assert.match(dashboard, /href="\/projects\?keywords=commercial"/);
  assert.doesNotMatch(dashboard, /keywords=residential%2C|keywords=commercial%2C/);
  assert.match(dashboard, /terminalStage \? "all" : freshness/);
  assert.match(dashboard, /nextIncludeArchived \? "all" : freshness/);
});

test("bounded live source windows mark search totals and navigation as partial", async () => {
  const { queryConnectedProjects } = await import("../app/lib/connected-project-search.ts");
  const sourceId = "boston-approved-building-permits-ckan";
  const project = {
    id: `${sourceId}:91`,
    sourceId,
    sourceRecordId: "91",
    title: "Boston fixture",
    summary: "ERT91 new construction",
    stage: "permitting",
    status: "Open",
    agency: "City of Boston",
    city: "Boston",
    state: "MA",
    postedAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    sourceName: "Boston approved building permits",
    sourceUrl: "https://data.boston.gov/dataset/approved-building-permits",
    provenance: "live-api",
    confidence: "official",
    documents: [],
    participants: [],
  };
  const result = await queryConnectedProjects(
    {
      generatedAt: "2026-07-16T12:00:00.000Z",
      projects: [project],
      sources: [{
        id: sourceId,
        name: "Boston approved building permits",
        owner: "City of Boston",
        level: "local",
        sourceClass: "permits",
        stages: ["permitting"],
        status: "live",
        access: "open",
        cadence: "Daily",
        recordCount: 656870,
        loadedCount: 1,
        snapshotComplete: false,
        lastChecked: "2026-07-16T12:00:00.000Z",
        url: "https://data.boston.gov/dataset/approved-building-permits",
        jurisdiction: "Boston, Massachusetts",
        note: "Local source",
      }],
      warnings: [],
    },
    {
      keywords: [],
      match: "all",
      stage: "all",
      state: "MA",
      freshness: "all",
      due: "all",
    },
    1,
    10,
  );
  assert.equal(result.meta.resultLimitReached, true);
  assert.equal(result.meta.sourceReportedMatches, undefined);
  assert.deepEqual(result.sourceSearches, [{
    sourceId,
    sourceReportedMatches: undefined,
    searchedSourceRecords: 1,
  }]);
  assert.match(result.warnings.join(" "), /partial source windows.*1 loaded of 656,870 reported/i);

  const dashboard = await readFile(new URL("../app/DashboardClient.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /Last loaded/);
  assert.match(dashboard, /loaded project matches/);
  assert.match(dashboard, /partial source windows/);
  assert.match(dashboard, /Publishing agency only — no direct contact/);
  assert.match(dashboard, /Named project participants — no direct contact/);
  assert.match(dashboard, /activeSearch\.freshness !== "actionable"/);
});

test("deadline shortcuts use source-local calendar windows and bound persisted range values", async () => {
  const [searchSource, repository, dashboard, bidDesk] = await Promise.all([
    readFile(new URL("../app/lib/search.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/search-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/DashboardClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/BidDesk.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(searchSource, /calendarDayWindow\(dayCount, now, timeZone\)/);
  assert.match(searchSource, /due === "today" \? 1 : due === "7-days" \? 7 : 14/);
  assert.match(searchSource, /bidTimestamp >= Date\.parse\(window\.start\)/);
  assert.match(searchSource, /bidTimestamp < Date\.parse\(window\.end\)/);
  assert.match(searchSource, /project\.bidDateTimeZone/);
  assert.match(repository, /datetime\(p\.bid_date\) IS NOT NULL/);
  assert.match(repository, /datetime\(p\.bid_date\) >= datetime\(\?\)/);
  assert.match(repository, /datetime\(p\.bid_date\) < datetime\(\?\)/);
  assert.match(repository, /sourceBidDateTimeZones\(\)/);
  assert.match(repository, /deadline_ps\.source_id = \?/);
  assert.match(repository, /CASE WHEN p\.stage = 'bidding' THEN datetime\(p\.bid_date\) END ASC/);
  assert.match(dashboard, /formatBidDeadline\(project\.bidDate, project\.bidDateTimeZone\)/);
  assert.match(bidDesk, /formatBidDeadline\(selectedProject\.bidDate, selectedProject\.bidDateTimeZone\)/);
});

test("NYC floating bid cutoffs preserve Eastern wall time and DST provenance", () => {
  assert.equal(
    sourceLocalDateTimeToIso("2026-01-15T10:00:00.000", "America/New_York"),
    "2026-01-15T15:00:00.000Z",
  );
  assert.equal(
    sourceLocalDateTimeToIso("2026-07-15T10:00:00.000", "America/New_York"),
    "2026-07-15T14:00:00.000Z",
  );
  assert.equal(
    formatBidDeadline("2026-07-15T14:00:00.000Z", "America/New_York"),
    "Jul 15, 2026, 10:00 AM EDT",
  );
  assert.equal(
    formatBidDeadline("2026-08-05T00:00:00.000Z", "America/Chicago"),
    "Aug 5, 2026 - time not published",
  );
  assert.equal(
    sourceLocalDateTimeToIso("2026-03-08T02:30:00.000", "America/New_York"),
    undefined,
    "a nonexistent spring-forward wall time must not be silently shifted",
  );
});

test("Michigan persisted deadlines retain Detroit calendar-day provenance", () => {
  assert.equal(
    bidDateTimeZoneForSource("michigan-dot-bid-lettings"),
    "America/Detroit",
  );
  assert.equal(
    sourceLocalDateTimeToIso("2026-07-24T10:30:00", "America/Detroit"),
    "2026-07-24T14:30:00.000Z",
  );
  assert.deepEqual(
    calendarDayWindow(1, new Date("2026-07-21T02:00:00.000Z"), "America/Detroit"),
    {
      start: "2026-07-20T04:00:00.000Z",
      end: "2026-07-21T04:00:00.000Z",
    },
  );
});

test("persisted TxDOT deadlines retain Central-time provenance", () => {
  assert.equal(
    bidDateTimeZoneForSource("texas-dot-state-let-construction"),
    "America/Chicago",
  );
});

test("deadline day windows follow the source calendar across UTC midnight and DST", () => {
  assert.deepEqual(
    calendarDayWindow(1, new Date("2026-07-16T02:00:00.000Z"), "America/New_York"),
    {
      start: "2026-07-15T04:00:00.000Z",
      end: "2026-07-16T04:00:00.000Z",
    },
  );
  assert.deepEqual(
    calendarDayWindow(1, new Date("2026-03-08T12:00:00.000Z"), "America/New_York"),
    {
      start: "2026-03-08T05:00:00.000Z",
      end: "2026-03-09T04:00:00.000Z",
    },
  );
});

test("project API returns source-proven records and explicit source health", async () => {
  const response = await render("/api/projects");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.projects));
  assert.ok(Array.isArray(body.sources));
  assert.ok(body.sources.length >= 8);
  const censusSource = body.sources.find((source) => source.id === "census-government-units");
  assert.ok(censusSource);
  assert.equal(censusSource.recordCount, 97241);
  assert.equal(censusSource.loadedCount, 0);
  assert.equal(censusSource.snapshotComplete, false);
  assert.ok(body.sources.some((source) => source.id === "sam-contract-opportunities"));
  assert.ok(body.sources.some((source) => source.id === "seattle-building-permits"));
  assert.equal(body.coverage.nationallyComplete, false);
  assert.equal(body.coverage.localGovernmentUniverse, 91438);
  assert.equal(body.coverage.states.length, 51);
  for (const project of body.projects) {
    assert.ok(project.sourceId);
    assert.ok(project.sourceRecordId);
    assert.ok(project.sourceUrl);
    assert.ok(Array.isArray(project.documents));
  }
});

test("source registry exposes official procurement and DOT discovery roots for all states and DC", async () => {
  const response = await render("/api/source-registry");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.nationallyComplete, false);
  assert.equal(body.sources.length, 51);
  assert.equal(new Set(body.sources.map((source) => source.code)).size, 51);
  for (const source of body.sources) {
    assert.match(source.procurementUrl, /^https:\/\//);
    assert.match(source.transportationUrl, /^https:\/\//);
  }
});

test("state coverage follows current connector scope and health", async () => {
  const coverage = await readFile(
    new URL("../app/lib/national-coverage.ts", import.meta.url),
    "utf8",
  );
  assert.match(coverage, /if \(source\.status === "credential-required"\) return "credential-required"/);
  assert.match(coverage, /if \(source\.status !== "live"\) return "identified"/);
  assert.match(
    coverage,
    /function sourceCoverageState\([^)]*\): CoverageState \{[\s\S]*?return "partial";\s*\}/,
  );
  assert.doesNotMatch(coverage, /source\.level === "state"\s*\?\s*"connected"/);
  assert.doesNotMatch(coverage, /code === "(?:CA|IL|NY|TX)"/);

  const response = await render("/api/coverage");
  assert.equal(response.status, 200);
  const body = await response.json();
  const caltrans = body.sources.find(
    (source) => source.id === "caltrans-contracting-opportunities",
  );
  assert.equal(caltrans?.status, "live");
  assert.equal(caltrans?.level, "state");
  const california = body.coverage.states.find((state) => state.code === "CA");
  assert.equal(california?.dotBidding, "partial");
});

test("discovery leases active scans before untouched jobs and completed rechecks", async () => {
  const discovery = await readFile(
    new URL("../worker/jurisdiction-discovery.ts", import.meta.url),
    "utf8",
  );
  const match = discovery.match(
    /const DISCOVERY_JOB_LEASE_ORDER_SQL = `([\s\S]*?)`;/,
  );
  assert.ok(match, "expected the lease query to use one explicit fairness order");
  const order = match[1];

  assert.match(order, /WHEN status='complete' THEN 2/);
  assert.match(order, /WHEN status IN \('retry', 'running'\)[\s\S]*THEN 0/);
  assert.match(order, /attempt_count > 0/);
  assert.match(order, /completed_source_classes <> '\[\]'/);
  assert.match(order, /ELSE 1[\s\S]*END ASC/);
  assert.ok(
    order.indexOf("WHEN status='complete'") < order.indexOf("attempt_count > 0"),
    "completed jobs must stay in the recheck tier even though they have prior attempts",
  );
  assert.ok(
    order.indexOf("END ASC") < order.indexOf("priority DESC"),
    "fairness tier must outrank population priority",
  );
  assert.match(discovery, /ORDER BY \$\{DISCOVERY_JOB_LEASE_ORDER_SQL\}/);

  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE jurisdiction_discovery_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      completed_source_classes TEXT NOT NULL,
      current_source_class TEXT,
      cursor TEXT,
      attempt_count INTEGER NOT NULL,
      next_run_at TEXT NOT NULL
    )`);
    const insert = database.prepare(`INSERT INTO jurisdiction_discovery_jobs (
      id, status, priority, completed_source_classes, current_source_class,
      cursor, attempt_count, next_run_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run("completed-high", "complete", 100, '["planning"]', null, "{}", 9, "2020-01-01");
    insert.run("untouched-high", "queued", 100, "[]", null, null, 0, "2020-01-01");
    insert.run("continued-low", "queued", 0, '["planning"]', "permits", "{}", 1, "2025-01-01");
    insert.run("retry-medium", "retry", 20, "[]", "planning", "{}", 1, "2025-01-01");

    const ids = database
      .prepare(`SELECT id FROM jurisdiction_discovery_jobs ORDER BY ${order}`)
      .all()
      .map((row) => row.id);
    assert.deepEqual(ids, [
      "retry-medium",
      "continued-low",
      "untouched-high",
      "completed-high",
    ]);
  } finally {
    database.close();
  }
});

test("multi-keyword, location, and stage search returns only the requested stage", async () => {
  const response = await render("/api/search?keywords=building,permit&match=any&location=Seattle&state=WA&stage=permitting");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.meta.match, "any");
  assert.deepEqual(body.meta.terms, ["building", "permit"]);
  assert.equal(body.meta.nationallyComplete, false);
  assert.match(body.meta.notice, /active and queryable public-source records only/i);
  assert.ok(Array.isArray(body.projects));
  assert.ok(body.projects.length > 0);
  assert.ok(body.projects.every((project) => project.stage === "permitting"));
});

test("project search defaults to active stages while terminal stage selection opts in", async () => {
  const [
    activeResponse,
    allResponse,
    gatedCompletedResponse,
    gatedCancelledResponse,
    completedResponse,
    cancelledResponse,
    awardedResponse,
    constructionRouteResponse,
  ] = await Promise.all([
    render("/api/search?limit=50"),
    render("/api/search?includeArchived=1&limit=50"),
    render("/api/search?stage=completed&limit=50"),
    render("/api/search?stage=cancelled&limit=50"),
    render("/api/search?stage=completed&includeArchived=1&limit=50"),
    render("/api/search?stage=cancelled&includeArchived=1&limit=50"),
    render("/api/search?stage=awarded&limit=50"),
    render("/projects?stage=construction"),
  ]);

  for (const response of [
    activeResponse,
    allResponse,
    gatedCompletedResponse,
    gatedCancelledResponse,
    completedResponse,
    cancelledResponse,
    awardedResponse,
    constructionRouteResponse,
  ]) assert.equal(response.status, 200);

  const [active, all, gatedCompleted, gatedCancelled, completed, cancelled, awarded] =
    await Promise.all([
      activeResponse.json(),
      allResponse.json(),
      gatedCompletedResponse.json(),
      gatedCancelledResponse.json(),
      completedResponse.json(),
      cancelledResponse.json(),
      awardedResponse.json(),
    ]);
  const constructionHtml = await constructionRouteResponse.text();

  assert.equal(active.meta.includeArchived, false);
  assert.ok(active.projects.every((project) => !["completed", "cancelled"].includes(project.stage)));
  assert.equal(all.meta.includeArchived, true);
  assert.ok(all.meta.matchedProjects > active.meta.matchedProjects);
  assert.equal(gatedCompleted.meta.includeArchived, true);
  assert.equal(gatedCancelled.meta.includeArchived, true);
  assert.ok(gatedCompleted.meta.matchedProjects > 0);
  assert.ok(gatedCancelled.meta.matchedProjects > 0);
  assert.equal(gatedCompleted.meta.matchedProjects, completed.meta.matchedProjects);
  assert.equal(gatedCancelled.meta.matchedProjects, cancelled.meta.matchedProjects);
  assert.ok(completed.meta.matchedProjects > 0);
  assert.ok(completed.projects.every((project) => project.stage === "completed"));
  assert.ok(cancelled.meta.matchedProjects > 0);
  assert.ok(cancelled.projects.every((project) => project.stage === "cancelled"));
  assert.ok(awarded.meta.matchedProjects > 0);
  assert.ok(awarded.projects.every((project) => project.stage === "awarded"));
  assert.match(constructionHtml, /0<!-- --> qualified open bids/);
  assert.doesNotMatch(constructionHtml, /value="construction"|Project stage/);
});

test("only canonical completion or cancellation archives a project stage", () => {
  for (const stage of [
    "planning",
    "design",
    "permitting",
    "bidding",
    "bid-opened",
    "awarded",
    "construction",
    "unclassified",
  ]) assert.equal(isArchivedProjectStage(stage), false, `${stage} must remain actionable`);
  assert.equal(isArchivedProjectStage("completed"), true);
  assert.equal(isArchivedProjectStage("cancelled"), true);
});

test("mixed persisted and live bids are globally ordered before pagination", () => {
  const project = (id, bidDate, updatedAt = "2026-07-16T12:00:00.000Z") => ({
    id,
    sourceId: id.startsWith("live") ? "live-source" : "persisted-source",
    sourceRecordId: id,
    title: id,
    summary: id,
    stage: "bidding",
    status: "open",
    agency: "Test agency",
    bidDate,
    updatedAt,
    sourceName: "Test source",
    sourceUrl: `https://example.test/${id}`,
    provenance: "live-api",
    confidence: "official",
    documents: [],
    participants: [],
  });
  const persisted = [
    project("persisted-1", "2026-07-18T12:00:00.000Z"),
    project("persisted-2", "2026-07-20T12:00:00.000Z"),
    project("persisted-3", "2026-07-22T12:00:00.000Z"),
  ];
  const live = [project("live-urgent", "2026-07-17T12:00:00.000Z")];

  const firstWindow = connectedProjectMergeWindow(0, 2, live.length);
  const firstPage = mergeConnectedProjectPage(
    persisted.slice(firstWindow.offset, firstWindow.offset + firstWindow.limit),
    live,
    0,
    firstWindow.offset,
    2,
  );
  assert.deepEqual(firstPage.map(({ id }) => id), ["live-urgent", "persisted-1"]);

  const secondWindow = connectedProjectMergeWindow(2, 2, live.length);
  assert.deepEqual(secondWindow, { offset: 1, limit: 3 });
  const secondPage = mergeConnectedProjectPage(
    persisted.slice(secondWindow.offset, secondWindow.offset + secondWindow.limit),
    live,
    2,
    secondWindow.offset,
    2,
  );
  assert.deepEqual(secondPage.map(({ id }) => id), ["persisted-2", "persisted-3"]);
  assert.equal(new Set([...firstPage, ...secondPage].map(({ id }) => id)).size, 4);
});

test("project search paginates the full result set with normalized page metadata", async () => {
  const [
    defaultResponse,
    secondPageResponse,
    limit25Response,
    limit50Response,
    invalidResponse,
    infiniteLimitResponse,
  ] =
    await Promise.all([
      render("/api/search"),
      render("/api/search?page=2&limit=10"),
      render("/api/search?page=1&limit=25"),
      render("/api/search?page=1&limit=50"),
      render("/api/search?page=Infinity&limit=invalid"),
      render("/api/search?page=invalid&limit=Infinity"),
    ]);

  for (const response of [
    defaultResponse,
    secondPageResponse,
    limit25Response,
    limit50Response,
    invalidResponse,
    infiniteLimitResponse,
  ]) {
    assert.equal(response.status, 200);
  }

  const [
    defaultBody,
    secondPageBody,
    limit25Body,
    limit50Body,
    invalidBody,
    infiniteLimitBody,
  ] =
    await Promise.all([
      defaultResponse.json(),
      secondPageResponse.json(),
      limit25Response.json(),
      limit50Response.json(),
      invalidResponse.json(),
      infiniteLimitResponse.json(),
    ]);

  for (const body of [
    defaultBody,
    secondPageBody,
    limit25Body,
    limit50Body,
    invalidBody,
    infiniteLimitBody,
  ]) {
    assert.ok(Array.isArray(body.projects));
    assert.equal(body.projects.length, body.meta.returnedProjects);
    assert.ok(body.projects.length <= body.meta.pageSize);
    assert.ok(Number.isInteger(body.meta.matchedProjects));
    assert.ok(body.meta.matchedProjects >= body.meta.returnedProjects);
    assert.ok(Number.isInteger(body.meta.totalPages));
    assert.ok(body.meta.totalPages >= 1);
  }

  assert.equal(defaultBody.meta.page, 1);
  assert.equal(defaultBody.meta.pageSize, 10);
  assert.ok(defaultBody.projects.length <= 10);

  assert.equal(secondPageBody.meta.page, 2);
  assert.equal(secondPageBody.meta.pageSize, 10);
  assert.equal(secondPageBody.meta.matchedProjects, defaultBody.meta.matchedProjects);
  assert.equal(secondPageBody.meta.totalPages, defaultBody.meta.totalPages);

  if (defaultBody.meta.totalPages >= 2) {
    assert.ok(secondPageBody.projects.length > 0);
    const firstPageIds = new Set(defaultBody.projects.map((project) => project.id));
    assert.ok(
      secondPageBody.projects.every((project) => !firstPageIds.has(project.id)),
      "project IDs must not repeat across adjacent pages",
    );
  } else {
    assert.equal(secondPageBody.projects.length, 0);
  }

  assert.equal(limit25Body.meta.page, 1);
  assert.equal(limit25Body.meta.pageSize, 25);
  assert.ok(limit25Body.projects.length <= 25);
  assert.equal(limit50Body.meta.page, 1);
  assert.equal(limit50Body.meta.pageSize, 50);
  assert.ok(limit50Body.projects.length <= 50);

  assert.equal(invalidBody.meta.page, 1);
  assert.equal(invalidBody.meta.pageSize, 10);
  assert.ok(invalidBody.projects.length <= 10);
  assert.equal(infiniteLimitBody.meta.page, 1);
  assert.equal(infiniteLimitBody.meta.pageSize, 10);
  assert.ok(infiniteLimitBody.projects.length <= 10);
});

test("project search clamps an out-of-range page to the final materialized page", async () => {
  const response = await render("/api/search?page=1000000&limit=10");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.meta.page, body.meta.totalPages);
  if (body.meta.matchedProjects > 0) assert.ok(body.projects.length > 0);
});

test("persisted search uses request paging instead of a fixed result cap", async () => {
  const repository = await readFile(
    new URL("../db/search-repository.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(repository, /SEARCH_RESULT_LIMIT/);
  assert.match(repository, /LIMIT\s+\?/i);
  assert.match(repository, /OFFSET\s+\?/i);
  assert.match(repository, /json_each\(\?\)/);
  assert.match(repository, /excludeProjectIds/);
  const persistedSearchSection = repository.slice(
    repository.indexOf("export async function searchPersistedProjects"),
    repository.indexOf("export async function getPersistedInventorySnapshot"),
  );
  assert.ok(
    (persistedSearchSection.match(/NAVIGABLE_PROJECT_SQL/g) ?? []).length >= 6,
    "persisted search counts and pages must use the same openable-project universe",
  );
});

test("hosted dashboards use persisted inventory totals and hydrate Bid Desk deep links", async () => {
  const [
    apiResponse,
    repository,
    dashboardFeed,
    dashboardClient,
    projectsPage,
    bidDeskPage,
  ] = await Promise.all([
    render("/api/projects"),
    readFile(new URL("../db/search-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/dashboard-feed.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/DashboardClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/projects/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/bid-desk/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.equal(apiResponse.status, 200);
  const apiBody = await apiResponse.json();
  assert.ok(apiBody.inventory);
  assert.equal(typeof apiBody.inventory.totalProjects, "number");
  assert.equal(typeof apiBody.inventory.contractorOrganizations, "number");
  assert.deepEqual(
    Object.keys(apiBody.inventory.stageCounts).sort(),
    [
      "awarded",
      "bid-opened",
      "bidding",
      "cancelled",
      "completed",
      "construction",
      "design",
      "permitting",
      "planning",
      "unclassified",
    ],
  );

  assert.match(repository, /export async function getPersistedInventorySnapshot/);
  assert.match(repository, /sum\(CASE WHEN p\.stage='bidding'/i);
  assert.match(repository, /GROUP BY lower\(trim\(p\.state\)\)/i);
  assert.match(repository, /stateCounts:\s*groupedStateCounts\(stateRows\)/);
  assert.match(repository, /count\(DISTINCT pp\.organization_id\)/i);
  assert.match(repository, /export async function getPersistedProjectById/);
  assert.match(repository, /hydrateProjects\(db, \[normalizedId\]/);
  assert.match(dashboardFeed, /existingCandidateIds/);
  assert.match(dashboardFeed, /loadedProjectRecords:\s*inventory\.totalProjects/);
  assert.match(dashboardFeed, /loadedProjects:\s*inventory\.stateCounts\[state\.code\]/);
  assert.match(dashboardClient, /feed\.inventory\?\.stageCounts/);
  assert.match(dashboardClient, /feed\.inventory\?\.contractorOrganizations/);
  assert.match(dashboardClient, /activeLoadedProjects/);
  assert.match(projectsPage, /queryConnectedProjects/);
  assert.match(projectsPage, /initialSearchPage=/);
  assert.match(bidDeskPage, /getPersistedProjectById\(initialProjectId\)/);
  assert.match(bidDeskPage, /key=\{initialProjectId \?\? "default"\}/);
});

test("Bid Desk resolves bounded standardized deep links and never substitutes an explicit project", async () => {
  const bidDeskPage = await readFile(
    new URL("../app/bid-desk/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(bidDeskPage, /"tempe-building-permits-arcgis:"/);
  assert.match(bidDeskPage, /"pittsburgh-pli-permits-ckan:"/);
  assert.match(bidDeskPage, /"miami-ibuild-plan-review-arcgis:"/);
  assert.match(
    bidDeskPage,
    /STANDARDIZED_PROJECT_PREFIXES\.some\(\(prefix\)\s*=>\s*initialProjectId\.startsWith\(prefix\)\)/,
  );
  assert.match(bidDeskPage, /lookupStandardizedProject\(initialProjectId\)/);
  assert.match(bidDeskPage, /exactStandardizedLookup\?\.project/);
  assert.match(
    bidDeskPage,
    /else if \(initialProjectId\) \{[\s\S]*?projects = \[\];/,
  );
  assert.match(
    bidDeskPage,
    /linkedProjectUnresolved\s*\?\s*undefined\s*:\s*initialProjectId/,
  );
  assert.match(bidDeskPage, /No alternate project was selected\./);
});

test("Bid Desk resolves live NYC City Record deep links with the bounded exact lookup", async () => {
  const bidDeskPage = await readFile(
    new URL("../app/bid-desk/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(bidDeskPage, /lookupNycCityRecordConstructionProject/);
  assert.match(
    bidDeskPage,
    /startsWith\("nyc-city-record-construction-procurement:"\)/,
  );
  assert.match(
    bidDeskPage,
    /lookupNycCityRecordConstructionProject\(initialProjectId\)/,
  );
  assert.match(bidDeskPage, /exactNycCityRecordLookup\?\.project/);
  assert.match(
    bidDeskPage,
    /Exact NYC City Record project lookup failed:/,
  );
});

test("project-source ingestion persists native upstream pages and resumes inside a page", async () => {
  const [connectors, connectedSearch, types, ingestion, readme, architecture, viteConfig] = await Promise.all([
    readFile(new URL("../app/lib/connectors.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/connected-project-search.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/ingestion.ts", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../ARCHITECTURE.md", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  ]);

  const sourceIdBlock = connectors.match(
    /export const PROJECT_SOURCE_IDS\s*=\s*\[([\s\S]*?)\]\s*as const/,
  )?.[1];
  assert.ok(sourceIdBlock, "PROJECT_SOURCE_IDS must remain an explicit durable source order");
  for (const sourceReference of [
    "permittingTemplate.id",
    "usaSpendingTemplate.id",
    "caltransTemplate.id",
    "seattlePermitTemplate.id",
    "cityTemplates.seattle.id",
    "cityTemplates.sanjose.id",
    "samTemplate.id",
    "...SOCRATA_CITY_SOURCE_IDS",
    "...STANDARDIZED_SOURCE_IDS",
  ]) {
    assert.match(sourceIdBlock, new RegExp(sourceReference.replaceAll(".", "\\.")));
  }

  assert.match(types, /interface SourceCursorRecord[\s\S]*offset:\s*number/);
  assert.match(types, /matchedRecords\?:\s*number/);
  assert.match(types, /lastRecordUniqueId\?:\s*string\s*\|\s*number/);
  assert.match(types, /lastRecordSortValue\?:\s*string\s*\|\s*number/);
  assert.match(types, /windowStart\?:\s*string/);
  assert.match(types, /windowEnd\?:\s*string/);
  assert.match(types, /currentCursor:\s*SourceCursorRecord/);
  assert.match(types, /sourcePages\?:\s*Record<string,\s*SourcePageRecord>/);
  assert.match(connectors, /sourceCursors\?:\s*Record<string,\s*SourceCursorRecord>/);
  assert.match(connectors, /options\.sourceCursors\?\.\[sourceId\]\s*\?\?\s*\{\s*offset:\s*0\s*\}/);
  assert.match(connectors, /sourcePages\[result\.value\.source\.id\]\s*=\s*result\.value\.page/);
  assert.match(
    connectors,
    /filter\(\(connector\)\s*=>\s*!options\.sourceId\s*\|\|\s*connector\.template\.id\s*===\s*options\.sourceId\)/,
  );
  assert.match(connectors, /function uniqueSourceIdentities\(/);
  assert.match(connectors, /function isPaginationToken\(/);
  assert.match(connectors, /source record is missing a stable identity/);
  assert.match(connectors, /duplicate source identity \$\{identity\} in one page/);

  const section = (startMarker, endMarker) => {
    const start = connectors.indexOf(startMarker);
    const end = connectors.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0, `missing connector section: ${startMarker}`);
    assert.ok(end > start, `missing connector boundary after: ${startMarker}`);
    return connectors.slice(start, end);
  };

  const permitting = section("async function fetchPermittingProjects", "async function fetchUsaSpendingAwards");
  assert.match(permitting, /"\$order":\s*refreshOrder\s*\?\s*"project_id DESC"\s*:\s*"project_id ASC"/);
  assert.match(permitting, /lastRecordUniqueId[\s\S]*project_id >/);
  assert.match(
    permitting,
    /const baseWhere = mode === "ingest"\s*\?\s*"project_canonical=true"\s*:\s*"project_canonical=true AND project_field_project_status not in/,
  );
  assert.match(permitting, /uniqueSourceIdentities\(\s*permittingTemplate\.name/);
  assert.doesNotMatch(permitting, /last_data_fetched/);
  assert.match(permitting, /updatedAt:\s*new Date\(0\)\.toISOString\(\)/);

  const caltrans = section("async function fetchCaltransProjects", "const SEATTLE_PERMIT_DATASET");
  assert.match(caltrans, /claimSourceIdentity\(\s*caltransTemplate\.name/);

  const seattlePermits = section("async function fetchSeattlePermits", "export interface SourceSearchResult");
  assert.match(
    seattlePermits,
    /const baseWhere = ingesting \? "" : SEATTLE_PERMIT_ACTIVE_WHERE/,
  );
  assert.match(seattlePermits, /const scopeLabel = ingesting \? "full-history" : "active"/);
  assert.match(seattlePermits, /refreshAfter[\s\S]*":updated_at ASC, permitnum ASC"/);
  assert.match(seattlePermits, /":updated_at DESC, permitnum ASC"/);
  assert.match(seattlePermits, /: "applieddate DESC, permitnum ASC"/);
  assert.match(seattlePermits, /:updated_at > '\$\{sourceLiteral\(cursorSort!\)\}'/);
  assert.match(seattlePermits, /refreshAfter:\s*true/);
  assert.match(seattlePermits, /row-update clock/);
  assert.match(seattlePermits, /lane === "backfill" && !page\.hasMore/);
  assert.doesNotMatch(seattlePermits, /SEATTLE_PERMIT_UNIVERSE_WHERE/);
  assert.match(seattlePermits, /uniqueSourceIdentities\(\s*seattlePermitTemplate\.name/);
  assert.match(
    connectors,
    /isoDate\(row\.completeddate \?\? row\.issueddate \?\? row\.applieddate\)/,
  );

  const seattleLookup = section(
    "export async function lookupSeattlePermitProject",
    "async function fetchSeattlePermits",
  );
  assert.match(seattleLookup, /projectPrefix = `\$\{seattlePermitTemplate\.id\}:`/);
  assert.match(seattleLookup, /"\$where": `permitnum = '\$\{sourceLiteral\(permitNumber\)\}'`/);
  assert.match(seattleLookup, /"\$limit": "2"/);
  assert.match(seattleLookup, /mapSeattlePermit/);

  const seattleSearch = section("export async function searchSeattlePermitSource", "const planningTerms");
  assert.match(seattleSearch, /uniqueSourceIdentities\(\s*seattlePermitTemplate\.name/);
  assert.match(seattleSearch, /const stageWhere = seattleSearchStageWhere\(options\.stage\)/);
  assert.match(seattleSearch, /"\$order": "applieddate DESC, permitnum ASC"/);
  assert.match(seattleSearch, /export function fetchSeattlePermitSearchUniverse/);
  assert.match(seattleSearch, /searchSeattlePermitSource\(SEATTLE_PERMIT_SEARCH_UNIVERSE, limit\)/);

  assert.match(connectedSearch, /import \{ fetchSeattlePermitSearchUniverse \} from "\.\/connectors"/);
  assert.match(
    connectedSearch,
    /const wantsSeattle = options\.state === "all" \|\| options\.state === "WA"/,
  );
  assert.match(connectedSearch, /wantsSeattle \? fetchSeattlePermitSearchUniverse\(1_000\)/);
  assert.match(
    connectedSearch,
    /const wantsNycCityRecord = options\.state === "all" \|\| options\.state === "NY"/,
  );
  assert.match(connectedSearch, /fetchNycCityRecordCurrentConstructionSolicitations\(\)/);
  assert.match(connectedSearch, /sourceQueryableRecordTotal \+= sourceSearch\.projects\.length/);
  assert.match(connectedSearch, /sourceQueryableRecordTotal \+= sourceSearch\.returnedProjects/);
  assert.doesNotMatch(connectedSearch, /searchSeattlePermitSource\(options/);

  const legistar = section("async function fetchLegistarCity", "function mmddyyyy");
  assert.match(legistar, /"\$orderby":\s*"MatterIntroDate desc,MatterId asc"/);
  assert.match(legistar, /"\$skip":\s*String\(offset\)/);
  assert.match(legistar, /uniqueSourceIdentities\(\s*template\.name/);
  assert.match(legistar, /sourceRecordId:\s*matterId/);
  assert.match(legistar, /matchedRecordsBeforePage = normalizedSourceOffset\(requestedCursor\.matchedRecords\)/);
  assert.match(legistar, /matchedRecords = matchedRecordsBeforePage \+ matchingRows\.length/);
  assert.match(legistar, /matchedRecords:\s*matchedRecordsBeforePage/);
  assert.match(legistar, /\{ offset: offset \+ rows\.length, matchedRecords, windowStart, windowEnd \}/);
  assert.match(legistar, /sourceNow\([\s\S]*"live",[\s\S]*matchedRecords,/);

  const usaSpending = section("async function fetchUsaSpendingAwards", "function extractCell");
  assert.match(usaSpending, /page_metadata\?:\s*\{[\s\S]*hasNext\?:\s*boolean/);
  assert.match(usaSpending, /payload\.last_record_unique_id\s*=\s*requestedCursor\.lastRecordUniqueId/);
  assert.match(usaSpending, /payload\.last_record_sort_value\s*=\s*requestedCursor\.lastRecordSortValue/);
  assert.match(usaSpending, /hasRequestedUniqueId !== hasRequestedSortValue/);
  assert.match(usaSpending, /offset > 0 && !hasRequestedUniqueId/);
  assert.match(usaSpending, /continuation cursor must contain a positive page and both pagination tokens/);
  assert.match(usaSpending, /lastRecordUniqueId:\s*nextRecordUniqueId/);
  assert.match(usaSpending, /lastRecordSortValue:\s*nextRecordSortValue/);
  assert.match(usaSpending, /windowStart,[\s\S]*windowEnd/);
  assert.match(usaSpending, /const hasMore = pageMetadata\.hasNext/);
  assert.match(usaSpending, /hasMore &&[\s\S]*resultRows\.length === 0[\s\S]*isPaginationToken\(nextRecordUniqueId\)/);
  assert.match(usaSpending, /resultRows\.length < limit/);
  assert.doesNotMatch(usaSpending, /recordsBeforePage|recordsThroughPage/);
  assert.doesNotMatch(usaSpending, /continuation page was empty|contradicts the reported contract count/);
  assert.match(usaSpending, /uniqueSourceIdentities\(\s*usaSpendingTemplate\.name/);
  assert.match(usaSpending, /resultRows\.map\(\(row\)\s*=>\s*row\.generated_internal_id\)/);
  assert.match(usaSpending, /sourceRecordId:\s*internalId/);
  assert.doesNotMatch(usaSpending, /\?\?\s*"unknown"/);

  const sam = section("async function fetchSamOpportunities", "async function buildProjectFeed");
  assert.match(sam, /offset:\s*String\(offset\)/);
  assert.match(sam, /const hasMore = opportunityRows\.length === limit/);
  assert.match(sam, /nextOffset:\s*hasMore\s*\?\s*offset \+ 1\s*:\s*0/);
  assert.match(sam, /nextCursor:\s*hasMore[\s\S]*offset:\s*offset \+ 1,[\s\S]*windowStart,[\s\S]*windowEnd/);
  assert.match(sam, /\["p", "o", "k", "r", "a", "s", "i", "u"\]/);
  assert.match(sam, /const noticeIds = response\.noticeIds/);
  assert.match(connectors, /uniqueSourceIdentities\(\s*samTemplate\.name/);
  assert.match(connectors, /data\.opportunitiesData\.map\(\(row\)\s*=>\s*row\.noticeId\)/);
  assert.doesNotMatch(sam, /recordsBeforePage|recordsThroughPage/);
  assert.doesNotMatch(sam, /page contents contradict the reported totalRecords value/);
  assert.doesNotMatch(sam, /\?\?\s*"unknown"/);
  assert.match(connectors, /const ANONYMOUS_VIEW_FEED_TTL_MS = 5 \* 60 \* 1_000/);
  assert.match(connectors, /anonymousViewFeedCache\.expiresAt > now/);
  assert.match(connectors, /!options\.sourceId[\s\S]*!options\.samApiKey[\s\S]*!options\.sourceCursors/);

  const settledHandling = section("settled.forEach", "const stageRank");
  const rejectedHandling = settledHandling.slice(settledHandling.indexOf("const template"));
  assert.doesNotMatch(
    rejectedHandling,
    /sourcePages\[/,
    "a rejected page must not publish a replacement cursor",
  );

  const failedSourceStart = ingestion.indexOf("} else if (!selectedPage && !nextDeferredProject)");
  const failedSourceEnd = ingestion.indexOf("} else {", failedSourceStart + 1);
  assert.ok(failedSourceStart >= 0 && failedSourceEnd > failedSourceStart);
  const failedSourceBlock = ingestion.slice(failedSourceStart, failedSourceEnd);
  assert.doesNotMatch(
    failedSourceBlock,
    /nextSourceCursors\[selectedSourceId\]\s*=/,
    "a rejected upstream page must leave its durable source cursor unchanged",
  );
  assert.doesNotMatch(
    failedSourceBlock,
    /nextRefreshCursors\s*=|nextRefreshPhases\s*=|nextActiveLane\s*=\s*"refresh"/,
    "a rejected refresh page must preserve its per-source continuation without pinning the lane",
  );
  assert.match(
    ingestion,
    /else if \(!selectedPage && !nextDeferredProject\)[\s\S]*failedRefreshPageTransition\([\s\S]*nextRefreshSourceIndex\s*=\s*transition\.refreshSourceIndex/,
  );

  assert.match(
    ingestion,
    /interface IngestionCursorState\s*\{[\s\S]*pageProjectOffset:\s*number;[\s\S]*pageProjectId\?:\s*string;[\s\S]*pageProcessedProjectIds:\s*string\[\];[\s\S]*deferredProject\?:\s*ProjectRecord;[\s\S]*projectDocumentOffset:\s*number;[\s\S]*sourceIndex:\s*number;[\s\S]*sourceCursors:/,
  );
  assert.match(ingestion, /const processedProjectIds = new Set\(cursorState\.pageProcessedProjectIds\)/);
  assert.match(ingestion, /processedProjectIds\.has\(project\.id\)/);
  assert.match(ingestion, /nextDeferredProject\s*=\s*project/);
  assert.match(connectors, /if \(mode === "view"\)\s*\{[\s\S]*projects\.sort/);
  assert.match(ingestion, /selectedSourceId\s*=\s*PROJECT_SOURCE_IDS\[sourceIndex\]/);
  assert.match(
    ingestion,
    /getProjectFeed\(\{[\s\S]*mode:\s*"ingest"[\s\S]*sourceId:\s*selectedSourceId[\s\S]*\[selectedSourceId\]:\s*selectedSourceCursor[\s\S]*\}\)/,
  );
  assert.match(ingestion, /backfillRunsSinceRefresh\s*>=\s*2[\s\S]*\?\s*"refresh"/);
  assert.match(viteConfig, /crons:\s*\["\*\/5 \* \* \* \*"\]/);
  assert.match(ingestion, /ingestionLane === "refresh"[\s\S]*cursorState\.refreshCursors/);
  assert.match(ingestion, /refreshPhases:\s*Record<string, RefreshPhase>/);
  assert.match(ingestion, /selectedPage\s*=\s*feed\.sourcePages\?\.\[selectedSourceId\]/);
  assert.match(
    ingestion,
    /pendingProjects:[\s\S]*feed\.projects\.flatMap\(\(project, index\)[\s\S]*processedProjectIds\.has\(project\.id\)/,
  );
  assert.match(
    ingestion,
    /function parsedSourceCursor[\s\S]*cursor\.matchedRecords = cursorNumber\(record\.matchedRecords\)/,
  );
  assert.match(ingestion, /project\.documents\.slice\(\s*documentOffset,\s*documentOffset \+ documentSlots/);
  assert.match(ingestion, /nextProjectDocumentOffset\s*=\s*consumedDocumentOffset/);
  assert.match(
    ingestion,
    /if \(selectedPage && pageProjectsComplete\)\s*\{[\s\S]*nextSourceCursors\[selectedSourceId\]\s*=\s*selectedPage\.nextCursor;[\s\S]*nextSourceIndex\s*=\s*\(sourceIndex \+ 1\) % PROJECT_SOURCE_IDS\.length/,
  );
  assert.match(
    ingestion,
    /else if \(selectedPage\)\s*\{[\s\S]*nextSourceCursors\[selectedSourceId\]\s*=\s*selectedPage\.currentCursor/,
  );
  assert.match(
    ingestion,
    /completedRefreshPageTransition\(\{[\s\S]*phase:\s*selectedRefreshPhase[\s\S]*nextRefreshCursors\s*=\s*transition\.refreshCursors[\s\S]*nextRefreshPhases\s*=\s*transition\.refreshPhases/,
  );
  assert.match(
    ingestion,
    /else if \(selectedPage\)[\s\S]*nextActiveRefreshPhase\s*=\s*selectedRefreshPhase[\s\S]*nextActiveRefreshCursor\s*=\s*selectedPage\.currentCursor/,
  );
  assert.match(ingestion, /releaseCursor\s*=\s*nextCursorState/);
  assert.match(ingestion, /INSERT INTO coverage_evidence/);
  assert.match(ingestion, /ON CONFLICT\(jurisdiction_id, source_class, lifecycle_stage, source_id\)/);
  assert.match(ingestion, /VALUES \(\?, \?, \?, \?, \?, 'partial'/);
  assert.match(ingestion, /occurrence evidence, not proof of complete jurisdiction coverage/);
  assert.match(ingestion, /Aggregate state derived from per-source coverage evidence/);
  assert.match(ingestion, /if \(cursor && Number\(result\.meta\.changes \?\? 0\) !== 1\)/);
  assert.match(ingestion, /document_versions\.retrieval_status IN \([\s\S]*'metadata-only'[\s\S]*'account-gated'[\s\S]*'not-public'/);

  assert.match(readme, /one bounded upstream page/i);
  assert.match(readme, /persists? that source's next cursor only after the page has been fully materialized/i);
  assert.match(architecture, /one source page per run/i);
  assert.match(architecture, /upstream cursor does not advance/i);
  assert.match(architecture, /not national completeness/i);
});

test("persistence schema covers provenance, lifecycle events, participants, documents, and gaps", async () => {
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  for (const table of [
    "sources",
    "projects",
    "project_sources",
    "organizations",
    "project_participants",
    "documents",
    "project_events",
    "ingestion_runs",
    "coverage_ledger",
    "jurisdictions",
    "coverage_cells",
    "coverage_evidence",
    "project_jurisdictions",
    "jurisdiction_discovery_jobs",
    "jurisdiction_metrics",
    "dataset_candidate_jurisdictions",
    "document_versions",
    "document_extractions",
    "document_chunks",
    "dataset_candidates",
    "supplier_profiles",
    "portal_accounts",
    "portal_registration_tasks",
    "contacts",
    "project_contacts",
    "saved_searches",
    "bid_opportunities",
    "bid_packages",
    "bid_line_items",
    "bid_package_attachments",
    "bid_recipients",
    "bid_submissions",
    "enrichment_requests",
    "outreach_suppressions",
    "bid_activity_events",
  ]) {
    assert.match(schema, new RegExp(`"${table}"`));
  }

  const migration = await readFile(new URL("../drizzle/0001_sharp_toro.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE VIRTUAL TABLE `project_fts` USING fts5/);
  assert.match(migration, /CREATE VIRTUAL TABLE `document_chunk_fts` USING fts5/);
});

test("city seed audit preserves all supplied rows and exposes honest paginated fallback coverage", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../data/city-seeds-2025.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.recordCount, 19482);
  assert.equal(manifest.states.length, 50);
  assert.equal(manifest.districtOfColumbiaIncluded, false);
  assert.equal(manifest.ambiguousWithinStateNames.length, 11);

  const response = await render("/api/jurisdictions?state=AL&page=2&limit=10");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.query.page, 2);
  assert.equal(body.query.limit, 10);
  assert.equal(body.jurisdictions.length, 10);
  assert.equal(body.registry.incorporatedPlaceSeeds, 19482);
  for (const row of body.jurisdictions) {
    assert.equal(row.state, "AL");
    assert.equal(row.connectionState, "not-connected");
    assert.equal(row.loadedProjects, 0);
  }

  const allResponse = await render("/api/jurisdictions?state=all&page=1&limit=invalid");
  assert.equal(allResponse.status, 200);
  const allBody = await allResponse.json();
  assert.equal(allBody.query.state, undefined);
  assert.equal(allBody.query.limit, 10);
  assert.equal(allBody.total, 19483);
});

test("optional enrichment reports capabilities without exposing secrets or enabling delivery", async () => {
  const response = await render("/api/integrations");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.apolloConfigured, "boolean");
  assert.equal(body.outboundDeliveryConfigured, false);
  assert.deepEqual(Object.keys(body).sort(), [
    "apolloConfigured",
    "outboundDeliveryConfigured",
    "planContactExtraction",
  ]);
  assert.equal(body.planContactExtraction.enabled, false);
  assert.equal(body.planContactExtraction.parserReady, true);

  const adapter = await readFile(
    new URL("../app/lib/contact-enrichment.ts", import.meta.url),
    "utf8",
  );
  assert.match(adapter, /reveal_personal_emails.*false/s);
  assert.match(adapter, /reveal_phone_number.*false/s);
  assert.match(adapter, /body:\s*JSON\.stringify\(requestPayload\)/);
  assert.match(adapter, /confirmCreditUse/);

  const route = await readFile(
    new URL("../app/api/integrations/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /APOLLO_ENRICHMENT_ENABLED\s*!==\s*"true"/);
});

test("scheduled ingestion, protected triggering, Census import, and portal onboarding are wired", async () => {
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const ingestion = await readFile(new URL("../worker/ingestion.ts", import.meta.url), "utf8");
  const discovery = await readFile(
    new URL("../worker/jurisdiction-discovery.ts", import.meta.url),
    "utf8",
  );
  const importer = await readFile(
    new URL("../scripts/import-census-jurisdictions.mjs", import.meta.url),
    "utf8",
  );

  assert.match(worker, /async scheduled\s*\(/);
  assert.match(worker, /INGEST_TOKEN/);
  assert.match(worker, /Unauthorized/);
  assert.match(worker, /public-catalog-fallback/);
  assert.doesNotMatch(worker, /Add a production api\.data\.gov key before running automated discovery/);
  assert.match(ingestion, /REGISTRATION_FIELDS_REQUIRING_OWNER_CONFIRMATION/);
  assert.match(ingestion, /portal_registration_tasks/);
  assert.match(ingestion, /project_jurisdictions/);
  assert.match(ingestion, /jurisdiction_metrics/);
  assert.match(discovery, /async function recordSuccess\(\s*db: D1Database,\s*jobId: string,/);
  assert.match(discovery, /const status = await recordSuccess\(\s*env\.DB,\s*job\.id,/);
  assert.match(importer, /www2\.census\.gov\/programs-surveys\/gus\/datasets\/2025\/gov_units_2025\.zip/);
  assert.match(importer, /--upload/);
  assert.match(importer, /jurisdiction_discovery_jobs/);
  assert.match(discovery, /api\.gsa\.gov\/technology\/datagov\/v4\/search/);
  assert.match(discovery, /catalog\.data\.gov\/search/);
  assert.match(discovery, /permits:\s*"building permits"/);
  assert.match(discovery, /buildPublicCatalogUrl\(job, query, after\)/);
  assert.match(discovery, /catalogProvider:\s*page\.provider/);
  assert.doesNotMatch(discovery, /discovery was skipped before creating or leasing jobs/);
  assert.match(discovery, /dataset_candidate_jurisdictions/);
  assert.match(discovery, /'catalog-query-candidate',\s*0\.5/);
  assert.match(
    discovery,
    /dataset_candidate_jurisdictions\.verification_status='unverified'[\s\S]*ELSE dataset_candidate_jurisdictions\.match_method/,
  );
  assert.match(discovery, /DATA_GOV_API_KEY/);
});
