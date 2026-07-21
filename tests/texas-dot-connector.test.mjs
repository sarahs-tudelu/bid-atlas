import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./ts-extension-loader.mjs", import.meta.url));

const {
  TEXAS_DOT_BIDDERS_CSV_URL,
  TEXAS_DOT_CHANGES_CSV_URL,
  TEXAS_DOT_LETTING_URL,
  TEXAS_DOT_ORDER_CSV_URL,
  TEXAS_DOT_ORDER_VIEW_URL,
  TEXAS_DOT_SOURCE_ID,
  TEXAS_DOT_SOURCE_TEMPLATE,
  fetchTexasDotSource,
} = await import("../app/lib/texas-dot-connector.ts");
const {
  PUBLIC_DOT_SOURCE_TEMPLATES,
  fetchPublicDotSource,
} = await import("../app/lib/public-dot-connectors.ts");
const { assessBidReadiness } = await import("../app/lib/bid-readiness.ts");
const { bidDateMatchesDueFilter } = await import("../app/lib/search.ts");
const {
  dateOnlyBidDeadline,
  formatBidDeadline,
} = await import("../app/lib/deadline-time.ts");

const NOW = () => new Date("2026-07-20T16:00:00.000Z");
const AUGUST_ROOT =
  "https://ftp.txdot.gov/plans/State-Let-Construction/2026/08%20August/";
const PLANS_URL = `${AUGUST_ROOT}08%20Plans/`;
const PROPOSALS_URL = `${AUGUST_ROOT}08%20Proposals/`;
const ADDENDA_URL = `${AUGUST_ROOT}08%20Proposal%20Addenda/`;
const REVISIONS_URL = `${AUGUST_ROOT}08%20Revisions/`;
const CONTRACT_PLANS_URL = `${AUGUST_ROOT}08%20Contract%20Plans/`;
const MAINTENANCE_AUGUST_ROOT =
  "https://ftp.txdot.gov/plans/State-Let-Maintenance/2026/08%20August/";
const MAINTENANCE_PLANS_URL = `${MAINTENANCE_AUGUST_ROOT}08%20Plans/`;
const MAINTENANCE_PROPOSALS_URL = `${MAINTENANCE_AUGUST_ROOT}08%20Proposals/`;
const BID_ITEMS_DATASET_ROOT =
  "https://data.texas.gov/resource/qh8x-rm8r";
const PLANS_ONLINE_LICENSE_URL =
  "https://www.dot.state.tx.us/business/plansonline/agreement.htm";

const scheduleHtml = `
  <h2>2026</h2>
  <ul>
    <li>July 1&ndash;2, 2026</li>
    <li>Aug. 5&ndash;6, 2026</li>
    <li>Sept. 2&ndash;3, 2026</li>
  </ul>
  <p>For the statewide letting, contact the Construction Division at 512-416-2500.</p>`;

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const orderHeaders = [
  "BID RECEIVED UNTIL DATE",
  "CCSJ",
  "COUNTY",
  "DISTRICT",
  "HIGHWAY",
  "LIMITS FROM ",
  "LIMITS TO",
  "Measure Names",
  "Month, Year of letting date",
  "PROJ NUMBER",
  "SEQUENCE NUMBER",
  "SHORT DESCRIPTION",
  "Measure Values",
];

function orderRows({
  csj,
  bidDate,
  county = "BEXAR",
  district = "SAN ANTONIO",
  highway = "IH 10",
  limitsFrom = "0.5 MI EAST OF FM 1518",
  limitsTo = "BEXAR COUNTY LINE",
  projectNumber = "F 2026(887)",
  sequence = "3051",
  description = "HAZARD ELIMINATION & SAFETY",
  dbeGoal = "4.5",
  length = "15.423",
}) {
  const common = [
    bidDate,
    csj,
    county,
    district,
    highway,
    limitsFrom,
    limitsTo,
  ];
  const suffix = ["August 2026", projectNumber, sequence, description];
  return [
    [...common, "DBE GOAL", ...suffix, dbeGoal],
    [...common, "LENGTH", ...suffix, length],
  ];
}

