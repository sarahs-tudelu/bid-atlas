import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

register(new URL("./ts-extension-loader.mjs", import.meta.url));

const {
  ProjectResearchError,
  parseResearchRequest,
} = await import("../app/lib/project-research/contracts.ts");
const { fetchOfficialText } = await import("../app/lib/project-research/network.ts");
const {
  extractCaltransContractDetail,
  extractGenericOfficialPage,
} = await import("../app/lib/project-research/extractors.ts");
const {
  getProjectResearchRecord,
} = await import("../app/lib/project-research/repository.ts");
const { triggerProjectResearch } = await import("../app/lib/project-research/service.ts");
const { classifyProjectFreshness } = await import("../app/lib/outreach-intelligence.ts");

const PUBLIC_DNS = async () => ["93.184.216.34"];

class PreparedStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new PreparedStatement(this.database, this.sql, values);
  }

  async run() {
    return this.database.prepare(this.sql).run(...this.values);
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }
}

class D1Fixture {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new PreparedStatement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function databaseFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  const files = (await readdir(new URL("../drizzle/", import.meta.url)))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const file of files) {
    const sql = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
  return { database, db: new D1Fixture(database) };
}

function researchSource(overrides = {}) {
  return {
    sourceId: "official-source",
    sourceLabel: "Official agency",
    url: "https://projects.example.gov/project/1",
    strategy: "generic-official-page",
    allowedHosts: ["projects.example.gov"],
    ...overrides,
  };
}

function nycCityRecordProject(requestId, overrides = {}) {
  const projectId = `nyc-city-record-construction-procurement:${requestId}`;
  return {
    id: projectId,
    sourceId: "nyc-city-record-construction-procurement",
    sourceRecordId: requestId,
    title: "COMMUNITY CENTER UPGRADES",
    summary: "PIN 85626B0001 · Solicitation · Construction Related Services",
    stage: "bidding",
    status: "Solicitation",
    agency: "Department of Citywide Administrative Services",
    city: "New York",
    state: "NY",
    postedAt: "2026-07-10T00:00:00.000Z",
    bidDate: "2026-07-20T14:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    sourceName: "NYC City Record procurement notices",
    sourceUrl: `https://a856-cityrecord.nyc.gov/RequestDetail/${requestId}`,
    provenance: "live-api",
    confidence: "official",
    documents: [],
    participants: [],
    ...overrides,
  };
}

function configuredPermitProject(sourceId, recordId, overrides = {}) {
  const templates = {
    "los-angeles-building-permits-submitted": {
      sourceName: "Los Angeles building permits submitted",
      agency: "Los Angeles Department of Building and Safety",
      city: "Los Angeles",
      state: "CA",
      sourceUrl: `https://data.lacity.org/resource/gwh9-jnip.json?%24where=permit_nbr+%3D+%27${encodeURIComponent(recordId)}%27&%24limit=1`,
    },
    "miami-ibuild-plan-review-arcgis": {
      sourceName: "City of Miami iBuild permit applications",
      agency: "City of Miami Building Department",
      city: "Miami",
      state: "FL",
      sourceUrl: `https://gis.miami.gov/gis/rest/services/Maps/iBuildPermits/MapServer/0/query?where=ApplicationNumber%3D%27${encodeURIComponent(recordId)}%27&outFields=*&f=json`,
    },
    "seattle-building-permits": {
      sourceName: "Seattle building permits",
      agency: "Seattle Department of Construction and Inspections",
      city: "Seattle",
      state: "WA",
      sourceUrl: `https://services.seattle.gov/portal/customize/LinkToRecord.aspx?altId=${encodeURIComponent(recordId)}`,
    },
  };
  const template = templates[sourceId];
  if (!template) throw new Error(`Unknown test permit source ${sourceId}`);
  const projectId = `${sourceId}:${recordId}`;
  return {
    id: projectId,
    sourceId,
    sourceRecordId: recordId,
    title: "New private residential building",
    summary: `${recordId} · 1 or 2 Family Dwelling`,
    stage: "design",
    status: "In Review",
    agency: template.agency,
    address: "100 Example Avenue",
    city: template.city,
    state: template.state,
    postalCode: "90001",
    value: 725000,
    postedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    sourceName: template.sourceName,
    sourceUrl: template.sourceUrl,
    provenance: "live-api",
    confidence: "official",
    documents: [
      {
        name: "Official permit data record",
        kind: "permit",
        url: template.sourceUrl,
        access: "public",
        indexStatus: "metadata-only",
      },
    ],
    participants: [
      {
        name: template.agency,
        role: "agency",
        participantType: "organization",
        organization: template.agency,
        sourceUrl: template.sourceUrl,
      },
    ],
    ...overrides,
  };
}

test("research request accepts only an optional force flag and no client source URL", () => {
  assert.deepEqual(parseResearchRequest(undefined), { force: false });
  assert.deepEqual(parseResearchRequest({ force: true }), { force: true });
  assert.throws(
    () => parseResearchRequest({ sourceUrl: "https://attacker.example/project" }),
    (error) => error instanceof ProjectResearchError && error.code === "invalid_research_request",
  );
});

test("official fetcher rejects private DNS and cross-allowlist redirects", async () => {
  let fetched = false;
  await assert.rejects(
    () => fetchOfficialText(
      "https://projects.example.gov/project/1",
      ["projects.example.gov"],
      {
        resolveHost: async () => ["127.0.0.1"],
        fetchImpl: async () => {
          fetched = true;
          return new Response("not reached");
        },
      },
    ),
    (error) => error instanceof ProjectResearchError && error.code === "unsafe_official_resolution",
  );
  assert.equal(fetched, false);

  await assert.rejects(
    () => fetchOfficialText(
      "https://projects.example.gov/project/1",
      ["projects.example.gov"],
      {
        resolveHost: PUBLIC_DNS,
        fetchImpl: async () => new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/plans" },
        }),
      },
    ),
    (error) => error instanceof ProjectResearchError && error.code === "unapproved_official_host",
  );
});

