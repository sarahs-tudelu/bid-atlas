import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

register(new URL("./ts-extension-loader.mjs", import.meta.url));

const { ProjectResearchError } = await import(
  "../app/lib/project-research/contracts.ts"
);
const {
  parsePublicDotProjectId,
  publicDotSourceRegistration,
  resolveExactPublicDotProject,
} = await import("../app/lib/project-research/public-dot.ts");
const { triggerProjectResearch } = await import(
  "../app/lib/project-research/service.ts"
);
const { loadProjectOfficialSources } = await import(
  "../app/lib/project-research/repository.ts"
);
const {
  PUBLIC_DOT_SOURCE_IDS,
  PUBLIC_DOT_SOURCE_TEMPLATES,
} = await import("../app/lib/public-dot-connectors.ts");

const SOURCE_ID = "washington-dot-contracting-opportunities";
const RECORD_ID = "XE3758";
const PROJECT_ID = `${SOURCE_ID}:${RECORD_ID}`;
const PROJECT_URL =
  "https://wsdot.wa.gov/business-wsdot/contracting-opportunities/sr-512-corridor";
const NOW = new Date("2026-07-20T18:00:00.000Z");
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
    const sql = await readFile(
      new URL(`../drizzle/${file}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
  return { database, db: new D1Fixture(database) };
}

function publicDotProject(overrides = {}) {
  return {
    id: PROJECT_ID,
    sourceId: SOURCE_ID,
    sourceRecordId: RECORD_ID,
    title: "SR 512 Corridor Congestion Management",
    summary:
      "Install roadway detection, fiber, signing, and traffic-management equipment along SR 512.",
    stage: "bidding",
    status: "Advertised",
    agency: "Washington State Department of Transportation",
    county: "Pierce",
    state: "Washington",
    postedAt: "2026-07-10T00:00:00.000Z",
    bidDate: "2026-07-30T22:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
    sourceName: PUBLIC_DOT_SOURCE_TEMPLATES[SOURCE_ID].name,
    sourceUrl: PROJECT_URL,
    provenance: "live-public-page",
    confidence: "official",
    documents: [
      {
        name: "XE3758 Plans",
        kind: "plans",
        url: "https://ftp.wsdot.wa.gov/contracts/XE3758-SR512/XE3758-Plans.pdf",
        access: "public",
        indexStatus: "queued",
      },
      {
        name: "XE3758 Special Provisions",
        kind: "specifications",
        url: "https://ftp.wsdot.wa.gov/contracts/XE3758-SR512/XE3758-Special-Provisions.pdf",
        access: "public",
        indexStatus: "queued",
      },
      {
        name: "Hostile fake plans",
        kind: "plans",
        url: "https://attacker.example/XE3758-Plans.pdf",
        access: "public",
        indexStatus: "queued",
      },
      {
        name: "Account-gated addendum",
        kind: "addendum",
        url: "https://ftp.wsdot.wa.gov/contracts/XE3758-SR512/Addendum-1.pdf",
        access: "free-account",
        indexStatus: "account-gated",
      },
      {
        name: "Official record",
        kind: "source-record",
        url: PROJECT_URL,
        access: "public",
        indexStatus: "metadata-only",
      },
    ],
    participants: [
      {
        name: "Jane Engineer",
        role: "agency",
        participantType: "person",
        organization: "Washington State Department of Transportation",
        email: "Jane.Engineer@wsdot.wa.gov",
        phone: "360-555-0101",
        sourceUrl: PROJECT_URL,
      },
      {
        name: "Unbacked Contact",
        role: "contractor",
        email: "unbacked@example.com",
        phone: "360-555-0102",
      },
      {
        name: "Hostile Contact",
        role: "contractor",
        email: "hostile@example.com",
        phone: "360-555-0103",
        sourceUrl: "https://attacker.example/contact",
      },
    ],
    ...overrides,
  };
}

test("public DOT IDs and source registrations are strict and stable", () => {
  assert.deepEqual(parsePublicDotProjectId(PROJECT_ID), {
    sourceId: SOURCE_ID,
    recordId: RECORD_ID,
  });
  for (const malformed of [
    `${PROJECT_ID} `,
    `${SOURCE_ID}:`,
    `${PROJECT_ID}?next=1`,
    `${PROJECT_ID}%2Fother`,
    `${PROJECT_ID}' OR 1=1`,
    `unknown-dot-source:${RECORD_ID}`,
  ]) {
    assert.equal(parsePublicDotProjectId(malformed), undefined);
  }

  for (const sourceId of PUBLIC_DOT_SOURCE_IDS) {
    const registration = publicDotSourceRegistration(sourceId);
    const template = PUBLIC_DOT_SOURCE_TEMPLATES[sourceId];
    assert.deepEqual(registration, {
      id: sourceId,
      name: template.name,
      owner: template.owner,
      jurisdictionName: template.jurisdiction,
      jurisdictionLevel: "state",
      connector: "public-dot-exact",
      sourceClass: "procurement",
      sourceUrl: template.url,
      accessMode: "open",
      cadenceMinutes: 1440,
      status: "live",
      lifecycleStages: [...template.stages],
    });
  }
  assert.equal(publicDotSourceRegistration("unregistered-dot"), undefined);
});

