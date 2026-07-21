import assert from "node:assert/strict";
import test from "node:test";

const {
  OHIO_DOT_SOURCE_ID,
  OHIO_DOT_SOURCE_TEMPLATE,
  fetchOhioDotSource,
} = await import("../app/lib/ohio-dot-connector.ts");
const { completedRefreshPageTransition } = await import(
  "../worker/ingestion-pagination.ts"
);

const NOW = () => new Date("2026-07-20T16:00:00.000Z");

function attributes(pid, overrides = {}) {
  return {
    PID_NBR: pid,
    PROJECT_NME: `ODOT project ${pid}`,
    COUNTY_NME: "Franklin",
    COUNTY_NME_WORK_LOCATION: "FRANKLIN",
    DISTRICT_NBR: 6,
    PRIMARY_WORK_CATEGORY: "Bridge Preservation",
    FMIS_PROJ_DESC: null,
    CONTRACT_TYPE: "Standard Build",
    EST_TOTAL_CONSTR_COST: 5_500_000,
    PROJECT_MANAGER_NME: "MANAGER, MORGAN",
    PROJECT_ENGINEER_NME: "ENGINEER, ERIN",
    AREA_ENGINEER_NME: "AREA, ALEX",
    ENV_PROJECT_MANAGER_NME: "ENVIRONMENT, EVAN",
    DESIGN_AGENCY: "District 6 Engineering",
    SPONSORING_AGENCY: "Franklin County",
    PROJECT_PLANS_URL: `http://contracts.dot.state.oh.us/search.jsp?cabinetId=1002&PID_NUM=${pid}`,
    PROJECT_ADDENDA_URL: `http://contracts.dot.state.oh.us/search.jsp?cabinetId=1000&PID_NUM=${pid}`,
    PROJECT_PROPOSAL_URL: `http://contracts.dot.state.oh.us/search.jsp?cabinetId=1003&PID_NUM=${pid}`,
    AWARD_MILESTONE_DT: Date.parse("2026-09-08T00:00:00.000Z"),
    BEGIN_CONSTR_MILESTONE_DT: Date.parse("2026-10-01T00:00:00.000Z"),
    SOURCE_LAST_UPDATED: Date.parse("2026-07-20T00:00:00.000Z"),
    ...overrides,
  };
}

function documentRow({
  documentId,
  pid,
  projectNumber,
  letDate,
  addendum,
  projectType = "BRIDGE REPAIR",
  route = "IR 71-1.00",
}) {
  return `
    <input type="checkbox" name="documentId" value="${documentId}" />
    <span class="thumb-attribute-name">PID_NUM: </span>
    <span class="thumb-attribute-value">${pid}</span>
    <span class="thumb-attribute-name">PROJECT_NUM: </span>
    <span class="thumb-attribute-value"><span style="color:red">${projectNumber}</span></span>
    ${
      addendum
        ? `<span class="thumb-attribute-name">ADDENDA_NUM: </span>
           <span class="thumb-attribute-value">${addendum}</span>`
        : ""
    }
    <span class="thumb-attribute-name">COUNTY: </span>
    <span class="thumb-attribute-value">FRA</span>
    <span class="thumb-attribute-name">RT_SECTION: </span>
    <span class="thumb-attribute-value">${route}</span>
    <span class="thumb-attribute-name">PROJECT_TYPE: </span>
    <span class="thumb-attribute-value">${projectType}</span>
    <span class="thumb-attribute-name">LET_DATE: </span>
    <span class="thumb-attribute-value">${letDate}</span>`;
}

function documentPage(rows) {
  return `<html><body>
    <h1>Document Search Results [ ${rows.length} found ]</h1>
    ${rows.join("\n")}
  </body></html>`;
}

function fixtureFetch(handler) {
  const requests = [];
  let active = 0;
  let maximumActive = 0;
  const fetchImpl = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    requests.push(url.toString());
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return await handler(url);
    } finally {
      active -= 1;
    }
  };
  fetchImpl.requests = requests;
  fetchImpl.maximumActive = () => maximumActive;
  return fetchImpl;
}