test("generic official-page extraction retains literal contact, document, scope, and lifecycle provenance", () => {
  const source = researchSource();
  const html = `
    <main>
      <p>Project Status: Advertised</p>
      <p>Scope of Work: Construct a new canopy and replace site lighting.</p>
      <p>Project Manager: Jane Smith Email: <a href="mailto:jane.smith@example.gov">jane.smith@example.gov</a> Phone: <a href="tel:+1-555-555-0199">Call the project office</a></p>
      <p>Procurement Contact: <a href="mailto:bids@example.gov">Email the bid desk</a></p>
      <p>The architect prepared the concept. General website email: architect-page@example.gov</p>
      <a href="/files/issued-plans.pdf">Issued Project Plans</a>
      <a href="/help/public-user-manual.pdf">Public User Manual</a>
      <a href="https://evil.example/stolen.pdf">Plans on an unapproved host</a>
      <footer>
        <a href="mailto:webmaster@example.gov">Webmaster</a>
        <a href="tel:+1-555-555-0100">General website help</a>
      </footer>
    </main>`;
  const result = extractGenericOfficialPage(
    html,
    source.url,
    source,
    "2026-07-16T18:00:00.000Z",
  );
  assert.equal(result.findings.some((finding) =>
    finding.kind === "contact" &&
    finding.email === "jane.smith@example.gov" &&
    finding.displayName === "Jane Smith" &&
    finding.role === "Project Manager"
  ), true);
  assert.equal(result.findings.some((finding) => finding.kind === "contact" && finding.phone === "+1-555-555-0199"), true);
  assert.equal(result.findings.some((finding) =>
    finding.kind === "contact" &&
    finding.email === "bids@example.gov" &&
    finding.displayName === undefined &&
    finding.role === "Procurement Contact" &&
    finding.confidence === 0.86
  ), true, "an explicitly role-labeled channel remains available without inventing a person");
  assert.equal(result.findings.some((finding) =>
    finding.kind === "contact" &&
    ["webmaster@example.gov", "architect-page@example.gov"].includes(finding.email ?? "") ||
    finding.phone === "+1-555-555-0100"
  ), false, "generic footer and webmaster channels are not project contacts");
  assert.equal(result.findings.some((finding) => finding.kind === "document" && finding.url === "https://projects.example.gov/files/issued-plans.pdf"), true);
  assert.equal(result.findings.some((finding) => finding.kind === "document" && finding.url.includes("evil.example")), false);
  assert.equal(result.findings.some((finding) => finding.kind === "document" && finding.name === "Public User Manual"), false);
  assert.equal(result.findings.some((finding) => finding.kind === "scope" && finding.value.includes("canopy")), true);
  assert.equal(result.findings.some((finding) => finding.kind === "lifecycle" && finding.officialStatus === "Advertised" && !finding.terminal), true);
  assert.equal(result.handoffs[0].status, "awaiting-extractor");
  for (const finding of result.findings) {
    assert.ok(finding.sourceUrl);
    assert.ok(finding.evidence);
    assert.equal(finding.provenance.sourceUrl, finding.sourceUrl);
  }
});

test("bidder, plan-holder, and bid-tabulation links are administrative documents, not plans", () => {
  const source = researchSource();
  const result = extractGenericOfficialPage(
    `<main>
      <a href="/files/plan-holders.pdf">Plan-holder list</a>
      <a href="/files/bidder-list.pdf">Bidder List</a>
      <a href="/files/bid-tabulation.pdf">Bid Tabulation</a>
    </main>`,
    source.url,
    source,
    "2026-07-16T18:00:00.000Z",
  );
  const documents = result.findings.filter((finding) => finding.kind === "document");
  assert.equal(documents.length, 3);
  assert.equal(documents.every((document) => document.documentType === "other"), true);
  assert.equal(documents.some((document) => document.documentType === "plans"), false);
});

test("generic official-page extraction recognizes City Record notice-type ordering", () => {
  const source = researchSource();
  const result = extractGenericOfficialPage(
    "<main><p>Solicitation Notice Type</p><p>Scope of Work: Install doors and windows.</p></main>",
    source.url,
    source,
    "2026-07-16T18:00:00.000Z",
  );
  const lifecycle = result.findings.find((finding) => finding.kind === "lifecycle");
  assert.equal(lifecycle?.officialStatus, "Solicitation");
  assert.equal(lifecycle?.terminal, false);
});

test("Caltrans detail strategy extracts exact official status and bid items without inventing contacts", () => {
  const fixture = {
    result: {
      containers: [{
        widgets: [
          { data: { list: [{
            className: "x_cado2_contractor_project",
            licenses: "C-42",
            display_field: { label: "District EA", display_value: "04-0W0504" },
            secondary_fields: [
              { label: "Work Description", display_value: "Trash capture devices, MVPs, MGS, erosion control, and Mod lighting." },
              { label: "Location Description", display_value: "ALAMEDA AND CONTRA COSTA COUNTIES AT VARIOUS LOCATIONS" },
              { label: "Status", display_value: "Scheduled" },
            ],
          }] } },
          { data: { list: [{
            className: "x_cado2_contractor_proposal_items",
            display_field: { label: "Item Line Number", display_value: "1" },
            secondary_fields: [
              { label: "Description", display_value: "LEAD COMPLIANCE PLAN" },
              { label: "Quantity", display_value: "1" },
              { label: "Unit", display_value: "LS" },
            ],
          }] } },
        ],
      }],
    },
  };
  const source = researchSource({
    sourceId: "caltrans-contracting-opportunities",
    sourceLabel: "Caltrans Contractors Corner 04-0W0504",
    url: "https://cdotprod.service-now.com/api/now/sp/page?id=cc_advertisement_details&ad_id=04-0W0504",
    strategy: "caltrans-contract-detail",
    allowedHosts: ["cdotprod.service-now.com"],
  });
  const result = extractCaltransContractDetail(
    JSON.stringify(fixture),
    source.url,
    source,
    "04-0W0504",
    "2026-07-16T18:00:00.000Z",
  );
  assert.equal(result.findings.some((finding) => finding.kind === "lifecycle" && finding.officialStatus === "Scheduled" && finding.terminal === false), true);
  assert.equal(result.findings.some((finding) => finding.kind === "scope" && finding.value.includes("Trash capture")), true);
  assert.equal(result.findings.some((finding) => finding.kind === "scope" && finding.value.includes("LEAD COMPLIANCE PLAN")), true);
  assert.equal(result.findings.some((finding) => finding.kind === "contact"), false);
  assert.equal(result.findings.some((finding) => finding.kind === "document"), false);
});