test("exact DOT resolution emits only source-backed contacts and official public files", async () => {
  let lookupCount = 0;
  const resolution = await resolveExactPublicDotProject(
    PROJECT_ID,
    async (requestedId) => {
      lookupCount += 1;
      assert.equal(requestedId, PROJECT_ID);
      return publicDotProject();
    },
    NOW,
  );

  assert.equal(lookupCount, 1);
  assert.ok(resolution);
  assert.equal(resolution.project.id, PROJECT_ID);
  assert.equal(resolution.project.sourceRecordId, RECORD_ID);
  assert.equal(resolution.project.bidDate, "2026-07-30T22:00:00.000Z");
  assert.deepEqual(
    resolution.findings
      .filter((finding) => finding.kind === "contact")
      .map((finding) => ({
        name: finding.displayName,
        email: finding.email,
        phone: finding.phone,
      })),
    [{
      name: "Jane Engineer",
      email: "jane.engineer@wsdot.wa.gov",
      phone: "360-555-0101",
    }],
  );
  const documents = resolution.findings.filter(
    (finding) => finding.kind === "document",
  );
  assert.deepEqual(
    documents.map((finding) => finding.documentType).sort(),
    ["plans", "specifications"],
  );
  assert.equal(
    documents.every((finding) =>
      new URL(finding.url).hostname === "ftp.wsdot.wa.gov"
    ),
    true,
  );
  assert.equal(
    resolution.findings.some((finding) =>
      JSON.stringify(finding).includes("attacker.example") ||
      JSON.stringify(finding).includes("unbacked@example.com")
    ),
    false,
  );
  assert.equal(resolution.handoffs.length, 2);
  assert.equal(
    resolution.handoffs.every((handoff) =>
      handoff.status === "awaiting-extractor" &&
      handoff.sourceUrl.startsWith("https://ftp.wsdot.wa.gov/")
    ),
    true,
  );
  assert.equal(resolution.attempt.sourceId, SOURCE_ID);
  assert.equal(resolution.attempt.sourceUrl, PROJECT_URL);
  assert.equal(resolution.attempt.status, "complete");
});

test("exact DOT resolution fails closed for malformed and mismatched identities", async () => {
  let malformedLookupCalled = false;
  const malformed = await resolveExactPublicDotProject(
    `${PROJECT_ID}?other=1`,
    async () => {
      malformedLookupCalled = true;
      return publicDotProject();
    },
    NOW,
  );
  assert.equal(malformed, null);
  assert.equal(malformedLookupCalled, false);

  for (const project of [
    publicDotProject({ sourceRecordId: "XE9999" }),
    publicDotProject({ sourceName: "Imposter source" }),
    publicDotProject({ provenance: "live-api" }),
    publicDotProject({ stage: "awarded" }),
    publicDotProject({
      sourceUrl: "https://attacker.example/contracts/XE3758",
    }),
  ]) {
    await assert.rejects(
      () => resolveExactPublicDotProject(PROJECT_ID, async () => project, NOW),
      (error) =>
        error instanceof ProjectResearchError &&
        error.code === "invalid_public_dot_project" &&
        error.status === 502,
    );
  }
});

