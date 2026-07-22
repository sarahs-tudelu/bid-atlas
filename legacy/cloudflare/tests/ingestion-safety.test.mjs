import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      try {
        return await nextResolve(specifier, context);
      } catch (error) {
        if (/^\\.{1,2}\\//.test(specifier) && !/\\.[a-z0-9]+$/i.test(specifier)) {
          return nextResolve(specifier + ".ts", context);
        }
        throw error;
      }
    }
  `)}`,
  import.meta.url,
);

const { PROJECT_SOURCE_IDS } = await import("../app/lib/connectors.ts");
const { searchPersistedProjects } = await import("../db/search-repository.ts");
const { runIngestion } = await import("../worker/ingestion.ts");

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
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes ?? 0) } };
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
    const migration = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
  return { database, db: new D1Fixture(database) };
}

test("partial source pages resume by processed project identity", async () => {
  const ingestion = await readFile(
    new URL("../worker/ingestion.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    ingestion,
    /interface IngestionCursorState[\s\S]*pageProcessedProjectIds:\s*string\[\]/,
  );
  assert.match(
    ingestion,
    /pageProcessedProjectIds:\s*cursorProjectIds\(parsed\.pageProcessedProjectIds\)/,
  );
  assert.match(
    ingestion,
    /function parsedSourceCursor[\s\S]*cursor\.matchedRecords = cursorNumber\(record\.matchedRecords\)/,
    "scan-wide matched totals must survive shared backfill and refresh cursor parsing",
  );
  assert.match(
    ingestion,
    /const processedProjectIds = new Set\(cursorState\.pageProcessedProjectIds\)/,
  );
  assert.match(
    ingestion,
    /processedProjectIds\.has\(project\.id\)[\s\S]*\? \[\][\s\S]*project,/,
  );
  assert.match(ingestion, /nextProcessedProjectIds\.add\(project\.id\)/);
  assert.match(
    ingestion,
    /const pageProjectsComplete =[\s\S]*processedFeedProjectCount >= fetchedProjects/,
  );
  assert.match(
    ingestion,
    /pageProcessedProjectIds:\s*\[\.\.\.nextProcessedProjectIds\]/,
  );
  assert.doesNotMatch(
    ingestion,
    /feed\.projects\.slice\(feedStartOffset\)/,
    "a freshly fetched page must not skip its prefix by numeric offset",
  );
});

test("source health cannot erase known totals or outlive its cadence", async () => {
  const [ingestion, jurisdictionsApi] = await Promise.all([
    readFile(new URL("../worker/ingestion.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/jurisdictions/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(
    ingestion,
    /WHEN excluded\.status IN \('degraded', 'credential-required'\)[\s\S]*THEN sources\.source_reported_total/,
  );
  assert.ok(
    ingestion.match(/MAX\(evidence_sources\.cadence_minutes \* 3, 1440\)/g)?.length >= 2,
    "both coverage aggregate paths must expire stale evidence",
  );
  assert.ok(
    jurisdictionsApi.match(/MAX\(current_sources\.cadence_minutes \* 3, 1440\)/g)?.length >= 2,
    "the read path must independently reject stale connected evidence",
  );
  assert.match(
    jurisdictionsApi,
    /current_evidence\.evidence_state='connected'[\s\S]*current_sources\.status='live'/,
  );
});

test("persisted actionable freshness returns dated new/current rows and excludes stale or undated active rows", async () => {
  const { database, db } = await databaseFixture();
  database.prepare(
    `INSERT INTO sources (
       id, name, owner, jurisdiction_name, jurisdiction_level, connector,
       connector_version, source_class, source_url, access_mode, cadence_minutes,
       status, lifecycle_stages
     ) VALUES (
       'freshness-fixture', 'Freshness fixture', 'Fixture owner', 'Fixture', 'local',
       'fixture', '1', 'permits', 'https://example.gov/permits', 'open', 1440,
       'live', '["design"]'
     )`,
  ).run();

  const reference = Date.now();
  const rows = [
    { id: "new", stage: "design", status: "Active", date: new Date(reference - 5 * 86_400_000).toISOString() },
    { id: "current", stage: "design", status: "Active", date: new Date(reference - 30 * 86_400_000).toISOString() },
    { id: "bid-opened", stage: "bid-opened", status: "Bids opened", date: new Date(reference - 5 * 86_400_000).toISOString() },
    { id: "awarded", stage: "awarded", status: "Awarded", date: new Date(reference - 5 * 86_400_000).toISOString() },
    { id: "stale", stage: "design", status: "Active", date: new Date(reference - 365 * 86_400_000).toISOString() },
    { id: "undated", stage: "design", status: "Active", date: "1970-01-01T00:00:00.000Z" },
  ];
  for (const row of rows) {
    database.prepare(
      `INSERT INTO projects (
         id, canonical_key, title, summary, stage, status, agency,
         posted_at, updated_at
       ) VALUES (?, ?, ?, '', ?, ?, 'Fixture owner', ?, ?)`,
    ).run(
      `freshness-fixture:${row.id}`,
      `freshness-fixture:${row.id}`,
      row.id,
      row.stage,
      row.status,
      row.date,
      row.date,
    );
    database.prepare(
      `INSERT INTO project_sources (
         project_id, source_id, source_record_id, source_url, confidence
       ) VALUES (?, 'freshness-fixture', ?, ?, 'official')`,
    ).run(
      `freshness-fixture:${row.id}`,
      row.id,
      `https://example.gov/permits/${row.id}`,
    );
  }

  try {
    const search = async (freshness) => searchPersistedProjects(
      {
        keywords: [],
        match: "all",
        stage: "all",
        state: "all",
        freshness,
        due: "all",
      },
      [],
      { offset: 0, limit: 10 },
      db,
    );
    const actionable = await search("actionable");
    assert.equal(actionable.available, true);
    assert.deepEqual(
      actionable.projects.map((project) => project.sourceRecordId).sort(),
      ["awarded", "bid-opened", "current", "new"],
    );
    const unclassified = await search("unclassified");
    assert.equal(unclassified.available, true);
    assert.deepEqual(
      unclassified.projects.map((project) => project.sourceRecordId),
      ["undated"],
    );
  } finally {
    database.close();
  }
});

test("persisted location search normalizes punctuation, spacing, and full state names", async () => {
  const { database, db } = await databaseFixture();
  database.prepare(
    `INSERT INTO sources (
       id, name, owner, jurisdiction_name, jurisdiction_level, connector,
       connector_version, source_class, source_url, access_mode, cadence_minutes,
       status, lifecycle_stages
     ) VALUES (
       'location-fixture', 'Location fixture', 'Fixture owner', 'Los Angeles', 'local',
       'fixture', '1', 'permits', 'https://example.gov/permits', 'open', 1440,
       'live', '["design"]'
     )`,
  ).run();
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO projects (
       id, canonical_key, title, summary, stage, status, agency,
       address, city, county, state, postal_code, posted_at, updated_at
     ) VALUES (
       'location-fixture:1', 'location-fixture:1', 'Location fixture', '',
       'design', 'Active', 'Fixture owner', '100 Main St.', 'Los Angeles',
       'Los Angeles', 'CA', '90012', ?, ?
     )`,
  ).run(now, now);
  database.prepare(
    `INSERT INTO project_sources (
       project_id, source_id, source_record_id, source_url, confidence
     ) VALUES (
       'location-fixture:1', 'location-fixture', '1',
       'https://example.gov/permits/1', 'official'
     )`,
  ).run();

  try {
    const search = (location, state = "all") => searchPersistedProjects(
      {
        keywords: [],
        location,
        match: "all",
        stage: "all",
        state,
        freshness: "all",
        due: "all",
      },
      [],
      { offset: 0, limit: 10 },
      db,
    );
    const punctuated = await search("Los Angeles,   California");
    assert.equal(punctuated.available, true);
    assert.deepEqual(punctuated.projects.map((project) => project.sourceRecordId), ["1"]);

    const fullState = await search("100 Main St", "California");
    assert.equal(fullState.available, true);
    assert.deepEqual(fullState.projects.map((project) => project.sourceRecordId), ["1"]);

    const wrongState = await search("Los Angeles, Nevada");
    assert.equal(wrongState.available, true);
    assert.deepEqual(wrongState.projects, []);
  } finally {
    database.close();
  }
});

test("project search exposes only rights-gated public document metadata and text", async () => {
  const { database, db } = await databaseFixture();
  database.prepare(
    `INSERT INTO sources (
       id, name, owner, jurisdiction_name, jurisdiction_level, connector,
       connector_version, source_class, source_url, access_mode, cadence_minutes,
       status, lifecycle_stages
     ) VALUES (
       'document-rights-fixture', 'Document rights fixture', 'Fixture owner', 'Fixture', 'local',
       'fixture', '1', 'permits', 'https://example.gov/permits', 'open', 1440,
       'live', '["design"]'
     )`,
  ).run();

  const fixtures = [
    {
      suffix: "private",
      visibility: "private",
      documentName: "Private drawing",
      needle: "privateneedle",
    },
    {
      suffix: "workspace",
      visibility: "workspace",
      documentName: "Workspace drawing",
      needle: "workspaceneedle",
    },
    {
      suffix: "public",
      visibility: "public",
      documentName: "Authorized public drawing",
      needle: "publicneedle",
    },
  ];
  const now = new Date().toISOString();
  for (const fixture of fixtures) {
    const projectId = `document-rights-fixture:${fixture.suffix}`;
    const documentId = `document-rights-document:${fixture.suffix}`;
    const versionId = `document-rights-version:${fixture.suffix}`;
    database.prepare(
      `INSERT INTO projects (
         id, canonical_key, title, summary, stage, status, agency, posted_at, updated_at
       ) VALUES (?, ?, ?, '', 'design', 'Active', 'Fixture owner', ?, ?)`,
    ).run(projectId, projectId, `Neutral project ${fixture.suffix}`, now, now);
    database.prepare(
      `INSERT INTO project_sources (
         project_id, source_id, source_record_id, source_url, confidence
       ) VALUES (?, 'document-rights-fixture', ?, ?, 'official')`,
    ).run(
      projectId,
      fixture.suffix,
      `https://example.gov/permits/${fixture.suffix}`,
    );
    database.prepare(
      `INSERT INTO documents (
         id, project_id, source_id, name, document_type, source_url, access_mode,
         visibility, license_code, redistribution_allowed, processing_status
       ) VALUES (
         ?, ?, 'document-rights-fixture', ?, 'plans', ?, 'public',
         ?, 'terms-reviewed', 1, 'text-indexed'
       )`,
    ).run(
      documentId,
      projectId,
      fixture.documentName,
      `https://example.gov/documents/${fixture.suffix}.pdf`,
      fixture.visibility,
    );
    database.prepare(
      `INSERT INTO document_versions (
         id, document_id, normalized_url, access_mode, archive_policy, retrieval_status
       ) VALUES (?, ?, ?, 'public', 'authorized-copy', 'retrieved')`,
    ).run(
      versionId,
      documentId,
      `https://example.gov/documents/${fixture.suffix}.pdf`,
    );
    database.prepare(
      `INSERT INTO document_extractions (
         id, document_version_id, source_hash, extractor, extractor_version,
         method, status, indexed_at
       ) VALUES (?, ?, ?, 'fixture', '1', 'text', 'complete', ?)`,
    ).run(
      `document-rights-extraction:${fixture.suffix}`,
      versionId,
      `hash-${fixture.suffix}`,
      now,
    );
    database.prepare(
      `INSERT INTO document_chunk_fts (
         chunk_id, project_id, document_version_id, chunk_text
       ) VALUES (?, ?, ?, ?)`,
    ).run(
      `document-rights-chunk:${fixture.suffix}`,
      projectId,
      versionId,
      `Exact searchable text ${fixture.needle}`,
    );
  }

  const candidateIds = fixtures.map(
    (fixture) => `document-rights-fixture:${fixture.suffix}`,
  );
  const search = (keywords) => searchPersistedProjects(
    {
      keywords,
      match: "all",
      stage: "all",
      state: "all",
      freshness: "all",
      due: "all",
    },
    candidateIds,
    { offset: 0, limit: 10 },
    db,
  );

  try {
    for (const needle of ["privateneedle", "workspaceneedle"]) {
      const hiddenMatch = await search([needle]);
      assert.equal(hiddenMatch.available, true);
      assert.equal(hiddenMatch.matchedProjectCount, 0);
      assert.deepEqual(hiddenMatch.projects, []);
      assert.deepEqual(hiddenMatch.documentMatchedCandidateIds, []);
      assert.deepEqual(
        hiddenMatch.documentIndexedCandidateIds,
        ["document-rights-fixture:public"],
      );
      assert.equal(hiddenMatch.eligibleDocumentTextProjects, 1);
    }

    const publicMatch = await search(["publicneedle"]);
    assert.equal(publicMatch.available, true);
    assert.equal(publicMatch.matchedProjectCount, 1);
    assert.deepEqual(
      publicMatch.projects.map((project) => project.id),
      ["document-rights-fixture:public"],
    );
    assert.deepEqual(
      publicMatch.documentMatchedCandidateIds,
      ["document-rights-fixture:public"],
    );
    assert.equal(publicMatch.projects[0].documentTextIndexed, true);
    assert.deepEqual(
      publicMatch.projects[0].documents.map((document) => document.name),
      ["Authorized public drawing"],
    );

    const unfiltered = await search([]);
    assert.equal(unfiltered.available, true);
    const documentsByProject = Object.fromEntries(
      unfiltered.projects.map((project) => [
        project.id,
        project.documents.map((document) => document.name),
      ]),
    );
    assert.deepEqual(documentsByProject, {
      "document-rights-fixture:private": [],
      "document-rights-fixture:public": ["Authorized public drawing"],
      "document-rights-fixture:workspace": [],
    });
  } finally {
    database.close();
  }
});

test("configured connector contacts persist and hydrate only source-literal fields", async () => {
  const [ingestion, repository] = await Promise.all([
    readFile(new URL("../worker/ingestion.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/search-repository.ts", import.meta.url), "utf8"),
  ]);

  assert.match(
    ingestion,
    /participant\.participantType !== "person" && !emailRecord && !phone/,
    "organization-only participants without literal channels must not become person contacts",
  );
  assert.match(ingestion, /literalParticipantEmail\(participant\.email\)/);
  assert.match(ingestion, /literalParticipantPhone\(participant\.phone\)/);
  assert.doesNotMatch(
    ingestion.slice(
      ingestion.indexOf("export async function sourceParticipantContactRecord"),
      ingestion.indexOf("async function runBatches"),
    ),
    /project\.(?:title|summary|searchableFields|documents)/,
    "contact persistence must not derive channels from project content",
  );
  assert.match(ingestion, /INSERT INTO contacts/);
  assert.match(ingestion, /INSERT INTO project_contacts/);
  assert.match(ingestion, /verification_status='source-reported'/);
  assert.match(ingestion, /acquisitionMethod: "configured-connector"/);

  assert.match(repository, /FROM project_contacts pc[\s\S]*JOIN contacts c/);
  assert.match(repository, /json_extract\(pc\.provenance, '\$\.email'\)/);
  assert.match(repository, /json_extract\(pc\.provenance, '\$\.phone'\)/);
  assert.match(
    repository,
    /pc\.verification_status = 'source-reported'[\s\S]*'configured-connector'/,
  );
  const sourceContactQuery = repository.slice(
    repository.indexOf("all<PersistedProjectContactRow>"),
    repository.indexOf("projectRows.push"),
  );
  assert.doesNotMatch(
    sourceContactQuery,
    /\bc\.(?:email|phone)\b/,
    "public hydration must use the source snapshot rather than later enriched channels",
  );
  assert.match(repository, /function mergeParticipant\(/);
});

test("configured connector public contacts round trip through ingestion and search hydration", async () => {
  const { database, db } = await databaseFixture();
  const sourceId = "nyc-city-record-construction-procurement";
  const sourceIndex = PROJECT_SOURCE_IDS.indexOf(sourceId);
  assert.notEqual(sourceIndex, -1, "the fixture source must participate in scheduled ingestion");

  database.prepare(
    `INSERT INTO sources (
       id, name, owner, jurisdiction_name, jurisdiction_level, connector,
       connector_version, source_class, source_url, access_mode, cadence_minutes,
       status, lifecycle_stages, cursor, created_at, updated_at
     ) VALUES (
       'system:ingestion-lock', 'BidAtlas ingestion lease', 'BidAtlas', 'System',
       'system', 'internal', '1', 'system', 'https://bidatlas.invalid/internal',
       'internal', 15, 'system', '[]', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     )`,
  ).run(JSON.stringify({
    sourceIndex,
    refreshSourceIndex: 0,
    backfillRunsSinceRefresh: 0,
    pageProjectOffset: 0,
    pageProcessedProjectIds: [],
    projectDocumentOffset: 0,
    sourceCursors: {},
  }));
  database.prepare(
    `INSERT INTO sources (
       id, name, owner, jurisdiction_name, jurisdiction_level, connector,
       connector_version, source_class, source_url, access_mode, cadence_minutes,
       status, lifecycle_stages, created_at, updated_at
     ) VALUES (
       'sam-contract-opportunities', 'SAM.gov contract opportunities',
       'U.S. General Services Administration', 'United States', 'federal',
       'sam-contract-opportunities', '1', 'procurement',
       'https://sam.gov/content/opportunities', 'free-key', 60, 'credential-required',
       '["planning","bidding","awarded","cancelled"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     )`,
  ).run();

  const sourceRow = {
    request_id: "20260716001",
    start_date: "2026-07-16T00:00:00.000",
    end_date: "2026-07-16T00:00:00.000",
    agency_name: "Department of Design and Construction",
    type_of_notice_description: "Solicitation",
    category_description: "Construction Related Services",
    short_title: "Public Library Canopy Improvements",
    selection_method_description: "Competitive Sealed Bids",
    section_name: "Procurement",
    pin: "85026B0042",
    due_date: "2026-08-20T14:00:00.000",
    contact_name: "Maria Rivera",
    contact_phone: "(212) 555-0198",
    email: "Maria.Rivera@ddc.nyc.gov",
    additional_description_1: "Replace the entrance canopy and lighting.",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "data.cityofnewyork.us");
    return Response.json(
      url.searchParams.get("$select") === "count(*) as count"
        ? [{ count: "1" }]
        : [sourceRow],
    );
  };

  try {
    const ingestion = await runIngestion({ DB: db }, "incremental");
    assert.equal(ingestion.status, "partial", "the isolated fixture intentionally omits the Census registry");
    assert.equal(ingestion.projects, 1);

    const stored = database.prepare(
      `SELECT c.email, c.phone, c.verification_status, pc.verification_status AS relationship_verification,
              json_extract(pc.provenance, '$.acquisitionMethod') AS acquisition_method
         FROM project_contacts pc
         JOIN contacts c ON c.id=pc.contact_id
        WHERE pc.project_id=?`,
    ).get(`${sourceId}:${sourceRow.request_id}`);
    assert.deepEqual({ ...stored }, {
      email: "maria.rivera@ddc.nyc.gov",
      phone: "(212) 555-0198",
      verification_status: "source-reported",
      relationship_verification: "source-reported",
      acquisition_method: "configured-connector",
    });

    // A later enrichment must not replace the literal source snapshot exposed
    // on the public project card.
    database.prepare(
      "UPDATE contacts SET email='enriched@example.com', phone='646-555-0000' WHERE id IN (SELECT contact_id FROM project_contacts WHERE project_id=?)",
    ).run(`${sourceId}:${sourceRow.request_id}`);

    database.prepare(
      `INSERT INTO organizations (
         id, normalized_name, display_name, organization_type, created_at, updated_at
       ) VALUES (
         'org-plan-holder-fixture', 'fixture proposal requester llc',
         'Fixture Proposal Requester LLC', 'plan-holder', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )`,
    ).run();
    database.prepare(
      `INSERT INTO project_participants (
         project_id, organization_id, role, participation_status, source_id,
         first_seen_at, last_seen_at
       ) VALUES (?, 'org-plan-holder-fixture', 'plan-holder', 'reported', ?,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(`${sourceId}:${sourceRow.request_id}`, sourceId);

    const hydrated = await searchPersistedProjects(
      {
        keywords: [],
        match: "all",
        stage: "bidding",
        state: "NY",
        freshness: "all",
        due: "all",
      },
      [],
      { offset: 0, limit: 10 },
      db,
    );
    assert.equal(hydrated.available, true);
    assert.equal(hydrated.projects.length, 1);
    const contact = hydrated.projects[0].participants.find(
      (participant) => participant.participantType === "person",
    );
    assert.deepEqual(contact, {
      name: "Maria Rivera",
      role: "agency",
      participantType: "person",
      organization: "Department of Design and Construction",
      email: "maria.rivera@ddc.nyc.gov",
      phone: "(212) 555-0198",
      sourceUrl: "https://a856-cityrecord.nyc.gov/RequestDetail/20260716001",
    });
    assert.ok(
      hydrated.projects[0].participants.some(
        (participant) =>
          participant.role === "plan-holder" &&
          participant.name === "Fixture Proposal Requester LLC" &&
          participant.participantType === "organization",
      ),
      "persisted plan-holder roles must survive public search hydration",
    );
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});