const bidderHeaders = [
  "Controlling Project Id",
  "County",
  "District",
  "EMAIL",
  "Hwy Nm",
  "Let Date",
  "Let Type",
  "Link",
  "Month, Day, Year of Cntrct Bid Due Dt",
  "Project Number",
  "Proposals Request",
  "TEX_PRES",
  "Vendor Name",
];

const changesHeaders = [
  "Change",
  "Control Section Job (Csj)",
  "Controlling Project Id (Ccsj)",
  "COUNTY",
  "DISTRICT",
  "HIGHWAY",
  "Project Type",
  "Reason For Cancelled/Changed",
];

const bidItemRows = [
  {
    controlling_project_id_ccsj: "0025-02-234",
    bid_recieved_until_date_and: "2026-08-05T13:00:00.000",
    let_type: "Statewide Let",
    project_type: "Construction",
    proposal_status: "Official",
    proposal_phone_number: "5124162498",
  },
  {
    controlling_project_id_ccsj: "0327-08-109",
    bid_recieved_until_date_and: "2026-08-06T13:00:00.000",
    let_type: "Statewide Let",
    project_type: "Construction",
    proposal_status: "Official",
    proposal_phone_number: "5124162498",
  },
];
const maintenanceBidItemRow = {
  controlling_project_id_ccsj: "6500-92-001",
  bid_recieved_until_date_and: "2026-08-05T13:00:00.000",
  let_type: "Statewide Let",
  project_type: "Maintenance",
  proposal_status: "Official",
  proposal_phone_number: "5124162498",
};
const bidItemRowsWithMaintenance = [...bidItemRows, maintenanceBidItemRow];

function bidItemDatasetFixture(rows) {
  return () => {
    const body = JSON.stringify(rows);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(body).length),
      },
    });
  };
}

function bidderRow({
  csj,
  bidDate,
  vendor,
  email = "",
  request = "Authorized Bidder",
  link = "https://tableau.txdot.gov/views/VendorInformation/VendorList?:iid=1&Vendor%20Id=12345",
  letType = "Statewide Let",
}) {
  return [
    csj,
    "Bexar",
    "San Antonio",
    email,
    "IH 10",
    bidDate,
    letType,
    link,
    bidDate,
    "F 2026(887)",
    request,
    "",
    vendor,
  ];
}

function archiveRoot({ addenda = true, revisions = true } = {}) {
  return `
    <a href="?C=N;O=D">Name</a>
    <a href="/plans/State-Let-Construction/2026/">Parent Directory</a>
    <a href="08%20Plans/">08 Plans/</a>
    <a href="08%20Proposals/">08 Proposals/</a>
    ${addenda ? '<a href="08%20Proposal%20Addenda/">08 Proposal Addenda/</a>' : ""}
    ${revisions ? '<a href="08%20Revisions/">08 Revisions/</a>' : ""}
    <a href="08%20Contract%20Plans/">08 Contract Plans/</a>
    <a href="https://example.com/copied-plans/">Copied plans</a>`;
}

function maintenanceArchiveRoot() {
  return `
    <a href="?C=N;O=D">Name</a>
    <a href="/plans/State-Let-Maintenance/2026/">Parent Directory</a>
    <a href="08%20Plans/">08 Plans/</a>
    <a href="08%20Proposals/">08 Proposals/</a>`;
}

function fileListing(files) {
  return `<html><body>${files
    .map(
      (file) =>
        `<a href="${encodeURIComponent(file)}">${file}</a> 2026-07-14 06:36 4.4M`,
    )
    .join("\n")}</body></html>`;
}

function standardOrderCsv({ includeMaintenance = false } = {}) {
  return csv([
    orderHeaders,
    ...orderRows({ csj: "0025-02-234", bidDate: "08/05/2026" }),
    ...orderRows({
      csj: "0327-08-109",
      bidDate: "08/06/2026",
      county: "CAMERON",
      district: "PHARR",
      highway: "BU 77X",
      limitsFrom: "FM 510",
      limitsTo: "SH 100",
      projectNumber: "F 2026(907)",
      sequence: "6052",
      description: "LANDSCAPE DEVELOPMENT",
    }),
    ...(includeMaintenance
      ? orderRows({
          csj: "6500-92-001",
          bidDate: "08/05/2026",
          description: "STATE LET MAINTENANCE",
        })
      : []),
    ...orderRows({
      csj: "0001-01-075",
      bidDate: "09/02/2026",
      description: "FUTURE CONSTRUCTION",
    }),
  ]);
}