test("live-only Caltrans open triggers bounded research, durable gaps, and a fresh cache", async () => {
  const { database, db } = await databaseFixture();
  const projectId = "caltrans-contracting-opportunities:04-0W0504";
  const indexHtml = `
    <table><tr>
      <td data-label="Project ID"><a href="https://cdotprod.service-now.com/cc?active=true&amp;ad_id=04-0W0504&amp;id=cc_advertisement_details">04-0W0504</a></td>
      <td data-label="Project Title">Trash capture devices, MVPs, MGS, erosion control, and Mod lighting.</td>
      <td data-label="County">Ala,CC</td>
      <td data-label="License">A, C-42</td>
      <td data-label="Advertise Date">2026-07-27</td>
      <td data-label="Bid Date">2026-09-17</td>
      <td data-label="Status">Upcoming projects</td>
    </tr></table>`;
  const apiJson = JSON.stringify({ result: { containers: [{ widgets: [{ data: { list: [{
    className: "x_cado2_contractor_project",
    licenses: "C-42",
    display_field: { label: "District EA", display_value: "04-0W0504" },
    secondary_fields: [
      { label: "Work Description", display_value: "Trash capture devices and modify lighting." },
      { label: "Status", display_value: "Scheduled" },
    ],
  }, {
    className: "x_cado2_contractor_proposal_items",
    display_field: { label: "Item Line Number", display_value: "1" },
    secondary_fields: [
      { label: "Description", display_value: "LEAD COMPLIANCE PLAN" },
      { label: "Quantity", display_value: "1" },
      { label: "Unit", display_value: "LS" },
    ],
  }] } }] }] } });
  let fetchCount = 0;
  const fetchImpl = async (input) => {
    fetchCount += 1;
    const url = String(input);
    return url.includes("/api/now/sp/page")
      ? new Response(apiJson, { status: 200, headers: { "content-type": "application/json" } })
      : new Response(indexHtml, { status: 200, headers: { "content-type": "text/html" } });
  };
  const now = () => new Date("2026-07-16T18:00:00.000Z");
  const first = await triggerProjectResearch(db, projectId, "estimator@example.com", false, {
    fetchImpl,
    resolveHost: PUBLIC_DNS,
    now,
  });
  assert.equal(first.projectId, projectId);
  assert.equal(first.status, "partial");
  assert.equal(first.cached, false);
  assert.equal(first.lifecycle.some((finding) => finding.officialStatus === "Scheduled" && !finding.terminal), true);
  assert.equal(first.scopeFacts.some((finding) => finding.value.includes("LEAD COMPLIANCE PLAN")), true);
  assert.deepEqual(first.gaps.map((gap) => gap.gapType).sort(), ["contact", "documents"]);
  assert.equal(first.contacts.length, 0);
  assert.equal(first.documents.length, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM projects WHERE id=?").get(projectId).count, 1);
  assert.deepEqual(
    { ...database.prepare(
      "SELECT posted_at, first_seen_at, last_seen_at, updated_at FROM projects WHERE id=?",
    ).get(projectId) },
    {
      posted_at: "2026-07-27T00:00:00.000Z",
      first_seen_at: "2026-07-16T18:00:00.000Z",
      last_seen_at: "2026-07-16T18:00:00.000Z",
      updated_at: "2026-07-27T00:00:00.000Z",
    },
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM project_research_jobs").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM project_research_findings").get().count > 0, true);
  const callsAfterFirst = fetchCount;

  const second = await triggerProjectResearch(db, projectId, "estimator@example.com", false, {
    fetchImpl,
    resolveHost: PUBLIC_DNS,
    now,
  });
  assert.equal(second.cached, true);
  // A cached research result still re-verifies the exact official index row
  // so canonical fields can be refreshed; it does not fetch the detail page.
  assert.equal(fetchCount, callsAfterFirst + 1);

  assert.equal(await getProjectResearchRecord(db, projectId, { authenticated: false }), null);
  database.prepare(
    "UPDATE project_research_jobs SET visibility='public', public_approved_at=?, public_approved_by=?",
  ).run("2026-07-16T19:00:00.000Z", "reviewer@example.com");
  const publicRecord = await getProjectResearchRecord(db, projectId, { authenticated: false });
  assert.equal(publicRecord?.visibility, "public");
  database.close();
});

