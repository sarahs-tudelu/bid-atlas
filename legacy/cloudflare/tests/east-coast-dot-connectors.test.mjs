import assert from "node:assert/strict";
import test from "node:test";

const {
  EAST_COAST_DOT_SOURCE_IDS,
  EAST_COAST_DOT_SOURCE_TEMPLATES,
  fetchEastCoastDotSource,
  parseMassDotStatus,
  parseMarylandShaSchedule,
  parseScDotNoticeText,
} = await import("../app/lib/east-coast-dot-connectors.ts");
const { PUBLIC_DOT_SOURCE_IDS } = await import(
  "../app/lib/public-dot-connectors.ts"
);

const NOW = () => new Date("2026-07-24T16:00:00.000Z");

function fixtureFetch(routes) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input.url,
    ).toString();
    requests.push({ url, method: init.method ?? "GET", body: init.body });
    const body =
      typeof routes[url] === "function"
        ? routes[url](init)
        : routes[url];
    if (body === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(body, {
      status: 200,
      headers: {
        "content-type":
          typeof body === "string"
            ? "text/html"
            : "application/octet-stream",
      },
    });
  };
  fetchImpl.requests = requests;
  return fetchImpl;
}

test("East Coast DOT sources are registered with explicit coverage metadata", () => {
  assert.equal(EAST_COAST_DOT_SOURCE_IDS.length, 6);
  for (const sourceId of EAST_COAST_DOT_SOURCE_IDS) {
    assert.ok(PUBLIC_DOT_SOURCE_IDS.includes(sourceId));
    const template = EAST_COAST_DOT_SOURCE_TEMPLATES[sourceId];
    assert.equal(template.id, sourceId);
    assert.match(template.stateCode, /^(?:MA|DE|MD|SC|GA|DC)$/);
    assert.equal(template.coverageField, "dotBidding");
    assert.equal(new URL(template.url).protocol, "https:");
  }
});

test("MassDOT parser emits current projects and labels gated plans honestly", () => {
  const html = `
    <div class='sm_hilite'>Bid Opening: 7/28/2026 2:00PM</div>
    <div class='tbl rowTbl1'><table>
      <tr><td><strong>Location:</strong><i> FALL RIVER</i></td></tr>
      <tr><td><strong>Description:</strong><i> Bridge Preservation</i></td></tr>
      <tr><td><strong>District:</strong> 5
        <strong>Ad Date:</strong> 6/20/2026
        <strong>Project Value:</strong> $1,884,510.00
        <strong>CDs, Plans &amp; Specs Available:</strong> Yes</td></tr>
      <tr><td><strong>Federal Aid No.:</strong> None
        <strong>Project Number:</strong> 614090
        <strong>Project Type:</strong> Bridge - Construction</td></tr>
    </table></div>
    <div class='sm_hilite'>Bid Opening: 6/01/2026 2:00PM</div>
    <div class='tbl rowTbl2'><strong>Description:</strong> Closed
      <strong>Project Number:</strong> OLD</div>`;

  const projects = parseMassDotStatus(html, NOW());

  assert.equal(projects.length, 1);
  assert.equal(projects[0].recordId, "614090");
  assert.equal(projects[0].bidDate, "2026-07-28T14:00:00");
  assert.equal(projects[0].value, 1_884_510);
  assert.deepEqual(projects[0].documents[0], {
    name: "MassDOT plans and specifications in Bid Express",
    kind: "plans",
    url: "https://www.bidx.com/ma/main",
    access: "free-account",
    indexStatus: "account-gated",
  });
});

test("DelDOT joins its agency-filtered API row to public plans and contact email", async () => {
  const bidsUrl =
    "https://mmp.delaware.gov/Bids/GetBids?status=Open";
  const documentsUrl =
    "https://mmp.delaware.gov/Bids/GetBidDocumentList?id=9236&currentCount=0";
  const fetchImpl = fixtureFetch({
    [bidsUrl]: JSON.stringify({
      rows: [
        {
          Id: 9236,
          Title: "Sidewalk improvements",
          ContractNumber: "T202501101.02",
          OpenDate: "2026-06-26",
          DeadlineDate: "2026-07-28",
          AgencyCode: "DOT",
          ContactEmail: "DOT-ask@delaware.gov",
        },
        {
          Id: 1,
          Title: "Other agency",
          ContractNumber: "OTHER",
          DeadlineDate: "2026-08-01",
          AgencyCode: "OMB",
        },
      ],
    }),
    [documentsUrl]: `
      <a href="https://gssdocs.deldot.delaware.gov/bids/T202501101-02 Plans.pdf">Plans</a>
      <a href="https://gssdocs.deldot.delaware.gov/bids/T202501101-02 Proposal.pdf">RFP - Public Works</a>
      <a href="https://evil.example/plans.pdf">Untrusted plans</a>`,
  });

  const result = await fetchEastCoastDotSource(
    "delaware-dot-open-solicitations",
    { fetchImpl, now: NOW },
  );

  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].sourceRecordId, "T202501101.02");
  assert.ok(
    result.projects[0].documents.some(
      (document) =>
        document.kind === "plans" &&
        document.access === "public" &&
        document.url.includes("gssdocs.deldot.delaware.gov"),
    ),
  );
  assert.ok(
    !result.projects[0].documents.some((document) =>
      document.url.includes("evil.example"),
    ),
  );
  assert.equal(
    result.projects[0].participants[0].email,
    "DOT-ask@delaware.gov",
  );
  assert.equal(fetchImpl.requests[0].method, "POST");
});