function standardFixtures(overrides = {}) {
  const bidderCsv = csv([
    bidderHeaders,
    bidderRow({
      csj: "0025-02-234",
      bidDate: "August 5, 2026",
      vendor: "AUTHORIZED ROAD BUILDERS, INC.",
      email: "ESTIMATING@ROADBUILDERS.EXAMPLE",
    }),
    bidderRow({
      csj: "0025-02-234",
      bidDate: "August 5, 2026",
      vendor: "INFORMATION ONLY LLC",
      email: "info@example.com",
      request: "Informational Proposal",
    }),
    bidderRow({
      csj: "0327-08-109",
      bidDate: "August 6, 2026",
      vendor: "LANDSCAPE PARTNERS LLC",
      email: "BIDS@LANDSCAPE.EXAMPLE",
      link: "https://example.com/vendor-copy",
    }),
  ]);
  return {
    [TEXAS_DOT_LETTING_URL]: scheduleHtml,
    [TEXAS_DOT_ORDER_CSV_URL]: standardOrderCsv(),
    [TEXAS_DOT_BIDDERS_CSV_URL]: bidderCsv,
    [TEXAS_DOT_CHANGES_CSV_URL]: csv([changesHeaders]),
    [AUGUST_ROOT]: archiveRoot(),
    [PLANS_URL]: fileListing([
      "Bexar 0025-02-234 Vol.1.pdf",
      "Bexar 0025-02-234 Vol.2.pdf",
      "Cameron 0327-08-109.pdf",
    ]),
    [PROPOSALS_URL]: fileListing([
      "Bexar 0025-02-234 Proposal.pdf",
      "Cameron 0327-08-109 Proposal.pdf",
    ]),
    [ADDENDA_URL]: fileListing(["Bexar 0025-02-234 AD.pdf"]),
    [REVISIONS_URL]: fileListing(["Cameron 0327-08-109R.pdf"]),
    [MAINTENANCE_AUGUST_ROOT]: maintenanceArchiveRoot(),
    [MAINTENANCE_PLANS_URL]: fileListing([]),
    [MAINTENANCE_PROPOSALS_URL]: fileListing([]),
    [`${BID_ITEMS_DATASET_ROOT}*`]: bidItemDatasetFixture(bidItemRows),
    ...overrides,
  };
}

function fixtureFetch(fixtures) {
  const requests = [];
  let active = 0;
  let maximumActive = 0;
  const fetchImpl = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    requests.push(url);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const wildcardKey = Object.keys(fixtures)
        .filter(
          (key) => key.endsWith("*") && url.startsWith(key.slice(0, -1)),
        )
        .sort((left, right) => right.length - left.length)[0];
      const fixture = fixtures[url] ?? fixtures[wildcardKey];
      if (fixture instanceof Response) return fixture;
      if (typeof fixture === "function") return await fixture(url);
      if (fixture === undefined) return new Response("not found", { status: 404 });
      const contentType = url.includes(".csv?") ? "text/csv" : "text/html";
      return new Response(fixture, {
        status: 200,
        headers: {
          "content-type": contentType,
          "content-length": String(new TextEncoder().encode(fixture).length),
        },
      });
    } finally {
      active -= 1;
    }
  };
  fetchImpl.requests = requests;
  fetchImpl.maximumActive = () => maximumActive;
  return fetchImpl;
}