test("service exact lookup persists the registered DOT source and seeded evidence", async () => {
  const { database, db } = await databaseFixture();
  let lookupCount = 0;
  const fetchedUrls = [];
  try {
    const result = await triggerProjectResearch(
      db,
      PROJECT_ID,
      "estimator@example.com",
      false,
      {
        lookupPublicDotProject: async (requestedId) => {
          lookupCount += 1;
          assert.equal(requestedId, PROJECT_ID);
          return publicDotProject();
        },
        fetchImpl: async (input, init) => {
          const url = String(input);
          fetchedUrls.push(url);
          assert.equal(init?.credentials, "omit");
          assert.ok(
            ["wsdot.wa.gov", "ftp.wsdot.wa.gov"].includes(
              new URL(url).hostname,
            ),
          );
          return new Response(
            "<html><body><h1>Official WSDOT project record</h1></body></html>",
            { status: 200, headers: { "content-type": "text/html" } },
          );
        },
        resolveHost: PUBLIC_DNS,
        now: () => NOW,
      },
    );

    assert.equal(lookupCount, 1);
    assert.equal(result.projectId, PROJECT_ID);
    assert.equal(result.lifecycle.some((finding) =>
      finding.officialStatus === "Advertised" &&
      finding.provenance.strategy === "configured-exact-record"
    ), true);
    assert.deepEqual(
      result.contacts.map((contact) => contact.email),
      ["jane.engineer@wsdot.wa.gov"],
    );
    assert.deepEqual(
      result.documents
        .map((document) => document.documentType)
        .sort(),
      ["plans", "specifications"],
    );
    assert.equal(
      result.documents.some((document) =>
        document.url.includes("attacker.example")
      ),
      false,
    );

    const source = database.prepare(
      `SELECT id, name, owner, jurisdiction_name, jurisdiction_level, connector,
              source_class, source_url, access_mode, cadence_minutes, status,
              lifecycle_stages
       FROM sources WHERE id=?`,
    ).get(SOURCE_ID);
    assert.deepEqual({ ...source }, {
      id: SOURCE_ID,
      name: PUBLIC_DOT_SOURCE_TEMPLATES[SOURCE_ID].name,
      owner: PUBLIC_DOT_SOURCE_TEMPLATES[SOURCE_ID].owner,
      jurisdiction_name: "Washington",
      jurisdiction_level: "state",
      connector: "public-dot-exact",
      source_class: "procurement",
      source_url: PUBLIC_DOT_SOURCE_TEMPLATES[SOURCE_ID].url,
      access_mode: "open",
      cadence_minutes: 1440,
      status: "live",
      lifecycle_stages: JSON.stringify(["bidding"]),
    });
    assert.deepEqual(
      { ...database.prepare(
        `SELECT project_id, source_id, source_record_id, source_url, confidence
         FROM project_sources WHERE project_id=?`,
      ).get(PROJECT_ID) },
      {
        project_id: PROJECT_ID,
        source_id: SOURCE_ID,
        source_record_id: RECORD_ID,
        source_url: PROJECT_URL,
        confidence: "official",
      },
    );
    assert.deepEqual(await loadProjectOfficialSources(db, PROJECT_ID), [{
      sourceId: SOURCE_ID,
      sourceLabel: PUBLIC_DOT_SOURCE_TEMPLATES[SOURCE_ID].name,
      url: PROJECT_URL,
      strategy: "configured-exact-record",
      allowedHosts: ["wsdot.wa.gov"],
    }]);
    assert.deepEqual(
      fetchedUrls,
      [],
      "a bound public-dot exact result must not be re-fetched through the generic page path",
    );
  } finally {
    database.close();
  }
});