test("Maryland SHA distinguishes advertised bids from future schedule rows", () => {
  const html = `
    <table id="ContractAdGridView">
      <tr class="THeaders"><th>CONTRACT</th></tr>
      <tr class="TrHeader">
        <td>XQ6035177</td><td>I-95</td><td>Bridge rehabilitation</td>
        <td>STRUCTURES</td><td>07/01/2026</td><td>08/06/2026</td>
        <td>10/01/2026</td><td>F</td>
      </tr>
      <tr class="TrAlternateHeader">
        <td>XY0000001</td><td>MD 2</td><td>Roadway resurfacing</td>
        <td>PAVING</td><td>08/01/2026</td><td>09/01/2026</td>
        <td>11/01/2026</td><td>D</td>
      </tr>
      <tr class="TrHeader">
        <td>OLD</td><td></td><td>Closed</td><td>PAVING</td>
        <td>05/01/2026</td><td>06/01/2026</td><td></td><td>A</td>
      </tr>
    </table>`;

  const projects = parseMarylandShaSchedule(html, NOW());

  assert.deepEqual(
    projects.map((project) => [project.recordId, project.stage]),
    [
      ["XQ6035177", "bidding"],
      ["XY0000001", "planning"],
    ],
  );
  assert.ok(projects.every((project) => project.documents[0].access === "free-account"));
});

test("SCDOT notice text becomes project-level records with official identifiers", () => {
  const noticeUrl =
    "https://info2.scdot.org/currentletting/ConstructionDocs/08112026%20Notice%20to%20Contractors.pdf";
  const text = [
    "Call No.: 001 1 Page:",
    "1077530 SC File NO.",
    "CO(S).: CHARLESTON DBE Goal",
    "Completion Date: Description: TYPE II SIGNAL REBUILDS DIST. 6 12/01/2026 Days",
    "Funding: FED P123456 P123456 PCN:",
  ].join(" ");

  const projects = parseScDotNoticeText(
    text,
    "2026-08-11T23:59:00",
    noticeUrl,
  );

  assert.equal(projects.length, 1);
  assert.equal(projects[0].recordId, "1077530");
  assert.equal(projects[0].county, "CHARLESTON");
  assert.match(projects[0].summary, /PCN: P123456/);
  assert.ok(projects[0].documents.some((document) => document.kind === "plans"));
});

test("GDOT and DDOT official endpoints emit scheduled and open records", async () => {
  const gdotFetch = fixtureFetch({
    "https://www.dot.ga.gov/PartnerSmart/Business/Documents/Contractor/2026LettingSchedule.pdf":
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  });
  const gdot = await fetchEastCoastDotSource(
    "georgia-dot-construction-letting-calendar",
    { fetchImpl: gdotFetch, now: NOW },
  );
  assert.equal(gdot.projects[0].sourceRecordId, "GDOT-2026-08-21");
  assert.equal(gdot.projects[0].stage, "bidding");
  assert.equal(gdot.projects[0].postedAt, "2026-07-24T00:00:00");

  const ddotFetch = fixtureFetch({
    "https://dtap.ddot.dc.gov/Project/SolicitationOpenLocationsRead?page=1&pageSize=100":
      JSON.stringify({
        Data: [
          {
            RequestId: 292,
            RequestIdEncoded: "request-encoded",
            SolicitationNumber: "DCKA-2026-B-0008",
            SolicitationNumberEncoded: "solicitation-encoded",
            BidStatus: "OPEN",
            SOWTitle: "Bridge repair",
            ProjectPhase: "CON",
            IsAvailableToPublic: true,
            DesignationType: "Invitation for Bids",
            LastUpdatedDate: "2026-07-20T09:00:00",
            RequestForInfoEmail: "procurement@dc.gov",
          },
          {
            SolicitationNumber: "CLOSED",
            BidStatus: "CLOSED",
            IsAvailableToPublic: true,
          },
        ],
      }),
  });
  const ddot = await fetchEastCoastDotSource(
    "district-dot-open-solicitations",
    { fetchImpl: ddotFetch, now: NOW },
  );
  assert.equal(ddot.projects.length, 1);
  assert.equal(ddot.projects[0].sourceRecordId, "DCKA-2026-B-0008");
  assert.equal(ddot.projects[0].participants[0].email, "procurement@dc.gov");
  assert.match(ddot.projects[0].sourceUrl, /SolicitationLocationsDetail/);
});