test("TxDOT joins exact current letting days, plans, proposals, addenda, and authorized proposal requesters by CSJ", async () => {
  const fetchImpl = fixtureFetch(standardFixtures());
  const result = await fetchTexasDotSource({ fetchImpl, now: NOW });

  assert.equal(TEXAS_DOT_SOURCE_TEMPLATE.id, TEXAS_DOT_SOURCE_ID);
  assert.equal(result.source.status, "live");
  assert.equal(result.source.recordCount, 2);
  assert.equal(result.source.recordCountUnit, "projects");
  assert.equal(result.source.loadedCount, 2);
  assert.equal(result.source.snapshotComplete, true);
  assert.equal(result.projects.length, 2);
  assert.equal(fetchImpl.maximumActive() <= 3, true);

  const bexar = result.projects.find(
    (project) => project.sourceRecordId === "0025-02-234",
  );
  assert.ok(bexar);
  assert.equal(bexar.bidDate, "2026-08-05T18:00:00.000Z");
  assert.equal(bexar.bidDateTimeZone, "America/Chicago");
  assert.equal(bexar.county, "Bexar");
  assert.match(bexar.title, /Hazard Elimination & Safety/);
  assert.match(bexar.summary, /IH 10/);
  assert.match(bexar.summary, /FM 1518/);
  assert.deepEqual(
    bexar.documents.map((document) => document.kind),
    [
      "source-record",
      "source-record",
      "plans",
      "plans",
      "specifications",
      "addendum",
    ],
  );
  assert.equal(bexar.documents[0].url, TEXAS_DOT_ORDER_VIEW_URL);
  assert.ok(
    bexar.documents.some(
      (document) =>
        document.kind === "source-record" &&
        document.url === PLANS_ONLINE_LICENSE_URL,
    ),
  );
  assert.ok(
    bexar.participants.some(
      (participant) =>
        participant.role === "agency" &&
        participant.phone === "512-416-2498",
    ),
  );
  assert.ok(
    bexar.participants.some(
      (participant) =>
        participant.role === "plan-holder" &&
        participant.name === "AUTHORIZED ROAD BUILDERS, INC." &&
        participant.email === "estimating@roadbuilders.example",
    ),
  );
  assert.equal(
    bexar.participants.some(
      (participant) => participant.name === "INFORMATION ONLY LLC",
    ),
    false,
    "informational proposal pulls are not represented as authorized plan holders",
  );
  assert.match(
    result.source.note,
    /authorized (?:proposal requester|plan-holder)/i,
  );
  assert.match(
    result.source.note,
    /(?:not (?:as )?proof|does not (?:prove|confirm)).*submitted (?:a )?bid/i,
  );
  assert.match(result.source.note, /TxDOT Plans Online license/i);

  const cameron = result.projects.find(
    (project) => project.sourceRecordId === "0327-08-109",
  );
  assert.ok(cameron);
  assert.equal(cameron.bidDate, "2026-08-06T18:00:00.000Z");
  assert.ok(cameron.documents.some((document) => /109R\.pdf$/i.test(document.url)));
  const landscapeBidder = cameron.participants.find(
    (participant) => participant.name === "LANDSCAPE PARTNERS LLC",
  );
  assert.equal(
    landscapeBidder?.sourceUrl,
    TEXAS_DOT_BIDDERS_CSV_URL,
    "off-site vendor links fall back to the official bidder index",
  );
  for (const project of result.projects) {
    for (const document of project.documents.slice(1)) {
      if (document.url === PLANS_ONLINE_LICENSE_URL) continue;
      assert.equal(new URL(document.url).hostname, "ftp.txdot.gov");
      assert.match(document.url, /\/plans\/State-Let-Construction\//);
      assert.equal(document.indexStatus, "metadata-only");
    }
  }
  assert.equal(fetchImpl.requests.includes(CONTRACT_PLANS_URL), false);
});

test("TxDOT traverses both state-let construction and maintenance archives", async () => {
  const fetchImpl = fixtureFetch(
    standardFixtures({
      [TEXAS_DOT_ORDER_CSV_URL]: standardOrderCsv({
        includeMaintenance: true,
      }),
      [MAINTENANCE_PLANS_URL]: fileListing([
        "Coryell 6500-92-001.pdf",
      ]),
      [MAINTENANCE_PROPOSALS_URL]: fileListing([
        "Coryell 6500-92-001 Proposal.pdf",
      ]),
      [`${BID_ITEMS_DATASET_ROOT}*`]: bidItemDatasetFixture(
        bidItemRowsWithMaintenance,
      ),
    }),
  );

  const result = await fetchTexasDotSource({ fetchImpl, now: NOW });

  assert.equal(result.source.recordCount, 3);
  assert.equal(result.source.snapshotComplete, true);
  assert.match(result.source.name, /construction.*maintenance/i);
  assert.match(result.source.note, /construction.*maintenance/i);
  assert.deepEqual(
    result.projects.map((project) => project.sourceRecordId).sort(),
    ["0025-02-234", "0327-08-109", "6500-92-001"],
  );
  const maintenance = result.projects.find(
    (project) => project.sourceRecordId === "6500-92-001",
  );
  assert.ok(maintenance);
  assert.ok(
    maintenance.documents.some(
      (document) =>
        document.kind === "plans" &&
        document.url.startsWith(MAINTENANCE_PLANS_URL),
    ),
  );
  assert.ok(
    maintenance.documents
      .filter((document) => document.url.startsWith(MAINTENANCE_AUGUST_ROOT))
      .every((document) => document.indexStatus === "metadata-only"),
  );
  assert.ok(
    maintenance.documents.some(
      (document) =>
        document.kind === "specifications" &&
        document.url.startsWith(MAINTENANCE_PROPOSALS_URL),
    ),
  );
  assert.equal(fetchImpl.requests.includes(MAINTENANCE_AUGUST_ROOT), true);
  assert.equal(fetchImpl.requests.includes(MAINTENANCE_PLANS_URL), true);
  assert.equal(fetchImpl.requests.includes(MAINTENANCE_PROPOSALS_URL), true);
});

test("TxDOT uses the authoritative qh8x-rm8r 1 PM Central bid deadline", async () => {
  const fixtureFetchImpl = fixtureFetch(standardFixtures());
  const datasetRequests = [];
  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(BID_ITEMS_DATASET_ROOT)) {
      datasetRequests.push(url);
      const accept = new Headers(init?.headers).get("accept") ?? "";
      const body = /text\/csv/i.test(accept) || /\.csv(?:\?|$)/i.test(url)
        ? csv([
            [
              "CONTROLLING PROJECT ID (CCSJ)",
              "BID RECIEVED UNTIL DATE AND TIME",
              "LET TYPE",
              "PROJECT TYPE",
              "PROPOSAL STATUS",
              "PROPOSAL  PHONE NUMBER",
            ],
            ...bidItemRows.map((row) => [
              row.controlling_project_id_ccsj,
              row.bid_recieved_until_date_and,
              row.let_type,
              row.project_type,
              row.proposal_status,
              row.proposal_phone_number,
            ]),
          ])
        : JSON.stringify(bidItemRows);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": /text\/csv/i.test(accept) ? "text/csv" : "application/json",
          "content-length": String(new TextEncoder().encode(body).length),
        },
      });
    }
    return fixtureFetchImpl(input, init);
  };

  const result = await fetchTexasDotSource({ fetchImpl, now: NOW });
  const project = result.projects.find(
    (candidate) => candidate.sourceRecordId === "0025-02-234",
  );

  assert.ok(project);
  assert.ok(datasetRequests.length > 0, "the official qh8x-rm8r dataset is queried");
  assert.equal(project.bidDate, "2026-08-05T18:00:00.000Z");
  assert.equal(project.bidDateTimeZone, "America/Chicago");
  assert.equal(
    bidDateMatchesDueFilter(
      project.bidDate,
      "today",
      new Date("2026-08-05T15:00:00.000Z"),
      project.bidDateTimeZone,
    ),
    true,
  );
  assert.equal(
    assessBidReadiness(
      project,
      new Date("2026-08-05T17:59:59.000Z"),
    ).reasons.includes("deadline-passed"),
    false,
  );
  assert.equal(
    assessBidReadiness(
      project,
      new Date("2026-08-05T18:00:01.000Z"),
    ).reasons.includes("deadline-passed"),
    true,
  );
});