test("live-only NYC City Record open resolves an exact row, persists truthful provenance, and researches only its CROL page", async () => {
  const { database, db } = await databaseFixture();
  const requestId = "20260716001";
  const projectId = `nyc-city-record-construction-procurement:${requestId}`;
  const sourceUrl = `https://a856-cityrecord.nyc.gov/RequestDetail/${requestId}`;
  let lookupCount = 0;
  const lookupNycCityRecordProject = async (requestedId) => {
    lookupCount += 1;
    assert.equal(requestedId, projectId);
    return nycCityRecordProject(requestId);
  };
  const researchedUrls = [];
  const fetchImpl = async (input, init) => {
    const url = String(input);
    researchedUrls.push(url);
    assert.equal(url, sourceUrl);
    assert.equal(init?.credentials, "omit");
    return new Response(`
      <main>
        <p>Project Status: Solicitation</p>
        <p>Scope of Work: Upgrade the community center entrance canopy and lighting.</p>
        <p>Project Manager: Maria Rivera <a href="mailto:maria.rivera@dcas.nyc.gov">maria.rivera@dcas.nyc.gov</a></p>
        <a href="tel:+1-212-555-0198">Project office</a>
      </main>
    `, { status: 200, headers: { "content-type": "text/html" } });
  };
  const now = () => new Date("2026-07-16T18:00:00.000Z");

  const result = await triggerProjectResearch(db, projectId, "estimator@example.com", false, {
    lookupNycCityRecordProject,
    fetchImpl,
    resolveHost: PUBLIC_DNS,
    now,
  });

  assert.equal(lookupCount, 1);
  assert.deepEqual(researchedUrls, [sourceUrl]);
  assert.equal(result.projectId, projectId);
  assert.equal(result.status, "partial");
  assert.equal(result.contacts.some((finding) => finding.email === "maria.rivera@dcas.nyc.gov"), true);
  assert.equal(result.scopeFacts.some((finding) => finding.value.includes("entrance canopy")), true);
  assert.equal(result.lifecycle.some((finding) => finding.officialStatus === "Solicitation"), true);
  assert.equal(result.sources.some((source) => source.sourceUrl === sourceUrl && source.status === "complete"), true);

  const project = database.prepare(
    "SELECT id, title, stage, state, bid_date, updated_at FROM projects WHERE id=?",
  ).get(projectId);
  assert.deepEqual({ ...project }, {
    id: projectId,
    title: "COMMUNITY CENTER UPGRADES",
    stage: "bidding",
    state: "NY",
    bid_date: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
  });
  const source = database.prepare(
    `SELECT id, name, owner, jurisdiction_name, jurisdiction_level, connector,
            source_class, source_url, access_mode, cadence_minutes, status,
            lifecycle_stages
     FROM sources WHERE id=?`,
  ).get("nyc-city-record-construction-procurement");
  assert.deepEqual({ ...source }, {
    id: "nyc-city-record-construction-procurement",
    name: "NYC City Record procurement notices",
    owner: "New York City Department of Citywide Administrative Services",
    jurisdiction_name: "New York City, New York",
    jurisdiction_level: "local",
    connector: "socrata-dg92-zbpx",
    source_class: "procurement",
    source_url: "https://data.cityofnewyork.us/d/dg92-zbpx",
    access_mode: "open",
    cadence_minutes: 1440,
    status: "live",
    lifecycle_stages: JSON.stringify(["planning", "bidding", "bid-opened", "awarded", "unclassified"]),
  });
  assert.deepEqual(
    { ...database.prepare(
      `SELECT project_id, source_id, source_record_id, source_url, confidence
       FROM project_sources WHERE project_id=?`,
    ).get(projectId) },
    {
      project_id: projectId,
      source_id: "nyc-city-record-construction-procurement",
      source_record_id: requestId,
      source_url: sourceUrl,
      confidence: "official",
    },
  );
  database.close();
});

test("NYC City Record on-demand research rejects missing and non-exact identities before persistence", async () => {
  const { database, db } = await databaseFixture();
  let lookupCount = 0;
  const lookupNycCityRecordProject = async () => {
    lookupCount += 1;
    return null;
  };
  const options = {
    lookupNycCityRecordProject,
    resolveHost: PUBLIC_DNS,
    now: () => new Date("2026-07-16T18:00:00.000Z"),
  };

  await assert.rejects(
    () => triggerProjectResearch(
      db,
      "nyc-city-record-construction-procurement:20260716099",
      "estimator@example.com",
      false,
      options,
    ),
    (error) => error instanceof ProjectResearchError && error.code === "known_project_not_found",
  );
  assert.equal(lookupCount, 1);

  await assert.rejects(
    () => triggerProjectResearch(
      db,
      "nyc-city-record-construction-procurement:20260716099' OR 1=1",
      "estimator@example.com",
      false,
      options,
    ),
    (error) => error instanceof ProjectResearchError && error.code === "known_project_not_found",
  );
  assert.equal(lookupCount, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sources").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM project_sources").get().count, 0);

  const unsafeRequestId = "20260716100";
  await assert.rejects(
    () => triggerProjectResearch(
      db,
      `nyc-city-record-construction-procurement:${unsafeRequestId}`,
      "estimator@example.com",
      false,
      {
        ...options,
        lookupNycCityRecordProject: async () => nycCityRecordProject(unsafeRequestId, {
          sourceUrl: `https://attacker.example/RequestDetail/${unsafeRequestId}`,
        }),
        fetchImpl: async () => {
          throw new Error("unsafe CROL URL must be rejected before research");
        },
      },
    ),
    (error) => error instanceof ProjectResearchError && error.code === "invalid_nyc_city_record_project",
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 0);
  database.close();
});

