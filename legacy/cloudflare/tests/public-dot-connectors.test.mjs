import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync, strToU8, zipSync } from "fflate";

const {
  PUBLIC_DOT_SOURCE_IDS,
  PUBLIC_DOT_SOURCE_TEMPLATES,
  fetchPublicDotSource,
  lookupPublicDotSourceProject,
} = await import("../app/lib/public-dot-connectors.ts");

const NOW = () => new Date("2026-07-20T12:00:00.000Z");

function fixtureFetch(routes) {
  const requests = [];
  const fetchImpl = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url).toString();
    requests.push(url);
    const body = routes[url];
    if (body === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  fetchImpl.requests = requests;
  return fetchImpl;
}

function assertOfficialFiles(project, hosts) {
  const fileDocuments = project.documents.filter(
    (document) => document.kind !== "source-record",
  );
  assert.ok(fileDocuments.length > 0, "expected at least one downloadable file");
  for (const document of fileDocuments) {
    const url = new URL(document.url);
    assert.equal(url.protocol, "https:");
    assert.ok(hosts.includes(url.hostname), `unexpected document host ${url.hostname}`);
    assert.ok(
      /\.(?:pdf|zip|dgn|dwg|xml|kmz|xlsx?|docx?|ebsx?|00\dx?)$/i.test(
        decodeURIComponent(url.pathname),
      ) || /BC_CONST_NOTICE_ADMIN\.VIEWFILE/i.test(url.pathname),
      `landing page was incorrectly emitted as a file: ${document.url}`,
    );
  }
}

test("the public DOT registry exposes stable, official HTTPS sources", () => {
  assert.deepEqual(PUBLIC_DOT_SOURCE_IDS, [
    "washington-dot-contracting-opportunities",
    "illinois-dot-transportation-bulletin",
    "texas-dot-state-let-construction",
    "new-york-dot-construction-contracts",
    "north-carolina-dot-highway-lettings",
    "iowa-dot-plans-estimating-proposals",
    "florida-dot-statewide-lettings",
    "virginia-dot-cabb-advertisements",
    "michigan-dot-bid-lettings",
    "ohio-dot-filed-construction-projects",
    "pennsylvania-dot-ecms-bid-packages",
    "massachusetts-dot-advertised-projects",
    "delaware-dot-open-solicitations",
    "maryland-sha-contract-advertising-schedule",
    "south-carolina-dot-construction-lettings",
    "georgia-dot-construction-letting-calendar",
    "district-dot-open-solicitations",
  ]);
  for (const sourceId of PUBLIC_DOT_SOURCE_IDS) {
    const template = PUBLIC_DOT_SOURCE_TEMPLATES[sourceId];
    assert.equal(template.id, sourceId);
    assert.equal(template.level, "state");
    assert.equal(template.sourceClass, "procurement");
    assert.equal(new URL(template.url).protocol, "https:");
  }
});