test("TxDOT retains a validated CSJ with the order date when qh8 has no official deadline row", async () => {
  const fetchImpl = fixtureFetch(
    standardFixtures({
      [`${BID_ITEMS_DATASET_ROOT}*`]: bidItemDatasetFixture([
        bidItemRows[0],
      ]),
    }),
  );

  const result = await fetchTexasDotSource({ fetchImpl, now: NOW });

  assert.equal(result.source.status, "degraded");
  assert.equal(result.source.recordCount, 2);
  assert.equal(result.source.loadedCount, 2);
  assert.equal(result.source.snapshotComplete, false);
  assert.equal(
    result.projects.find(
      (project) => project.sourceRecordId === "0025-02-234",
    )?.bidDate,
    "2026-08-05T18:00:00.000Z",
  );
  const dateOnlyProject = result.projects.find(
    (project) => project.sourceRecordId === "0327-08-109",
  );
  assert.ok(dateOnlyProject);
  assert.equal(dateOnlyProject.bidDate, "2026-08-06T00:00:00.000Z");
  assert.match(dateOnlyProject.status, /bid date 2026-08-06; deadline time not published/i);
  assert.doesNotMatch(dateOnlyProject.status, /received until .*T00:00:00/i);
  assert.equal(dateOnlyBidDeadline(dateOnlyProject.bidDate), "2026-08-06");
  assert.match(
    formatBidDeadline(
      dateOnlyProject.bidDate,
      dateOnlyProject.bidDateTimeZone,
    ),
    /Aug 6, 2026 - time not published/i,
  );
  assert.equal(
    bidDateMatchesDueFilter(
      dateOnlyProject.bidDate,
      "today",
      new Date("2026-08-07T04:59:59.000Z"),
      dateOnlyProject.bidDateTimeZone,
    ),
    true,
  );
  assert.equal(
    assessBidReadiness(
      dateOnlyProject,
      new Date("2026-08-07T04:59:59.000Z"),
    ).reasons.includes("deadline-passed"),
    false,
  );
  assert.equal(
    assessBidReadiness(
      dateOnlyProject,
      new Date("2026-08-07T05:00:00.000Z"),
    ).reasons.includes("deadline-passed"),
    true,
  );
  assert.match(
    result.source.note,
    /1 current CSJ\(s\) lacked an authoritative TxDOT bid-item time/i,
  );
  assert.match(result.source.note, /official order-report date only/i);
  assert.match(result.source.note, /no deadline hour was invented/i);
});