test("live-only Los Angeles private permit resolves, persists, and researches only its exact official record", async () => {
  const { database, db } = await databaseFixture();
  const sourceId = "los-angeles-building-permits-submitted";
  const recordId = "25010-10000-01234";
  const projectId = `${sourceId}:${recordId}`;
  const permit = configuredPermitProject(sourceId, recordId, {
    status: "PC In Progress",
  });
  let lookupCount = 0;
  const lookupConfiguredPermitProject = async (requestedId) => {
    lookupCount += 1;
    assert.equal(requestedId, projectId);
    return permit;
  };
  const researchedUrls = [];
  const fetchImpl = async (input, init) => {
    researchedUrls.push(String(input));
    assert.equal(String(input), permit.sourceUrl);
    assert.equal(init?.credentials, "omit");
    return new Response(JSON.stringify([{
      permit_nbr: recordId,
      status_desc: "PC In Progress",
      primary_address: "100 Example Avenue",
    }]), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await triggerProjectResearch(db, projectId, "estimator@example.com", false, {
    lookupConfiguredPermitProject,
    fetchImpl,
    resolveHost: PUBLIC_DNS,
    now: () => new Date("2026-07-16T18:00:00.000Z"),
  });

  assert.equal(lookupCount, 1);
  assert.deepEqual(researchedUrls, []);
  assert.equal(result.projectId, projectId);
  assert.equal(result.status, "partial");
  assert.equal(result.lifecycle.some((finding) =>
    finding.officialStatus === "PC In Progress" &&
    finding.stage === "design" &&
    finding.provenance.method === "official-api" &&
    finding.provenance.strategy === "configured-exact-record"
  ), true);
  assert.equal(result.scopeFacts.some((finding) =>
    finding.factType === "location" && finding.value.includes("100 Example Avenue")
  ), true);
  assert.deepEqual(
    result.gaps.map((gap) => gap.gapType).sort(),
    ["contact", "documents"],
  );
  assert.equal(result.contacts.length, 0);
  assert.equal(result.documents.length, 0);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].sourceUrl, permit.sourceUrl);
  assert.equal(result.sources[0].status, "complete");

  const project = database.prepare(
    `SELECT id, title, stage, status, address, city, state, postal_code,
            estimated_value, posted_at
     FROM projects WHERE id=?`,
  ).get(projectId);
  assert.deepEqual({ ...project }, {
    id: projectId,
    title: "New private residential building",
    stage: "design",
    status: "PC In Progress",
    address: "100 Example Avenue",
    city: "Los Angeles",
    state: "CA",
    postal_code: "90001",
    estimated_value: 725000,
    posted_at: "2026-07-15T00:00:00.000Z",
  });
  const source = database.prepare(
    `SELECT id, name, owner, jurisdiction_name, jurisdiction_level, connector,
            source_class, source_url, access_mode, cadence_minutes, status,
            lifecycle_stages
     FROM sources WHERE id=?`,
  ).get(sourceId);
  assert.deepEqual({ ...source }, {
    id: sourceId,
    name: "Los Angeles building permits submitted",
    owner: "Los Angeles Department of Building and Safety",
    jurisdiction_name: "Los Angeles, California",
    jurisdiction_level: "local",
    connector: "socrata-exact",
    source_class: "permits",
    source_url: "https://data.lacity.org/d/gwh9-jnip",
    access_mode: "open",
    cadence_minutes: 1440,
    status: "live",
    lifecycle_stages: JSON.stringify([
      "design", "permitting", "construction", "completed", "cancelled", "unclassified",
    ]),
  });
  assert.deepEqual(
    { ...database.prepare(
      `SELECT project_id, source_id, source_record_id, source_url, confidence
       FROM project_sources WHERE project_id=?`,
    ).get(projectId) },
    {
      project_id: projectId,
      source_id: sourceId,
      source_record_id: recordId,
      source_url: permit.sourceUrl,
      confidence: "official",
    },
  );
  database.close();
});