test("default interactive views share one five-minute source snapshot while ingest bypasses", { concurrency: false }, async () => {
  const sourceId = "washington-dot-contracting-opportunities";
  const searchUrl =
    "https://wsdot.wa.gov/business-wsdot/contracts/search-contracting-opportunities?page=0";
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url).toString();
    assert.equal(url, searchUrl);
    requestCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return new Response("<html><body>No advertised records</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  try {
    const first = fetchPublicDotSource(sourceId);
    const concurrent = fetchPublicDotSource(sourceId, {
      mode: "view",
      sourceId,
    });
    assert.strictEqual(
      concurrent,
      first,
      "concurrent default views must share the same in-flight promise",
    );
    const [firstResult, concurrentResult] = await Promise.all([
      first,
      concurrent,
    ]);
    assert.strictEqual(concurrentResult, firstResult);
    assert.equal(requestCount, 1);

    const cached = fetchPublicDotSource(sourceId);
    assert.strictEqual(cached, first);
    assert.strictEqual(await cached, firstResult);
    assert.equal(requestCount, 1);

    await fetchPublicDotSource(sourceId, { mode: "ingest" });
    assert.equal(
      requestCount,
      2,
      "ingestion must bypass the interactive snapshot cache",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed default view is shared briefly as a rejection and never reported healthy", { concurrency: false }, async () => {
  const sourceId = "north-carolina-dot-highway-lettings";
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return new Response("temporary upstream failure", { status: 503 });
  };
  try {
    const first = fetchPublicDotSource(sourceId);
    const concurrent = fetchPublicDotSource(sourceId);
    assert.strictEqual(concurrent, first);
    const settled = await Promise.allSettled([first, concurrent]);
    assert.deepEqual(
      settled.map((result) => result.status),
      ["rejected", "rejected"],
    );
    assert.equal(requestCount, 1);

    const degradedSnapshot = fetchPublicDotSource(sourceId);
    assert.strictEqual(degradedSnapshot, first);
    await assert.rejects(() => degradedSnapshot, /HTTP 503/);
    assert.equal(requestCount, 1);

    await assert.rejects(
      () => fetchPublicDotSource(sourceId, { mode: "ingest" }),
      /HTTP 503/,
    );
    assert.equal(requestCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WSDOT joins an advertised opportunity to official plans, addenda, and contact data", async () => {
  const searchUrl =
    "https://wsdot.wa.gov/business-wsdot/contracts/search-contracting-opportunities?page=0";
  const detailUrl =
    "https://wsdot.wa.gov/business-wsdot/contracting-opportunities/sr-512-corridor";
  const archiveUrl = "https://ftp.wsdot.wa.gov/contracts/";
  const projectFolder =
    "https://ftp.wsdot.wa.gov/contracts/XE3758-SR512Corridor/";
  const plansFolder = `${projectFolder}Plans&Specifications/`;
  const addendaFolder = `${projectFolder}Addenda/`;
  const fetchImpl = fixtureFetch({
    [searchUrl]: `
      <h2><a href="/business-wsdot/contracting-opportunities/sr-512-corridor">SR 512 Corridor Congestion Management</a></h2>
      <p>Publication date: July 10, 2026</p>
      <p>Contract number: XE3758</p>
      <p>Submittal due: July 30, 2026 3:00 PM</p>
      <p>Status: Advertised</p>
      <p>County: Pierce County</p>
      <p>Description: Install roadway detection, fiber, signing, and traffic-management equipment along SR 512.</p>`,
    [detailUrl]: `
      <h1>SR 512 Corridor Congestion Management</h1>
      <p>Project Description: Install roadway detection, fiber, signing, and traffic-management equipment.</p>
      <p>Contract Contact: Jane Engineer, 360-555-0101,
        <a href="mailto:jane.engineer@wsdot.wa.gov">jane.engineer@wsdot.wa.gov</a>
      </p>
      <a href="https://untrusted.example/plans.pdf">Not official</a>`,
    [archiveUrl]: `<a href="XE3758-SR512Corridor/">XE3758-SR512Corridor/</a>`,
    [projectFolder]: `
      <a href="Plans&Specifications/">Plans &amp; Specifications/</a>
      <a href="Addenda/">Addenda/</a>`,
    [plansFolder]: `
      <a href="XE3758-Plans.pdf">XE3758 Plans.pdf</a>
      <a href="XE3758-Special-Provisions.pdf">XE3758 Special Provisions.pdf</a>`,
    [addendaFolder]: `<a href="XE3758-Addendum-1.pdf">XE3758 Addendum 1.pdf</a>`,
  });

  const result = await fetchPublicDotSource(
    "washington-dot-contracting-opportunities",
    { fetchImpl, now: NOW },
  );
  assert.equal(result.source.status, "live");
  assert.equal(result.projects.length, 1);
  const project = result.projects[0];
  assert.equal(project.sourceRecordId, "XE3758");
  assert.equal(project.bidDate, "2026-07-30T15:00:00");
  assert.match(project.summary, /roadway detection/i);
  assert.ok(project.participants.some((person) => person.email === "jane.engineer@wsdot.wa.gov"));
  assert.deepEqual(
    new Set(project.documents.map((document) => document.kind)),
    new Set(["source-record", "plans", "specifications", "addendum"]),
  );
  assertOfficialFiles(project, ["wsdot.wa.gov", "ftp.wsdot.wa.gov"]);
  assert.ok(!project.documents.some((document) => document.url.includes("untrusted.example")));

  const exact = await lookupPublicDotSourceProject(
    "washington-dot-contracting-opportunities",
    project.id,
    { fetchImpl, now: NOW },
  );
  assert.equal(exact?.sourceRecordId, "XE3758");
});

test("IDOT joins the current active letting row to its ePlan package and excludes review-only work", async () => {
  const homeUrl = "https://webapps1.dot.illinois.gov/WCTB/LbHome";
  const lettingUrl =
    "https://webapps1.dot.illinois.gov/WCTB/LbLettingDetail/Index/letting-guid";
  const detailUrl =
    "https://webapps1.dot.illinois.gov/WCTB/LbContractDetail/Index/letting-guid?contractId=contract-guid";
  const reviewUrl =
    "https://webapps1.dot.illinois.gov/WCTB/LbContractDetail/Index/letting-guid?contractId=review-guid";
  const eplanRoot = "https://apps.dot.illinois.gov/eplan/desenv/073126/";
  const projectFolder = `${eplanRoot}001-62J64/`;
  const plansFolder = `${projectFolder}PLANS/`;
  const addendaFolder = `${projectFolder}ADDENDA/`;
  const fetchImpl = fixtureFetch({
    [homeUrl]: `<a href="/WCTB/LbLettingDetail/Index/letting-guid">July 31, 2026 Letting</a>`,
    [lettingUrl]: `
      <h1>July 31, 2026 Letting 12:00 PM</h1>
      <a href="https://apps.dot.illinois.gov/eplan/desenv/073126/">ePlan files</a>
      <table>
        <tr><td><a href="/WCTB/LbContractDetail/Index/letting-guid?contractId=contract-guid">001-62J64</a></td><td>Active</td><td>Bridge deck replacement and approach roadway reconstruction on Interstate 80.</td></tr>
        <tr><td><a href="/WCTB/LbContractDetail/Index/letting-guid?contractId=review-guid">002-62ZZZ</a></td><td>Active</td><td>Review project.</td></tr>
      </table>`,
    [detailUrl]: `
      <p>Project Description: Bridge deck replacement and approach roadway reconstruction.</p>
      <p>Counties: Will County District 1</p>
      <p>Contact: Alex Bidder <a href="mailto:alex.bidder@illinois.gov">Email</a> (217) 555-0102</p>`,
    [reviewUrl]: `<p>For Review and Inspection Only. This project is NOT FOR BID.</p>`,
    [eplanRoot]: `
      <a href="001-62J64/">001-62J64/</a>
      <a href="002-62ZZZ/">002-62ZZZ/</a>`,
    [projectFolder]: `
      <a href="62J64-Specifications.pdf">62J64 Specifications.pdf</a>
      <a href="PLANS/">PLANS/</a>
      <a href="ADDENDA/">ADDENDA/</a>`,
    [plansFolder]: `<a href="PL-62J64-001.pdf">PL-62J64-001.pdf</a>`,
    [addendaFolder]: `<a href="62J64-Addendum-1.pdf">62J64 Addendum 1.pdf</a>`,
  });

  const result = await fetchPublicDotSource(
    "illinois-dot-transportation-bulletin",
    { fetchImpl, now: NOW },
  );
  assert.equal(result.projects.length, 1);
  const project = result.projects[0];
  assert.equal(project.sourceRecordId, "001-62J64");
  assert.equal(project.bidDate, "2026-07-31T12:00:00");
  assert.match(project.summary, /Bridge deck replacement/i);
  assert.ok(project.participants.some((person) => person.email === "alex.bidder@illinois.gov"));
  assert.deepEqual(
    new Set(project.documents.map((document) => document.kind)),
    new Set(["source-record", "plans", "specifications", "addendum"]),
  );
  assertOfficialFiles(project, ["apps.dot.illinois.gov"]);
});

test("IDOT paginates before detail hydration and never exceeds three sibling requests", async () => {
  const sourceId = "illinois-dot-transportation-bulletin";
  const homeUrl = "https://webapps1.dot.illinois.gov/WCTB/LbHome";
  const lettingUrl =
    "https://webapps1.dot.illinois.gov/WCTB/LbLettingDetail/Index/page-test";
  const recordIds = Array.from(
    { length: 25 },
    (_, index) =>
      `${String(index + 1).padStart(3, "0")}-62${String(index + 1).padStart(3, "0")}`,
  );
  const detailUrls = recordIds.map(
    (recordId) =>
      `https://webapps1.dot.illinois.gov/WCTB/LbContractDetail/Index/page-test?contractId=${recordId}`,
  );
  const rows = recordIds.map(
    (recordId) => `
      <tr>
        <td><a href="/WCTB/LbContractDetail/Index/page-test?contractId=${recordId}">${recordId}</a></td>
        <td>Active</td>
        <td>Roadway reconstruction for contract ${recordId}.</td>
      </tr>`,
  ).join("");
  const detailRequests = [];
  let activeDetailRequests = 0;
  let maxActiveDetailRequests = 0;
  const fetchImpl = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url).toString();
    if (url === homeUrl) {
      return new Response(
        `<a href="/WCTB/LbLettingDetail/Index/page-test">July 31, 2026 Letting</a>`,
        { status: 200 },
      );
    }
    if (url === lettingUrl) {
      return new Response(
        `<h1>July 31, 2026 Letting 12:00 PM</h1><table>${rows}</table>`,
        { status: 200 },
      );
    }
    if (detailUrls.includes(url)) {
      detailRequests.push(url);
      activeDetailRequests += 1;
      maxActiveDetailRequests = Math.max(
        maxActiveDetailRequests,
        activeDetailRequests,
      );
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeDetailRequests -= 1;
      const recordId = new URL(url).searchParams.get("contractId");
      return new Response(
        `<p>Project Description: Roadway reconstruction for ${recordId}.</p><p>Counties: Cook County District 1</p>`,
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  };

  const result = await fetchPublicDotSource(sourceId, {
    fetchImpl,
    now: NOW,
    sourceCursors: { [sourceId]: { offset: 20 } },
  });

  assert.deepEqual(
    result.projects.map((project) => project.sourceRecordId),
    recordIds.slice(20),
    "concurrent hydration must preserve bulletin order",
  );
  assert.equal(result.page.offset, 20);
  assert.equal(result.page.recordsRead, 5);
  assert.deepEqual(
    [...detailRequests].sort(),
    detailUrls.slice(20).sort(),
    "only the selected cursor page may trigger detail requests",
  );
  assert.ok(maxActiveDetailRequests > 1, "selected details should run concurrently");
  assert.ok(
    maxActiveDetailRequests <= 3,
    `expected at most three sibling requests, saw ${maxActiveDetailRequests}`,
  );
});

test("NYSDOT and NCDOT emit only current advertised contracts with direct official files", async () => {
  const nyMaster =
    "https://www.dot.ny.gov/doing-business/opportunities/const-notices";
  const nyDetail =
    "https://www.dot.ny.gov/doing-business/opportunities/const-contract-docs?p_d_id=D265689";
  const nyFetch = fixtureFetch({
    [nyMaster]: `<div><a href="/doing-business/opportunities/const-contract-docs?p_d_id=D265689">D265689</a> August 7, 2026</div>`,
    [nyDetail]: `
      <p>Project Description: Replace two bridge decks and rehabilitate highway drainage in Albany County.</p>
      <p>Contact <a href="mailto:contracts@dot.ny.gov">contracts@dot.ny.gov</a></p>
      <a href="/portal/pls/portal/MEXIS_APP.BC_CONST_NOTICE_ADMIN.VIEWFILE?p_file_id=100&p_is_digital=Y">D265689 Plans Volume 1.pdf</a>
      <a href="/portal/pls/portal/MEXIS_APP.BC_CONST_NOTICE_ADMIN.VIEWFILE?p_file_id=101&p_is_digital=Y">D265689 Proposal Book.pdf</a>`,
  });
  const ny = await fetchPublicDotSource("new-york-dot-construction-contracts", {
    fetchImpl: nyFetch,
    now: NOW,
  });
  assert.equal(ny.projects.length, 1);
  assert.equal(ny.projects[0].sourceRecordId, "D265689");
  assert.equal(ny.projects[0].bidDate, "2026-08-07");
  assert.match(ny.projects[0].summary, /bridge decks/i);
  assertOfficialFiles(ny.projects[0], ["www.dot.ny.gov"]);

  const ncCentral = "https://connect.ncdot.gov/letting/pages/central.aspx";
  const ncDetail =
    "https://connect.ncdot.gov/letting/Pages/Letting-Details.aspx?let_date=08/19/2026&let_type=6";
  const ncFetch = fixtureFetch({
    [ncCentral]: `<a href="/letting/Pages/Letting-Details.aspx?let_date=08/19/2026&amp;let_type=6">August 19, 2026 Division 6 Letting</a>`,
    [ncDetail]: `
      <table><tr><td>DF00556</td><td>Resurfacing, guardrail, and pavement-marking improvements on NC 210.</td></tr></table>
      <a href="/letting/Division%206%20Letting/8-19-2026/DF00556-Plans.pdf">DF00556 Plans.pdf</a>
      <a href="/letting/Division%206%20Letting/8-19-2026/DF00556-Proposal.pdf">DF00556 Proposal.pdf</a>
      <a href="/letting/Division%206%20Letting/8-19-2026/DF00556-Addendum-1.pdf">DF00556 Addendum 1.pdf</a>`,
  });
  const nc = await fetchPublicDotSource("north-carolina-dot-highway-lettings", {
    fetchImpl: ncFetch,
    now: NOW,
  });
  assert.equal(nc.projects.length, 1);
  assert.equal(nc.projects[0].sourceRecordId, "DF00556");
  assert.equal(nc.projects[0].bidDate, "2026-08-19");
  assert.match(nc.projects[0].summary, /Resurfacing/i);
  assertOfficialFiles(nc.projects[0], ["connect.ncdot.gov"]);
});

test("Iowa DOT emits current project rows with open plans and estimating-proposal ZIP packages", async () => {
  const sourceId = "iowa-dot-plans-estimating-proposals";
  const masterUrl =
    "https://iowadot.gov/consultants-contractors/contracts/plans-estimation-proposals";
  const regularUrl = "https://ia.iowadot.gov/contracts/biddocuments/July2026";
  const specialUrl =
    "https://ia.iowadot.gov/contracts/biddocuments/july282026specialletting";
  const fetchImpl = fixtureFetch({
    [masterUrl]: `
      <h2>2026 Electronic Plans &amp; Proposals</h2>
      <a href="https://ia.iowadot.gov/contracts/biddocuments/july282026specialletting">July 28, 2026 Special Letting</a>
      <a href="https://ia.iowadot.gov/contracts/biddocuments/July2026">July 2026 Letting</a>
      <a href="https://ia.iowadot.gov/contracts/biddocuments/June2026">June 2026 Letting</a>`,
    [regularUrl]: `
      <table><tr><th>Bid Order</th><th>Proposal ID</th><th>County</th><th>Project Number</th><th>Download</th></tr>
      <tr><td>001</td><td>00-000T-460</td><td>STATEWIDE</td><td>BRFN-000-T(460)--39-00</td><td>
        <a href="https://secure.iowadot.gov/contracts/july_2026_letting/21JUL001.zip"><img alt="Download zip file"></a>
        <a href="https://secure.iowadot.gov/contracts/july_2026_letting/001_00-000T-460_eFiles_(Bridge).zip"><img alt="Bridge files"></a>
      </td></tr></table>`,
    [specialUrl]: `
      <table><tr><th>Bid Order</th><th>Proposal ID</th><th>County</th><th>Project Number</th><th>Download</th></tr>
      <tr><td>401</td><td>77-0352-490</td><td>POLK</td><td>NHS-035-2(490)72--11-77</td><td>
        <a href="https://secure.iowadot.gov/contracts/july_28_2026_special_letting/28JUL001.zip"><img alt="Download zip file"></a>
      </td></tr></table>`,
  });

  const result = await fetchPublicDotSource(sourceId, { fetchImpl, now: NOW });
  assert.equal(result.source.recordCount, 2);
  assert.deepEqual(
    result.projects.map((project) => project.sourceRecordId),
    ["00-000T-460", "77-0352-490"],
  );
  assert.deepEqual(
    result.projects.map((project) => project.bidDate),
    ["2026-07-21", "2026-07-28"],
  );
  assert.match(result.projects[0].title, /Structures/);
  assert.match(result.projects[1].title, /Buildings and sites/);
  assert.ok(
    result.projects.every((project) =>
      project.participants.some(
        (participant) => participant.email === "dot.contracts@iowadot.us",
      )
    ),
  );
  for (const project of result.projects) {
    assert.ok(
      project.documents.some(
        (document) =>
          document.kind === "plans" &&
          document.access === "public" &&
          new URL(document.url).hostname === "secure.iowadot.gov",
      ),
    );
    assert.ok(
      project.documents.some(
        (document) =>
          document.access === "free-account" &&
          document.indexStatus === "account-gated",
      ),
    );
  }
});

test("FDOT joins current statewide advertised proposals to public district documents and honest gated-plan links", async () => {
  const sourceId = "florida-dot-statewide-lettings";
  const centralUrl =
    "https://www.fdot.gov/contracts/lettings/letting-project-info.shtm";
  const districtThreeUrl =
    "https://www.fdot.gov/contracts/district-offices/d3/lettings/dist-letting-project-info.shtm";
  const proposals = [
    {
      proposalName: "T5889",
      proposalLongDescription:
        "Resurface the corridor and replace roadway lighting in Brevard County.",
      proposalShortDescription: " - RESURFACING",
      proposalStatus: "Advertised",
      proposalPublicationDate: "2026-07-10T00:00:00",
      proposalCounty: "BREVARD",
      proposalDistrictId: 72,
      proposalDistrictName: "District 5",
      lettingDate: "2026-07-29T00:00:00",
      lettingTime: "10:30 AM",
      lettingStatus: "Scheduled",
      isAdvertised: true,
      projects: [
        {
          projectName: "44709215201",
          projectDescription: "SR 5 resurfacing and lighting",
          isControllingProject: true,
        },
      ],
    },
    {
      proposalName: "E3Y64",
      proposalLongDescription:
        "Remove and replace bridge coating systems in Gulf County.",
      proposalShortDescription: " - BRIDGE - PAINTING",
      proposalStatus: "Advertised",
      proposalPublicationDate: "2026-07-14T00:00:00",
      proposalCounty: "GULF",
      proposalDistrictId: 70,
      proposalDistrictName: "District 3",
      lettingDate: "2026-08-13T00:00:00",
      lettingTime: "11:00 AM",
      lettingStatus: "Scheduled",
      isAdvertised: true,
      projects: [{ projectName: "21904235201", isControllingProject: true }],
    },
    {
      proposalName: "T5000",
      proposalStatus: "Advertised",
      proposalDistrictId: 72,
      lettingDate: "2026-07-15T00:00:00",
      lettingTime: "10:30 AM",
      lettingStatus: "Scheduled",
      isAdvertised: true,
    },
    {
      proposalName: "T5883",
      proposalStatus: "Withdrawn",
      proposalDistrictId: 72,
      lettingDate: "2026-08-26T00:00:00",
      lettingTime: "10:30 AM",
      lettingStatus: "Scheduled",
      isAdvertised: false,
    },
  ];
  const requests = [];
  const fetchImpl = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    requests.push(url.toString());
    if (url.hostname === "bqa.fdot.gov" && url.pathname === "/api/v1/proposal/search") {
      assert.equal(url.searchParams.get("letting-begin"), "2026-07-20");
      assert.equal(url.searchParams.get("letting-end"), "2027-07-21");
      return Response.json(proposals);
    }
    if (url.pathname === "/api/v1/settings/district/70") {
      return Response.json({ districtPhone: "8503301250" });
    }
    if (url.pathname === "/api/v1/settings/district/72") {
      return Response.json({ districtPhone: "3869435400" });
    }
    if (url.toString() === centralUrl) {
      return new Response(`<table><tr>
        <td><a href="https://ftp.fdot.gov/public/file/current/T5889BSN.pdf">T5889</a></td>
        <td>Brevard</td><td>Resurfacing</td>
        <td><a href="https://ftp.fdot.gov/public/file/current/T5889Addendum001.pdf">1</a></td>
      </tr></table>`, { status: 200 });
    }
    if (url.toString() === districtThreeUrl) {
      return new Response(`<table><tr>
        <td><a href="https://fdotwww.blob.core.windows.net/sitefinity/docs/e3y64.pdf">E3Y64</a></td>
        <td>Gulf</td><td>Bridge Painting</td><td></td>
      </tr></table>`, { status: 200 });
    }
    if (url.hostname === "www.fdot.gov") {
      return new Response("<table></table>", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const result = await fetchPublicDotSource(sourceId, { fetchImpl, now: NOW });
  assert.equal(result.source.recordCount, 2);
  assert.equal(result.projects.length, 2);
  assert.deepEqual(
    result.projects.map((project) => project.sourceRecordId),
    ["T5889", "E3Y64"],
  );
  const [centralProject, districtProject] = result.projects;
  assert.equal(result.source.status, "live");
  assert.equal(result.source.snapshotComplete, true);
  assert.equal(centralProject.bidDate, "2026-07-29T10:30:00");
  assert.equal(districtProject.bidDate, "2026-08-13T11:00:00");
  assert.equal(centralProject.bidDateTimeZone, "America/New_York");
  assert.equal(districtProject.bidDateTimeZone, "America/Chicago");
  assert.match(centralProject.summary, /roadway lighting/i);
  assert.match(districtProject.summary, /coating systems/i);
  assert.match(centralProject.summary, /44709215201/);
  assert.ok(
    centralProject.participants.some(
      (participant) => participant.phone === "386-943-5400",
    ),
  );
  assert.ok(
    centralProject.documents.some(
      (document) =>
        document.kind === "addendum" &&
        document.access === "public" &&
        new URL(document.url).hostname === "ftp.fdot.gov",
    ),
  );
  assert.ok(
    districtProject.documents.some(
      (document) => new URL(document.url).hostname === "fdotwww.blob.core.windows.net",
    ),
  );
  assert.ok(
    result.projects.every((project) =>
      project.documents.some(
        (document) =>
          document.kind === "plans" &&
          document.access === "free-account" &&
          document.indexStatus === "account-gated" &&
          document.url === "https://cpp.fdot.gov/",
      )
    ),
  );
  assert.equal(
    result.projects.some((item) => ["T5000", "T5883"].includes(item.sourceRecordId)),
    false,
  );
  assert.equal(
    requests.filter((url) => new URL(url).hostname === "www.fdot.gov").length,
    9,
  );
});

test("FDOT marks a statewide snapshot degraded when an official document index is unavailable", async () => {
  const sourceId = "florida-dot-statewide-lettings";
  const centralUrl =
    "https://www.fdot.gov/contracts/lettings/letting-project-info.shtm";
  const fetchImpl = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/api/v1/proposal/search") {
      return Response.json([
        {
          proposalName: "E3Y64",
          proposalLongDescription: "Bridge painting",
          proposalShortDescription: "Bridge painting",
          proposalStatus: "Advertised",
          proposalCounty: "GULF",
          proposalDistrictId: 70,
          proposalDistrictName: "District 3",
          lettingDate: "2026-08-13T00:00:00",
          lettingTime: "11:00 AM",
          lettingStatus: "Scheduled",
          isAdvertised: true,
        },
      ]);
    }
    if (url.pathname === "/api/v1/settings/district/70") {
      return Response.json({ districtPhone: "8503301250" });
    }
    if (url.toString() === centralUrl) {
      return new Response("temporarily unavailable", { status: 503 });
    }
    if (url.hostname === "www.fdot.gov") {
      return new Response("<table></table>", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const result = await fetchPublicDotSource(sourceId, { fetchImpl, now: NOW });
  assert.equal(result.projects.length, 1);
  assert.equal(result.source.status, "degraded");
  assert.equal(result.source.snapshotComplete, false);
  assert.match(result.source.note, /1 document index/);
});

test("VDOT CABB follows the official WebForms pager and emits notices, contact, scope, value, advertisement, and gated e-plans", async () => {
  const sourceId = "virginia-dot-cabb-advertisements";
  const listUrl =
    "https://cabb.virginiadot.org/AdProjectInfoList.aspx?ADVAWD=1";
  const pagerTarget =
    "_ctl0$_ctl0$body$body$projectlistControl$projectsDatapager$datapager$_ctl1$_ctl1";
  const pageOne = `
    <form>
      <input type="hidden" name="__VIEWSTATE" value="state-one">
      <input type="hidden" name="__EVENTVALIDATION" value="validation-one">
      <a href="javascript:__doPostBack('${pagerTarget}','')">2</a>
      <div>Displaying results 1 - 20 (of 22)</div>
    </form>`;
  const pageTwo = `
      <div>Displaying results 21 - 22 (of 22)</div>
    <table>
      <tr id="projectlistControl_row1_12735" class="Aqua_VDOTDataTD">
        <td></td>
        <td><a href="AdQADisplayFormat.aspx?AD_PRJ_ID=12735">Questions</a></td>
        <td><a href="upload/20260714050613JUL-A03.pdf">A03</a></td>
        <td><a href="javascript:void(0)" onclick="projectlistControl_openNoticesView(12735)">2 Notices</a></td>
        <td><a href="ProjectWise.aspx?upc=119218&amp;advNumber=A03">EPLANS</a></td>
        <td></td>
        <td>8/26/2026</td>
        <td>0058-087-703,C501</td>
        <td>58</td>
        <td>SOUTHAMPTON</td>
        <td>$3,878,000.00</td>
        <td>SMART SCALE - INTERSECTION IMPROVEMENT</td>
        <td>0.082 Mi. W. Of Camp Parkway</td>
        <td>No Showing</td>
        <td>8/3/2027</td>
        <td></td><td></td><td></td><td></td><td></td>
      </tr>
      <tr id="projectlistControl_row2_12735" class="Aqua_VDOTDataTD">
        <td>119218</td><td>STP-087-5(063)</td><td>0.275 Mi. E. Of Camp Parkway</td>
      </tr>
      <tr id="projectlistControl_row1_12736" class="Aqua_VDOTDataTD">
        <td></td><td></td><td><a href="upload/cii.pdf">A62 (CII)</a></td><td></td>
        <td><a href="ProjectWise.aspx?upc=999">EPLANS</a></td><td></td><td>8/26/2026</td>
        <td>0000-000-000</td><td>1</td><td>FAIRFAX</td><td>$1,000.00</td><td>CONTROLLED PROJECT</td><td>Site</td>
      </tr>
      <tr id="projectlistControl_row2_12736" class="Aqua_VDOTDataTD"><td>999</td><td>FED</td><td>End</td></tr>
    </table>`;
  const requests = [];
  const noticeUrl =
    "https://cabb.virginiadot.org/AdNTCInfoView.aspx?ad_prj_id=12735";
  let noticeRequests = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url).toString();
    if (url === noticeUrl) {
      noticeRequests += 1;
      return new Response(`
        <a href="upload/20260720_A03_addendum.pdf">Revision</a>
        <a href="upload/20260721_A03_delay.pdf">Delayed</a>`, { status: 200 });
    }
    assert.equal(url, listUrl);
    requests.push({ method: init.method ?? "GET", headers: init.headers, body: init.body });
    if ((init.method ?? "GET") === "POST") {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("__VIEWSTATE"), "state-one");
      assert.equal(body.get("__EVENTVALIDATION"), "validation-one");
      assert.equal(body.get("__EVENTTARGET"), pagerTarget);
      assert.match(JSON.stringify(init.headers), /ASP\.NET_SessionId=session-one/);
      return new Response(pageTwo, { status: 200 });
    }
    return new Response(pageOne, {
      status: 200,
      headers: { "set-cookie": "ASP.NET_SessionId=session-one; path=/; HttpOnly" },
    });
  };

  const result = await fetchPublicDotSource(sourceId, {
    fetchImpl,
    now: NOW,
    sourceCursors: { [sourceId]: { offset: 20 } },
  });
  assert.deepEqual(requests.map((request) => request.method), ["GET", "POST"]);
  assert.equal(noticeRequests, 1);
  assert.equal(result.source.recordCount, 22);
  assert.equal(result.source.recordCountUnit, "rows");
  assert.equal(result.page.offset, 20);
  assert.equal(result.page.recordsRead, 2);
  assert.equal(result.page.hasMore, false);
  assert.equal(result.projects.length, 1, "CII rows must remain excluded");
  const project = result.projects[0];
  assert.equal(project.sourceRecordId, "12735-A03");
  assert.equal(project.bidDate, "2026-08-26");
  assert.equal(project.county, "SOUTHAMPTON");
  assert.equal(project.value, 3_878_000);
  assert.match(project.summary, /INTERSECTION IMPROVEMENT/);
  assert.match(project.summary, /UPC 119218/);
  assert.ok(
    project.participants.some(
      (participant) =>
        participant.email === "kiwi.roane@vdot.virginia.gov" &&
        participant.phone === "804-786-2124",
    ),
  );
  assert.ok(
    project.documents.some(
      (document) =>
        document.url.endsWith("20260714050613JUL-A03.pdf") &&
        document.access === "public",
    ),
  );
  assert.ok(
    project.documents.some(
      (document) =>
        document.kind === "plans" &&
        document.access === "free-account" &&
        document.indexStatus === "account-gated",
    ),
  );
  assert.ok(
    project.documents.some(
      (document) =>
        document.kind === "addendum" &&
        decodeURIComponent(document.url).endsWith("20260720_A03_addendum.pdf"),
    ),
  );
  assert.ok(
    project.documents.some(
      (document) =>
        document.url === noticeUrl && document.indexStatus === "metadata-only",
    ),
  );
});

test("Michigan DOT decodes revisions and retains good lettings when one archive fails", async () => {
  const sourceId = "michigan-dot-bid-lettings";
  const masterUrl =
    "https://mdotjboss.state.mi.us/BidLetting/BidLettingHome.htm";
  const detailUrl =
    "https://mdotjboss.state.mi.us/BidLetting/getLettingInfo.htm?letting=2026-08-07&index=1";
  const xml = `<?xml version="1.0"?>
    <EBSXContainer xmlns="http://tempuri.org/XMLSchema">
      <EBSX><Letting>
        <LettingId>260807</LettingId>
        <CallOrder>010</CallOrder>
        <LettingDateTime>2026-08-07T10:30:00</LettingDateTime>
        <LettingStatusValue>Scheduled</LettingStatusValue>
        <ProposalStatusValue>Advertised</ProposalStatusValue>
        <LetpropDate>7/10/2026</LetpropDate>
        <Proposal>
          <ContractId>25000-220001</ContractId>
          <ControllingPCN>220001A</ControllingPCN>
          <ControllingProjNum>26A0700</ControllingProjNum>
          <WorkTypeValue>Bridge Rehabilitation</WorkTypeValue>
          <ShortDescription>Bridge rehabilitation and approach work.</ShortDescription>
          <Description>Bridge rehabilitation, concrete repairs, guardrail, drainage, and pavement markings.</Description>
          <County><Name>Genesee County</Name><Id>25</Id></County>
          <Section><Item>
            <ItemNumber>2080001</ItemNumber>
            <ItemClass>Earthwork</ItemClass>
            <DescriptionIDESCRL>Erosion control blanket</DescriptionIDESCRL>
          </Item></Section>
        </Proposal>
      </Letting></EBSX>
    </EBSXContainer>`;
  const archive = zipSync({
    "25000-220001.ebsx": gzipSync(strToU8(xml)),
    "25000-220001.001x": gzipSync(
      strToU8(xml.replace("Bridge rehabilitation, concrete repairs", "Revised bridge rehabilitation, concrete repairs")),
    ),
  });
  const requests = [];
  const fetchImpl = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    requests.push(url.toString());
    if (url.toString() === masterUrl) {
      return new Response(`
        <input class="btn lettingButtons" title="2026-08-07" onclick="window.location.assign('getLettingInfo.htm?letting=2026-08-07&amp;index=1')">
        <input class="btn lettingButtons" title="2026-09-04" onclick="window.location.assign('getLettingInfo.htm?letting=2026-09-04&amp;index=0')">
        <input class="btn lettingButtons" title="2026-07-10" onclick="window.location.assign('getLettingInfo.htm?letting=2026-07-10&amp;index=3')">`);
    }
    if (url.toString() === detailUrl) {
      return new Response(`
        <a href="getFileByName.htm?fileName=2026-08-07/ads.pdf">Advertisements</a>
        <a href="getFileByName.htm?fileName=2026-08-07/addendum.pdf">Addendums</a>
        <a href="getFileByName.htm?fileName=2026-08-07/estqua.pdf">Schedule of Pay Items</a>
        <a href="getFileByName.htm?fileName=2026-08-07/bidders.pdf">Eligible Bidders</a>
        <a href="getFileByName.htm?fileName=2026-08-07/hldrs.pdf">Plan Holders</a>
        <a href="getFileByName.htm?fileName=2026-08-07/ebsx.zip">EBSX ZIP</a>
        <span data-cfemail="5f121b100b721d363b133a2b2b3631381f32363c3736383e3171383029"></span>`);
    }
    if (
      url.pathname === "/BidLetting/getFileByName.htm" &&
      url.searchParams.get("fileName") === "2026-08-07/ebsx.zip"
    ) {
      return new Response(archive, {
        status: 200,
        headers: { "content-length": String(archive.byteLength) },
      });
    }
    return new Response("not found", { status: 404 });
  };

  const result = await fetchPublicDotSource(sourceId, { fetchImpl, now: NOW });
  assert.equal(
    result.source.recordCount,
    1,
    JSON.stringify({ requests, source: result.source }, null, 2),
  );
  assert.equal(result.projects.length, 1);
  assert.equal(result.source.status, "degraded");
  assert.equal(result.source.snapshotComplete, false);
  const project = result.projects[0];
  assert.equal(project.sourceRecordId, "25000-220001");
  assert.equal(project.bidDate, "2026-08-07T14:30:00.000Z");
  assert.equal(project.bidDateTimeZone, "America/Detroit");
  assert.equal(project.postedAt, "2026-07-10");
  assert.equal(project.county, "Genesee County");
  assert.match(project.title, /Bridge Rehabilitation/);
  assert.match(project.summary, /26A0700/);
  assert.match(project.summary, /Revised bridge rehabilitation/);
  assert.ok(project.searchableFields.includes("Erosion control blanket"));
  assert.ok(
    project.participants.some(
      (participant) => participant.email === "mdot-bidletting@michigan.gov",
    ),
  );
  assert.ok(
    project.documents.some(
      (document) =>
        document.name.includes("letting-wide addendums") &&
        document.kind === "source-record" &&
        document.access === "public",
    ),
  );
  assert.equal(project.documents.some((document) => document.kind === "addendum"), false);
  assert.ok(
    project.documents.some(
      (document) =>
        document.name.includes("EBSX") && document.access === "public",
    ),
  );
  assert.ok(
    project.documents.some(
      (document) =>
        document.kind === "plans" &&
        document.access === "free-account" &&
        document.indexStatus === "account-gated",
    ),
  );
  assert.equal(requests.some((url) => url.includes("letting=2026-07-10")), false);
});

test("Michigan DOT stops a chunked archive at the configured safety ceiling", async () => {
  const masterUrl =
    "https://mdotjboss.state.mi.us/BidLetting/BidLettingHome.htm";
  let cancelled = false;
  const fetchImpl = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.toString() === masterUrl) {
      return new Response(
        `<input class="btn lettingButtons" title="2026-08-07" onclick="window.location.assign('getLettingInfo.htm?letting=2026-08-07&amp;index=1')">`,
      );
    }
    if (url.pathname.endsWith("/getLettingInfo.htm")) {
      return new Response(
        `<a href="getFileByName.htm?fileName=2026-08-07/ebsx.zip">EBSX ZIP</a>`,
      );
    }
    if (url.pathname.endsWith("/getFileByName.htm")) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
            controller.enqueue(new Uint8Array([7, 8, 9, 10, 11, 12]));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    }
    return new Response("not found", { status: 404 });
  };
  const result = await fetchPublicDotSource("michigan-dot-bid-lettings", {
    fetchImpl,
    maxBinaryBytes: 8,
    now: NOW,
  });
  assert.equal(result.projects.length, 0);
  assert.equal(result.source.status, "degraded");
  assert.equal(cancelled, true);
});

test("public DOT fetches reject redirects outside the registered host allowlist", async () => {
  await assert.rejects(
    () =>
      fetchPublicDotSource("michigan-dot-bid-lettings", {
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://example.com/copied-archive.zip" },
          }),
        now: NOW,
      }),
    /unsafe redirect chain/,
  );
});