test("Ohio DOT deduplicates map geometry, validates matching current plans and proposals, and excludes stale rebid files", async () => {
  const pointRows = [attributes(100)];
  const lineRows = [
    attributes(100, { COUNTY_NME_WORK_LOCATION: "FRANKLIN, DELAWARE" }),
    attributes(200),
    attributes(300),
  ];
  const pages = new Map([
    [
      "1002",
      documentPage([
        documentRow({
          documentId: "7001",
          pid: 100,
          projectNumber: "250001",
          letDate: "04/23/2026",
        }),
        documentRow({
          documentId: "7101",
          pid: 100,
          projectNumber: "260001",
          letDate: "08/27/2026",
        }),
        documentRow({
          documentId: "7301",
          pid: 300,
          projectNumber: "260003",
          letDate: "08/27/2026",
        }),
      ]),
    ],
    [
      "1003",
      documentPage([
        documentRow({
          documentId: "8001",
          pid: 100,
          projectNumber: "250001",
          letDate: "04/23/2026",
        }),
        documentRow({
          documentId: "8101",
          pid: 100,
          projectNumber: "260001",
          letDate: "08/27/2026",
        }),
      ]),
    ],
    [
      "1000",
      documentPage([
        documentRow({
          documentId: "9001",
          pid: 100,
          projectNumber: "250001",
          letDate: "04/23/2026",
          addendum: "a",
        }),
        documentRow({
          documentId: "9101",
          pid: 100,
          projectNumber: "260001",
          letDate: "08/27/2026",
          addendum: "b",
        }),
      ]),
    ],
  ]);
  const fetchImpl = fixtureFetch(async (url) => {
    if (url.hostname === "tims.dot.state.oh.us") {
      const rows = url.pathname.includes("All_Project_Points")
        ? pointRows
        : lineRows;
      return new Response(
        JSON.stringify({ features: rows.map((row) => ({ attributes: row })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const key = url.searchParams.get("cabinetId");
    const page = pages.get(key);
    assert.notEqual(page, undefined, `unexpected document request ${key}`);
    return new Response(page, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  });

  const result = await fetchOhioDotSource({ fetchImpl, now: NOW });

  assert.equal(result.source.id, OHIO_DOT_SOURCE_ID);
  assert.equal(result.source.recordCount, 1);
  assert.equal(result.projects.length, 1);
  assert.equal(result.page.nextCursor.refreshAfter, undefined);
  assert.doesNotThrow(() =>
    completedRefreshPageTransition({
      sourceId: OHIO_DOT_SOURCE_ID,
      sourceIndex: 0,
      sourceCount: 1,
      phase: "head",
      page: result.page,
      refreshCursors: {},
      refreshPhases: {},
    }),
  );
  assert.equal(fetchImpl.maximumActive() <= 3, true);
  const project = result.projects[0];
  assert.equal(project.sourceRecordId, "100");
  assert.equal(project.bidDate, "2026-08-27T14:00:00.000Z");
  assert.equal(project.bidDateTimeZone, "America/New_York");
  assert.equal(project.value, 5_500_000);
  assert.match(project.summary, /Bridge Preservation/);
  assert.ok(
    project.participants.some(
      (participant) =>
        participant.name === "MANAGER, MORGAN" &&
        participant.email === undefined &&
        participant.phone === undefined,
    ),
  );
  assert.deepEqual(
    project.documents.map((document) => document.kind),
    ["source-record", "plans", "specifications", "addendum"],
  );
  assert.deepEqual(
    project.documents.slice(1).map((document) =>
      new URL(document.url).searchParams.get("documentId"),
    ),
    ["7101", "8101", "9101"],
  );
  assert.ok(
    project.documents.every(
      (document) =>
        new URL(document.url).protocol === "https:" &&
        new URL(document.url).hostname === "contracts.dot.state.oh.us",
    ),
  );
  const documentRequests = fetchImpl.requests
    .map((url) => new URL(url))
    .filter((url) => url.hostname === "contracts.dot.state.oh.us");
  assert.equal(documentRequests.length, 3);
  for (const url of documentRequests) {
    assert.equal(url.searchParams.get("hitsPerPage"), "1000");
    assert.equal(
      url.searchParams.get("DP.LET_DATE.DATE"),
      "07/20/2026-12/31/2031",
    );
    assert.equal(url.searchParams.has("PID_NUM"), false);
  }
  const arcGisRequests = fetchImpl.requests
    .map((url) => new URL(url))
    .filter((url) => url.hostname === "tims.dot.state.oh.us");
  assert.equal(arcGisRequests.length, 2);
  for (const url of arcGisRequests) {
    assert.equal(url.searchParams.get("returnGeometry"), "false");
    assert.equal(url.searchParams.get("returnDistinctValues"), "true");
    assert.match(url.searchParams.get("where"), /PROJECT_STATUS = 'Filed'/);
    assert.match(
      url.searchParams.get("where"),
      /AWARD_MILESTONE_DT >= DATE '2026-07-20'/,
    );
  }
});

test("Ohio DOT rejects an incomplete dual-layer census and does not report it live", async () => {
  let pointAttempts = 0;
  const fetchImpl = fixtureFetch(async (url) => {
    if (url.pathname.includes("All_Project_Points")) {
      pointAttempts += 1;
      return new Response("temporary failure", { status: 503 });
    }
    if (url.hostname === "contracts.dot.state.oh.us") {
      return new Response(documentPage([]), { status: 200 });
    }
    return new Response(JSON.stringify({ features: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await assert.rejects(
    () => fetchOhioDotSource({ fetchImpl, now: NOW }),
    /HTTP 503/,
  );
  assert.equal(pointAttempts, 2, "retryable official failures get one bounded retry");
  assert.equal(fetchImpl.maximumActive() <= 3, true);
});

test("Ohio DOT blocks redirects outside its official host allowlist", async () => {
  const fetchImpl = fixtureFetch(async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://example.com/copied-bid-data" },
    }),
  );
  await assert.rejects(
    () => fetchOhioDotSource({ fetchImpl, now: NOW }),
    /Blocked non-official Ohio DOT URL/,
  );
});

test("Ohio DOT expires a same-day letting after the 10:00 AM Eastern deadline", async () => {
  const row = attributes(400, {
    AWARD_MILESTONE_DT: Date.parse("2026-07-27T00:00:00.000Z"),
  });
  const fetchImpl = fixtureFetch(async (url) => {
    if (url.hostname === "tims.dot.state.oh.us") {
      const rows = url.pathname.includes("All_Project_Points") ? [row] : [];
      return new Response(
        JSON.stringify({ features: rows.map((item) => ({ attributes: item })) }),
        { status: 200 },
      );
    }
    const cabinetId = url.searchParams.get("cabinetId");
    return new Response(
      documentPage(cabinetId === "1000" ? [] : [
        documentRow({
          documentId: "7400",
          pid: 400,
          projectNumber: "260400",
          letDate: "07/20/2026",
        }),
      ]),
      { status: 200 },
    );
  });

  const result = await fetchOhioDotSource({
    fetchImpl,
    now: () => new Date("2026-07-20T14:01:00.000Z"),
  });
  assert.equal(result.projects.length, 0);
  assert.equal(result.source.recordCount, 0);
  assert.equal(
    fetchImpl.requests.filter(
      (url) => new URL(url).hostname === "contracts.dot.state.oh.us",
    ).length,
    3,
    "the three bounded date-range cabinet snapshots are fetched once",
  );
});

test("the Ohio source template is an official open state procurement source", () => {
  assert.equal(OHIO_DOT_SOURCE_TEMPLATE.id, OHIO_DOT_SOURCE_ID);
  assert.equal(OHIO_DOT_SOURCE_TEMPLATE.level, "state");
  assert.equal(OHIO_DOT_SOURCE_TEMPLATE.sourceClass, "procurement");
  assert.equal(OHIO_DOT_SOURCE_TEMPLATE.access, "open");
  assert.equal(new URL(OHIO_DOT_SOURCE_TEMPLATE.url).protocol, "https:");
});