test("live-only Seattle permit uses the fixed exact lookup, persists source activity, and skips generic raw scraping", async () => {
  const { database, db } = await databaseFixture();
  const sourceId = "seattle-building-permits";
  const recordId = "7151654-CN";
  const projectId = `${sourceId}:${recordId}`;
  const detailUrl = `https://services.seattle.gov/portal/customize/LinkToRecord.aspx?altId=${recordId}`;
  const originalFetch = globalThis.fetch;
  let exactLookupCount = 0;
  let genericFetchCount = 0;
  globalThis.fetch = async (input) => {
    exactLookupCount += 1;
    const url = new URL(String(input));
    assert.equal(url.hostname, "cos-data.seattle.gov");
    assert.equal(url.pathname, "/resource/76t5-zqzr.json");
    assert.equal(url.searchParams.get("$where"), `permitnum = '${recordId}'`);
    assert.equal(url.searchParams.get("$limit"), "2");
    return new Response(JSON.stringify([{
      permitnum: recordId,
      permitclassmapped: "Residential",
      permittypemapped: "Building",
      permittypedesc: "New Building",
      description: "Construct a new single-family residence",
      estprojectcost: "1200000",
      applieddate: "2026-07-14T00:00:00.000",
      statuscurrent: "Reviews In Process",
      originaladdress1: "123 Test Street",
      originalcity: "Seattle",
      originalstate: "WA",
      originalzip: "98101",
      contractorcompanyname: "Example Builders LLC",
      link: { url: detailUrl },
    }]), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await triggerProjectResearch(
      db,
      projectId,
      "estimator@example.com",
      false,
      {
        fetchImpl: async () => {
          genericFetchCount += 1;
          throw new Error("configured Seattle records must not enter the generic contact scraper");
        },
        resolveHost: PUBLIC_DNS,
        now: () => new Date("2026-07-16T18:00:00.000Z"),
      },
    );

    assert.equal(exactLookupCount, 1);
    assert.equal(genericFetchCount, 0);
    assert.equal(result.projectId, projectId);
    assert.equal(result.status, "partial");
    assert.equal(result.lifecycle.some((finding) =>
      finding.officialStatus === "Reviews In Process" &&
      finding.stage === "design" &&
      finding.sourceUrl === detailUrl &&
      finding.provenance.strategy === "configured-exact-record"
    ), true);
    assert.equal(result.scopeFacts.some((finding) =>
      finding.factType === "location" && finding.value.includes("123 Test Street")
    ), true);
    assert.equal(result.contacts.length, 0);
    assert.equal(result.documents.length, 0);
    assert.deepEqual(
      result.gaps.map((gap) => gap.gapType).sort(),
      ["contact", "documents"],
    );
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].sourceUrl, detailUrl);
    assert.equal(result.sources[0].status, "complete");

    assert.deepEqual(
      { ...database.prepare(
        `SELECT title, stage, status, agency, address, city, state, postal_code,
                estimated_value, posted_at, first_seen_at, last_seen_at, updated_at
         FROM projects WHERE id=?`,
      ).get(projectId) },
      {
        title: "Construct a new single-family residence",
        stage: "design",
        status: "Reviews In Process",
        agency: "Seattle Department of Construction and Inspections",
        address: "123 Test Street",
        city: "Seattle",
        state: "WA",
        postal_code: "98101",
        estimated_value: 1200000,
        posted_at: "2026-07-14T00:00:00.000Z",
        first_seen_at: "2026-07-16T18:00:00.000Z",
        last_seen_at: "2026-07-16T18:00:00.000Z",
        updated_at: "2026-07-14T00:00:00.000Z",
      },
    );
    assert.deepEqual(
      { ...database.prepare(
        `SELECT id, name, owner, jurisdiction_name, jurisdiction_level,
                connector, source_class, source_url, access_mode,
                cadence_minutes, status, lifecycle_stages
         FROM sources WHERE id=?`,
      ).get(sourceId) },
      {
        id: sourceId,
        name: "Seattle building permits",
        owner: "Seattle Department of Construction and Inspections",
        jurisdiction_name: "Seattle, Washington",
        jurisdiction_level: "local",
        connector: "socrata-exact",
        source_class: "permits",
        source_url: "https://data.seattle.gov/Permitting/Building-Permits/76t5-zqzr/about_data",
        access_mode: "open",
        cadence_minutes: 1440,
        status: "live",
        lifecycle_stages: JSON.stringify([
          "design", "permitting", "completed", "cancelled", "unclassified",
        ]),
      },
    );
    assert.deepEqual(
      { ...database.prepare(
        `SELECT project_id, source_id, source_record_id, source_url, confidence
         FROM project_sources WHERE project_id=?`,
      ).get(projectId) },
      {
        project_id: projectId,
        source_id: sourceId,
        source_record_id: recordId,
        source_url: detailUrl,
        confidence: "official",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("Seattle exact research rejects unsafe IDs and mismatched or unregistered official records", async () => {
  const { database, db } = await databaseFixture();
  const sourceId = "seattle-building-permits";
  const recordId = "7151654-CN";
  const projectId = `${sourceId}:${recordId}`;
  let lookupCount = 0;
  const baseOptions = {
    fetchImpl: async () => {
      throw new Error("invalid Seattle records must fail before generic research");
    },
    resolveHost: PUBLIC_DNS,
    now: () => new Date("2026-07-16T18:00:00.000Z"),
  };

  await assert.rejects(
    () => triggerProjectResearch(
      db,
      `${sourceId}:7151654' OR 1=1`,
      "estimator@example.com",
      false,
      {
        ...baseOptions,
        lookupConfiguredPermitProject: async () => {
          lookupCount += 1;
          return configuredPermitProject(sourceId, recordId);
        },
      },
    ),
    (error) => error instanceof ProjectResearchError && error.code === "known_project_not_found",
  );
  assert.equal(lookupCount, 0);

  await assert.rejects(
    () => triggerProjectResearch(db, projectId, "estimator@example.com", false, {
      ...baseOptions,
      lookupConfiguredPermitProject: async () => configuredPermitProject(
        sourceId,
        "7151657-CN",
        { id: projectId },
      ),
    }),
    (error) => error instanceof ProjectResearchError && error.code === "invalid_configured_permit_project",
  );
  await assert.rejects(
    () => triggerProjectResearch(db, projectId, "estimator@example.com", false, {
      ...baseOptions,
      lookupConfiguredPermitProject: async () => configuredPermitProject(sourceId, recordId, {
        sourceUrl: `https://attacker.example/permit/${recordId}`,
      }),
    }),
    (error) => error instanceof ProjectResearchError && error.code === "invalid_configured_permit_project",
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sources").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM project_sources").get().count, 0);
  database.close();
});

test("live-only Miami private permit uses the registered ArcGIS exact adapter without treating metadata as plans", async () => {
  const { database, db } = await databaseFixture();
  const sourceId = "miami-ibuild-plan-review-arcgis";
  const recordId = "BD-2026-012345";
  const projectId = `${sourceId}:${recordId}`;
  const permit = configuredPermitProject(sourceId, recordId, {
    status: "Pending / In Review",
    address: "200 Biscayne Boulevard",
    city: "Miami",
    state: "FL",
    postalCode: "33131",
    postedAt: undefined,
    updatedAt: new Date(0).toISOString(),
    documents: [{
      name: "Official Miami iBuild permit metadata",
      kind: "permit",
      url: `https://gis.miami.gov/gis/rest/services/Maps/iBuildPermits/MapServer/0/query?where=ApplicationNumber%3D%27${recordId}%27&outFields=*&f=json`,
      access: "public",
      indexStatus: "metadata-only",
    }],
  });
  const researchedUrls = [];
  const result = await triggerProjectResearch(db, projectId, "estimator@example.com", false, {
    lookupConfiguredPermitProject: async (requestedId) => {
      assert.equal(requestedId, projectId);
      return permit;
    },
    fetchImpl: async (input) => {
      researchedUrls.push(String(input));
      assert.equal(String(input), permit.sourceUrl);
      return new Response(JSON.stringify({
        features: [{ attributes: { OBJECTID: 293083, ApplicationNumber: recordId, MasterPlanStatus: "In Review" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    resolveHost: PUBLIC_DNS,
    now: () => new Date("2026-07-16T18:00:00.000Z"),
  });

  assert.deepEqual(researchedUrls, []);
  assert.equal(result.lifecycle.some((finding) => finding.officialStatus === "Pending / In Review"), true);
  assert.equal(result.documents.length, 0);
  assert.equal(result.contacts.length, 0);
  assert.deepEqual(
    result.gaps.map((gap) => gap.gapType).sort(),
    ["contact", "documents"],
  );
  const source = database.prepare(
    "SELECT connector, source_class, source_url, lifecycle_stages FROM sources WHERE id=?",
  ).get(sourceId);
  assert.deepEqual({ ...source }, {
    connector: "arcgis-exact",
    source_class: "permits",
    source_url: "https://www.miami.gov/Permits-Construction/Apply-for-or-Manage-Building-Permits-iBuild",
    lifecycle_stages: JSON.stringify([
      "design", "permitting", "construction", "completed", "cancelled", "unclassified",
    ]),
  });
  const persisted = database.prepare(
    "SELECT posted_at, updated_at, first_seen_at, last_seen_at FROM projects WHERE id=?",
  ).get(projectId);
  assert.deepEqual({ ...persisted }, {
    posted_at: null,
    updated_at: "1970-01-01T00:00:00.000Z",
    first_seen_at: "2026-07-16T18:00:00.000Z",
    last_seen_at: "2026-07-16T18:00:00.000Z",
  });
  assert.equal(
    classifyProjectFreshness(
      {
        ...permit,
        postedAt: persisted.posted_at ?? undefined,
        updatedAt: persisted.updated_at,
      },
      "2026-07-16T18:00:00.000Z",
    ).freshness,
    "unclassified",
  );
  database.close();
});

test("verified exact permit lookup refreshes an existing stale canonical row without rewriting first-seen time", async () => {
  const { database, db } = await databaseFixture();
  const sourceId = "los-angeles-building-permits-submitted";
  const recordId = "25010-10000-04567";
  const projectId = `${sourceId}:${recordId}`;
  database.prepare(
    `INSERT INTO projects (
       id, canonical_key, title, summary, stage, status, agency, address, city,
       state, posted_at, first_seen_at, last_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectId,
    projectId,
    "Stale cached title",
    "Stale cached summary",
    "unclassified",
    "Unknown",
    "Unknown agency",
    "Old address",
    "Los Angeles",
    "CA",
    "2020-01-01T00:00:00.000Z",
    "2020-01-02T00:00:00.000Z",
    "2020-01-03T00:00:00.000Z",
    "2020-01-01T00:00:00.000Z",
  );
  const verified = configuredPermitProject(sourceId, recordId, {
    title: "Verified current residential alteration",
    summary: "Official exact permit scope",
    stage: "permitting",
    status: "Permit Ready to Issue",
    address: "456 Verified Avenue",
    postedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-12T15:30:00.000Z",
  });
  let lookupCount = 0;
  await triggerProjectResearch(db, projectId, "estimator@example.com", false, {
    lookupConfiguredPermitProject: async (requestedId) => {
      lookupCount += 1;
      assert.equal(requestedId, projectId);
      return verified;
    },
    fetchImpl: async () => new Response(JSON.stringify([{
      permit_nbr: recordId,
      status_desc: "Permit Ready to Issue",
    }]), { status: 200, headers: { "content-type": "application/json" } }),
    resolveHost: PUBLIC_DNS,
    now: () => new Date("2026-07-16T18:00:00.000Z"),
  });
  assert.equal(lookupCount, 1);
  const refreshed = database.prepare(
    `SELECT title, summary, stage, status, agency, address, posted_at,
            first_seen_at, last_seen_at, updated_at
     FROM projects WHERE id=?`,
  ).get(projectId);
  assert.deepEqual({ ...refreshed }, {
    title: "Verified current residential alteration",
    summary: "Official exact permit scope",
    stage: "permitting",
    status: "Permit Ready to Issue",
    agency: "Los Angeles Department of Building and Safety",
    address: "456 Verified Avenue",
    posted_at: "2026-07-01T00:00:00.000Z",
    first_seen_at: "2020-01-02T00:00:00.000Z",
    last_seen_at: "2026-07-16T18:00:00.000Z",
    updated_at: "2026-07-12T15:30:00.000Z",
  });

  await assert.rejects(
    () => triggerProjectResearch(db, projectId, "estimator@example.com", false, {
      lookupConfiguredPermitProject: async () => ({
        ...verified,
        title: "Unverified overwrite",
        provenance: "live-public-page",
      }),
      fetchImpl: async () => {
        throw new Error("an inconsistent exact lookup must fail before fetching");
      },
      resolveHost: PUBLIC_DNS,
      now: () => new Date("2026-07-16T19:00:00.000Z"),
    }),
    (error) => error instanceof ProjectResearchError && error.code === "invalid_configured_permit_project",
  );
  assert.deepEqual(
    { ...database.prepare(
      "SELECT title, first_seen_at, last_seen_at, updated_at FROM projects WHERE id=?",
    ).get(projectId) },
    {
      title: "Verified current residential alteration",
      first_seen_at: "2020-01-02T00:00:00.000Z",
      last_seen_at: "2026-07-16T18:00:00.000Z",
      updated_at: "2026-07-12T15:30:00.000Z",
    },
  );
  database.close();
});

test("configured private-permit research rejects unsafe or inconsistent exact identities before persistence", async () => {
  const { database, db } = await databaseFixture();
  const sourceId = "los-angeles-building-permits-submitted";
  let lookupCount = 0;
  const lookupConfiguredPermitProject = async (requestedId) => {
    lookupCount += 1;
    const recordId = requestedId.slice(sourceId.length + 1);
    return configuredPermitProject(sourceId, recordId);
  };
  const options = {
    lookupConfiguredPermitProject,
    fetchImpl: async () => {
      throw new Error("unsafe or inconsistent record must be rejected before research");
    },
    resolveHost: PUBLIC_DNS,
    now: () => new Date("2026-07-16T18:00:00.000Z"),
  };

  await assert.rejects(
    () => triggerProjectResearch(
      db,
      `${sourceId}:25010' OR 1=1`,
      "estimator@example.com",
      false,
      options,
    ),
    (error) => error instanceof ProjectResearchError && error.code === "known_project_not_found",
  );
  assert.equal(lookupCount, 0);

  const projectId = `${sourceId}:25010-10000-09999`;
  await assert.rejects(
    () => triggerProjectResearch(db, projectId, "estimator@example.com", false, {
      ...options,
      lookupConfiguredPermitProject: async () => configuredPermitProject(
        sourceId,
        "different-record",
        { id: projectId },
      ),
    }),
    (error) => error instanceof ProjectResearchError && error.code === "invalid_configured_permit_project",
  );
  await assert.rejects(
    () => triggerProjectResearch(db, projectId, "estimator@example.com", false, {
      ...options,
      lookupConfiguredPermitProject: async () => configuredPermitProject(
        sourceId,
        "25010-10000-09999",
        { sourceUrl: "https://attacker.example/permit/25010-10000-09999" },
      ),
    }),
    (error) => error instanceof ProjectResearchError && error.code === "invalid_configured_permit_project",
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sources").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM project_sources").get().count, 0);
  database.close();
});

test("administrative bidder links do not suppress the missing-plan research gap", async () => {
  const { database, db } = await databaseFixture();
  database.prepare(
    `INSERT INTO sources (
       id, name, owner, jurisdiction_name, jurisdiction_level, connector,
       source_class, source_url, access_mode, cadence_minutes, status,
       lifecycle_stages
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "official-source", "Official source", "Agency", "Test", "city", "html",
    "procurement", "https://projects.example.gov/", "open", 60, "live", "[\"bidding\"]",
  );
  database.prepare(
    `INSERT INTO projects (id, canonical_key, title, stage, status, agency)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("official-source:1", "official-source:1", "Known project", "bidding", "Open", "Agency");
  database.prepare(
    `INSERT INTO project_sources (
       project_id, source_id, source_record_id, source_url, confidence
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run("official-source:1", "official-source", "1", "https://projects.example.gov/project/1", "official");

  const html = `<main>
    <p>Project Status: Advertised</p>
    <p>Scope of Work: Construct a public safety building.</p>
    <a href="/files/plan-holders.pdf">Plan Holder List</a>
    <a href="/files/bidder-list.pdf">Bidder List</a>
    <a href="/files/bid-tabulation.pdf">Bid Tabulation</a>
  </main>`;
  const result = await triggerProjectResearch(db, "official-source:1", "estimator@example.com", false, {
    fetchImpl: async () => new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
    resolveHost: PUBLIC_DNS,
    now: () => new Date("2026-07-16T18:00:00.000Z"),
  });

  assert.equal(result.documents.length, 3);
  assert.equal(result.documents.every((document) => document.documentType === "other"), true);
  assert.equal(result.gaps.some((gap) =>
    gap.gapType === "documents" && /do not prove that plans are available/i.test(gap.message)
  ), true);
  database.close();
});

test("failed source runs persist exponential retry backoff and do not hammer during the window", async () => {
  const { database, db } = await databaseFixture();
  database.prepare(
    `INSERT INTO sources (
       id, name, owner, jurisdiction_name, jurisdiction_level, connector,
       source_class, source_url, access_mode, cadence_minutes, status,
       lifecycle_stages
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "official-source", "Official source", "Agency", "Test", "city", "html",
    "procurement", "https://projects.example.gov/", "open", 60, "live", "[\"bidding\"]",
  );
  database.prepare(
    `INSERT INTO projects (id, canonical_key, title, stage, status, agency)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("official-source:1", "official-source:1", "Known project", "bidding", "Open", "Agency");
  database.prepare(
    `INSERT INTO project_sources (
       project_id, source_id, source_record_id, source_url, confidence
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run("official-source:1", "official-source", "1", "https://projects.example.gov/project/1", "official");
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    throw new Error("network unavailable");
  };
  const now = () => new Date("2026-07-16T18:00:00.000Z");
  const first = await triggerProjectResearch(db, "official-source:1", "estimator@example.com", false, {
    fetchImpl,
    resolveHost: PUBLIC_DNS,
    now,
  });
  assert.equal(first.status, "failed");
  assert.equal(first.attempt, 1);
  assert.equal(first.nextRetryAt, "2026-07-16T18:15:00.000Z");
  assert.equal(first.gaps.some((gap) => gap.gapType === "source-unavailable"), true);
  const callsAfterFirst = fetchCount;
  const second = await triggerProjectResearch(db, "official-source:1", "estimator@example.com", false, {
    fetchImpl,
    resolveHost: PUBLIC_DNS,
    now,
  });
  assert.equal(second.cached, true);
  assert.equal(fetchCount, callsAfterFirst);
  await assert.rejects(
    () => triggerProjectResearch(db, "unconfigured:1", "estimator@example.com", false, {
      fetchImpl,
      resolveHost: PUBLIC_DNS,
      now,
    }),
    (error) => error instanceof ProjectResearchError && error.code === "known_project_not_found",
  );
  database.close();
});

test("Bid Desk opens a cached exact-project dossier and blocks release without sourced lifecycle and a verified route", async () => {
  const [hook, dossier, bidDesk] = await Promise.all([
    readFile(new URL("../app/lib/use-project-research.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/ProjectResearchDossier.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/BidDesk.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(hook, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/research/);
  assert.match(hook, /requestResearch\(projectId, controller\.signal, "GET"\)/);
  assert.match(hook, /requestResearch\(projectId, controller\.signal, "POST", force\)/);
  assert.match(hook, /JSON\.stringify\(\{ force \}\)/);
  assert.match(hook, /controller\.abort\(\)/);
  assert.match(hook, /bounded wait ended while the server job was still running/i);
  assert.match(hook, /setLoadStates\(\(current\) => \(\{ \.\.\.current, \[projectId\]: "checking" \}\)\)/);
  assert.doesNotMatch(hook, /sourceUrl\s*:/);

  assert.match(dossier, /Missing information stays visible as a gap/);
  assert.match(dossier, /no person or channel is\s*\n?\s*invented/i);
  assert.match(dossier, /Official terminal status/);
  assert.match(dossier, /Awaiting extractor/i);
  assert.match(dossier, /does not mean the PDF, drawing, OCR text, or CAD contents have already been read/i);

  assert.match(bidDesk, /recipientsForProject\(selectedProject, researchContacts\)/);
  assert.doesNotMatch(bidDesk, /Official contact\s*[—-]\s*\$\{contact\.(?:email|phone)\}/);
  assert.match(
    bidDesk,
    /const name =\s*contact\.displayName\?\.trim\(\) \|\|\s*contact\.organization\?\.trim\(\) \|\|\s*"";/,
  );
  assert.match(bidDesk, /recipient\.suggestedChannel/);
  assert.match(bidDesk, /Channel verification source URL/);
  assert.match(bidDesk, /verifiedRecipientFingerprints/);
  assert.match(bidDesk, /approvedProjects\[selectedProject\.id\] === approvalContextToken/);
  assert.match(bidDesk, /Team verified/);
  assert.match(bidDesk, /projectResearch\.loadState === "ready"/);
  assert.match(bidDesk, /const officialStatusReady =\s*\n?\s*lifecycleResearchReady/);
  assert.match(bidDesk, /officialStatusReady &&\s*checklistComplete/);
  assert.match(bidDesk, /No verified recipient\/channel/);
});