test("TxDOT retains the entire validated letting when authoritative bid times are not yet published", async () => {
  const fetchImpl = fixtureFetch(
    standardFixtures({
      [`${BID_ITEMS_DATASET_ROOT}*`]: bidItemDatasetFixture([]),
    }),
  );

  const result = await fetchTexasDotSource({ fetchImpl, now: NOW });

  assert.equal(result.source.status, "degraded");
  assert.equal(result.source.recordCount, 2);
  assert.equal(result.projects.length, 2);
  assert.ok(
    result.projects.every(
      (project) =>
        dateOnlyBidDeadline(project.bidDate) &&
        /deadline time not published/i.test(project.status),
    ),
  );
  assert.match(
    result.source.note,
    /2 current CSJ\(s\) lacked an authoritative TxDOT bid-item time/i,
  );
});

test("public DOT registry delegates Texas to the hardened connector", async () => {
  assert.equal(
    PUBLIC_DOT_SOURCE_TEMPLATES[TEXAS_DOT_SOURCE_ID],
    TEXAS_DOT_SOURCE_TEMPLATE,
  );
  const result = await fetchPublicDotSource(TEXAS_DOT_SOURCE_ID, {
    fetchImpl: fixtureFetch(standardFixtures()),
    now: NOW,
  });
  assert.equal(result.source.status, "live");
  assert.deepEqual(
    result.projects.map((project) => project.sourceRecordId),
    ["0025-02-234", "0327-08-109"],
  );
  assert.ok(result.projects.every((project) =>
    project.documents.some((document) => document.kind === "plans")),
  );
});

test("TxDOT filters expired first-day projects while retaining the second letting day", async () => {
  const fetchImpl = fixtureFetch(standardFixtures());
  const result = await fetchTexasDotSource({
    fetchImpl,
    now: () => new Date("2026-08-06T16:00:00.000Z"),
  });
  assert.equal(result.source.recordCount, 1);
  assert.deepEqual(
    result.projects.map((project) => project.sourceRecordId),
    ["0327-08-109"],
  );
  assert.equal(result.projects[0].bidDate, "2026-08-06T18:00:00.000Z");
});

test("TxDOT paginates a complete validated census at 20 records per view", async () => {
  const records = Array.from({ length: 25 }, (_value, index) => {
    const csj = `${String(index + 1).padStart(4, "0")}-01-001`;
    return { csj, county: `COUNTY ${index + 1}`, sequence: String(3000 + index) };
  });
  const plans = records.map((record) => `${record.county} ${record.csj}.pdf`);
  const proposals = records.map(
    (record) => `${record.county} ${record.csj} Proposal.pdf`,
  );
  const orderCsv = csv([
    orderHeaders,
    ...records.flatMap((record) =>
      orderRows({
        csj: record.csj,
        bidDate: "08/05/2026",
        county: record.county,
        sequence: record.sequence,
      }),
    ),
  ]);
  const paginationBidItemRows = records.map((record) => ({
    controlling_project_id_ccsj: record.csj,
    bid_recieved_until_date_and: "2026-08-05T13:00:00.000",
    let_type: "Statewide Let",
    project_type: "Construction",
    proposal_status: "Official",
    proposal_phone_number: "5124162498",
  }));
  const fixtures = standardFixtures({
    [TEXAS_DOT_ORDER_CSV_URL]: orderCsv,
    [TEXAS_DOT_BIDDERS_CSV_URL]: csv([bidderHeaders]),
    [AUGUST_ROOT]: archiveRoot({ addenda: false, revisions: false }),
    [PLANS_URL]: fileListing(plans),
    [PROPOSALS_URL]: fileListing(proposals),
    [`${BID_ITEMS_DATASET_ROOT}*`]: bidItemDatasetFixture(
      paginationBidItemRows,
    ),
  });
  delete fixtures[ADDENDA_URL];
  delete fixtures[REVISIONS_URL];

  const first = await fetchTexasDotSource({
    fetchImpl: fixtureFetch(fixtures),
    now: NOW,
  });
  assert.equal(first.source.recordCount, 25);
  assert.equal(first.projects.length, 20);
  assert.equal(first.page.nextOffset, 20);
  assert.equal(first.page.hasMore, true);
  assert.equal(first.source.snapshotComplete, false);

  const second = await fetchTexasDotSource({
    fetchImpl: fixtureFetch(fixtures),
    now: NOW,
    sourceCursors: { [TEXAS_DOT_SOURCE_ID]: { offset: 20 } },
  });
  assert.equal(second.projects.length, 5);
  assert.equal(second.page.offset, 20);
  assert.equal(second.page.nextOffset, 25);
  assert.equal(second.page.hasMore, false);
  assert.equal(second.source.snapshotComplete, true);
});

test("TxDOT excludes incomplete archive identities and marks the snapshot degraded", async () => {
  const fetchImpl = fixtureFetch(
    standardFixtures({
      [PROPOSALS_URL]: fileListing(["Bexar 0025-02-234 Proposal.pdf"]),
    }),
  );
  const result = await fetchTexasDotSource({ fetchImpl, now: NOW });
  assert.equal(result.source.status, "degraded");
  assert.equal(result.source.snapshotComplete, false);
  assert.equal(result.source.recordCount, 1);
  assert.deepEqual(
    result.projects.map((project) => project.sourceRecordId),
    ["0025-02-234"],
  );
  assert.match(result.source.note, /lacked either a public plan or proposal/i);
});

test("TxDOT removes projects explicitly cancelled for the current letting", async () => {
  const changesCsv = csv([
    changesHeaders,
    [
      "Project Cancelled",
      "0025-02-234",
      "0025-02-234",
      "Bexar",
      "San Antonio",
      "IH 10",
      "CONSTRUCTION",
      "PROJECT STATUS",
    ],
  ]);
  const fetchImpl = fixtureFetch(
    standardFixtures({ [TEXAS_DOT_CHANGES_CSV_URL]: changesCsv }),
  );
  const result = await fetchTexasDotSource({ fetchImpl, now: NOW });
  assert.equal(result.source.status, "live");
  assert.equal(result.source.recordCount, 1);
  assert.deepEqual(
    result.projects.map((project) => project.sourceRecordId),
    ["0327-08-109"],
  );
});

test("TxDOT removes cancelled maintenance projects from the combined letting", async () => {
  const changesCsv = csv([
    changesHeaders,
    [
      "Project Cancelled",
      "6500-92-001",
      "6500-92-001",
      "Coryell",
      "Waco",
      "FM 116",
      "MAINTENANCE",
      "PROJECT STATUS",
    ],
  ]);
  const fetchImpl = fixtureFetch(
    standardFixtures({
      [TEXAS_DOT_ORDER_CSV_URL]: standardOrderCsv({
        includeMaintenance: true,
      }),
      [TEXAS_DOT_CHANGES_CSV_URL]: changesCsv,
      [MAINTENANCE_PLANS_URL]: fileListing([
        "Coryell 6500-92-001.pdf",
      ]),
      [MAINTENANCE_PROPOSALS_URL]: fileListing([
        "Coryell 6500-92-001 Proposal.pdf",
      ]),
      [`${BID_ITEMS_DATASET_ROOT}*`]: bidItemDatasetFixture(
        bidItemRowsWithMaintenance,
      ),
    }),
  );

  const result = await fetchTexasDotSource({ fetchImpl, now: NOW });

  assert.equal(result.source.status, "live");
  assert.equal(result.source.recordCount, 2);
  assert.equal(
    result.projects.some(
      (project) => project.sourceRecordId === "6500-92-001",
    ),
    false,
  );
});

test("TxDOT refuses a false live zero when documents and the order report do not match", async () => {
  const mismatchedOrder = csv([
    orderHeaders,
    ...orderRows({ csj: "9999-99-999", bidDate: "08/05/2026" }),
  ]);
  const fetchImpl = fixtureFetch(
    standardFixtures({
      [TEXAS_DOT_ORDER_CSV_URL]: mismatchedOrder,
      [`${BID_ITEMS_DATASET_ROOT}*`]: bidItemDatasetFixture([
        {
          controlling_project_id_ccsj: "9999-99-999",
          bid_recieved_until_date_and: "2026-08-05T13:00:00.000",
          let_type: "Statewide Let",
          project_type: "Construction",
          proposal_status: "Official",
          proposal_phone_number: "5124162498",
        },
      ]),
    }),
  );
  await assert.rejects(
    () => fetchTexasDotSource({ fetchImpl, now: NOW }),
    /no matching current CSJs|false live-zero/i,
  );
});

test("TxDOT blocks redirects outside the official host allowlist", async () => {
  const fetchImpl = fixtureFetch({
    ...standardFixtures(),
    [TEXAS_DOT_LETTING_URL]: new Response(null, {
      status: 302,
      headers: { location: "https://example.com/copied-letting" },
    }),
  });
  await assert.rejects(
    () => fetchTexasDotSource({ fetchImpl, now: NOW }),
    /Blocked non-official TxDOT URL/,
  );
});

test("TxDOT enforces a streamed response byte ceiling", async () => {
  const fetchImpl = fixtureFetch(standardFixtures());
  await assert.rejects(
    () =>
      fetchTexasDotSource({
        fetchImpl,
        now: NOW,
        maxTextBytes: 64,
      }),
    /exceeds 64 bytes/,
  );
});

test("TxDOT keeps actionable projects but degrades when the authorized proposal-requester export fails", async () => {
  let attempts = 0;
  const fetchImpl = fixtureFetch(
    standardFixtures({
      [TEXAS_DOT_BIDDERS_CSV_URL]: () => {
        attempts += 1;
        return new Response("temporary failure", { status: 503 });
      },
    }),
  );
  const result = await fetchTexasDotSource({ fetchImpl, now: NOW });
  assert.equal(attempts, 2, "retryable official failures get one bounded retry");
  assert.equal(result.projects.length, 2);
  assert.equal(result.source.status, "degraded");
  assert.match(
    result.source.note,
    /authorized(?:-| )(?:bidder|plan-holder|proposal-requester) export could not be refreshed/i,
  );
});
