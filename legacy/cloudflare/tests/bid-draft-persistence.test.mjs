import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const {
  BidDraftInputError,
  loadBidDraft,
  parseSaveBidDraftRequest,
  persistBidDraft,
} = await import("../db/bid-draft-repository.ts");

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

function request(overrides = {}) {
  return {
    project: {
      id: "caltrans-contracting-opportunities:04-0W0504",
      canonicalKey: "caltrans-contracting-opportunities:04-0W0504",
      title: "Trash capture devices and lighting",
      summary: "Official Caltrans opportunity",
      stage: "bidding",
      status: "Advertised",
      agency: "California Department of Transportation",
      state: "CA",
      estimatedValue: 1250000,
      postedAt: "2026-07-10T12:00:00Z",
      bidDate: "2026-08-20T21:00:00Z",
      sourceId: "caltrans-contracting-opportunities",
      sourceUrl: "https://dot.ca.gov/programs/procurement-and-contracts/contracts-out-for-bid",
    },
    draft: {
      quoteNumber: "DRAFT-0W0504",
      packageName: "Architectural systems quote",
      scope: "Fabricate and deliver the specified systems.",
      exclusions: "Installation excluded.",
      leadTime: "10 weeks",
      validity: "30 days",
      lineItems: [
        {
          id: "line-1",
          description: "Architectural system package",
          quantity: 2,
          unit: "each",
          unitPrice: 12500,
        },
      ],
      messageSubject: "Quote package",
      messageBody: "Please review the attached quote draft.",
      readiness: {
        documents: true,
        scope: true,
        pricing: true,
        terms: true,
        authority: false,
      },
    },
    pipelineStage: "package",
    recipients: [
      {
        clientId: "recipient:agency",
        participantName: "Caltrans",
        role: "agency",
        channel: "",
        verified: true,
      },
      {
        clientId: "recipient:contractor",
        participantName: "Example GC",
        role: "contractor",
        channel: "estimating@example.com",
        verificationSourceUrl: "https://example.com/contact",
        verified: true,
      },
    ],
    ...overrides,
  };
}

async function migrationFiles() {
  return (await readdir(new URL("../drizzle/", import.meta.url)))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

async function applyMigrationFiles(database, files) {
  for (const file of files) {
    const migration = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
}

async function databaseFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  await applyMigrationFiles(database, await migrationFiles());
  return { database, d1: new D1Fixture(database) };
}

test("owner migration gives every legacy package the latest eligible creator of its opportunity", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  const files = await migrationFiles();
  await applyMigrationFiles(database, files.filter((name) => name < "0012_"));

  database.prepare(
    `INSERT INTO supplier_profiles (
       id, legal_name, website, address_line_1, city, state, postal_code, products
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "supplier:tudelu-holdings",
    "Tudelu Holdings",
    "https://tudelu.com/",
    "1 Test Way",
    "New York",
    "NY",
    "10001",
    "[]",
  );
  database.prepare(
    `INSERT INTO projects (
       id, canonical_key, title, stage, status, agency
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("legacy-project", "legacy-project", "Legacy project", "bidding", "Open", "Agency");
  database.prepare(
    `INSERT INTO projects (
       id, canonical_key, title, stage, status, agency
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("fallback-project", "fallback-project", "Fallback project", "bidding", "Open", "Agency");
  database.prepare(
    `INSERT INTO bid_opportunities (
       id, supplier_profile_id, project_id, project_title_snapshot, project_stage_snapshot
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "legacy-opportunity",
    "supplier:tudelu-holdings",
    "legacy-project",
    "Legacy project",
    "bidding",
  );
  database.prepare(
    `INSERT INTO bid_opportunities (
       id, supplier_profile_id, project_id, project_title_snapshot, project_stage_snapshot
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "fallback-opportunity",
    "supplier:tudelu-holdings",
    "fallback-project",
    "Fallback project",
    "bidding",
  );

  const insertPackage = database.prepare(
    `INSERT INTO bid_packages (
       id, bid_opportunity_id, package_number, title, created_by, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertPackage.run(
    "package-alice",
    "legacy-opportunity",
    "ALICE-1",
    "Alice package",
    "alice@example.com",
    "2026-01-01T00:00:00.000Z",
  );
  insertPackage.run(
    "package-bob",
    "legacy-opportunity",
    "BOB-1",
    "Bob package",
    " BOB@Example.com ",
    "2026-02-01T00:00:00.000Z",
  );
  insertPackage.run(
    "package-invalid-newer",
    "legacy-opportunity",
    "INVALID-1",
    "Invalid newer package",
    "workspace user",
    "2026-03-01T00:00:00.000Z",
  );
  insertPackage.run(
    "package-fallback",
    "fallback-opportunity",
    "FALLBACK-1",
    "Fallback package",
    "workspace user",
    "2026-04-01T00:00:00.000Z",
  );

  await applyMigrationFiles(database, ["0012_fearless_major_mapleleaf.sql"]);

  assert.deepEqual(
    database.prepare(
      `SELECT id, owner_key AS ownerKey
       FROM bid_opportunities
       ORDER BY id`,
    ).all().map((row) => ({ ...row })),
    [
      { id: "fallback-opportunity", ownerKey: "legacy-workspace" },
      { id: "legacy-opportunity", ownerKey: "bob@example.com" },
    ],
  );
  assert.deepEqual(
    database.prepare(
      `SELECT packages.id, packages.owner_key AS packageOwner,
              opportunities.owner_key AS opportunityOwner
       FROM bid_packages packages
       JOIN bid_opportunities opportunities
         ON opportunities.id=packages.bid_opportunity_id
       ORDER BY packages.id`,
    ).all().map((row) => ({ ...row })),
    [
      { id: "package-alice", packageOwner: "bob@example.com", opportunityOwner: "bob@example.com" },
      { id: "package-bob", packageOwner: "bob@example.com", opportunityOwner: "bob@example.com" },
      { id: "package-fallback", packageOwner: "legacy-workspace", opportunityOwner: "legacy-workspace" },
      { id: "package-invalid-newer", packageOwner: "bob@example.com", opportunityOwner: "bob@example.com" },
    ],
  );

  const d1 = new D1Fixture(database);
  assert.equal((await loadBidDraft(d1, "legacy-project", "bob@example.com"))?.opportunityId, "legacy-opportunity");
  assert.equal(await loadBidDraft(d1, "legacy-project", "alice@example.com"), null);
  database.close();
});

test("bid-draft parser bounds fields and never treats an unresolved route as verified", () => {
  const parsed = parseSaveBidDraftRequest(request());
  assert.equal(parsed.recipients[0].channel, "");
  assert.equal(parsed.recipients[0].verified, false);
  assert.equal(parsed.recipients[1].verified, true);
  assert.equal(parsed.recipients[1].verificationSourceUrl, "https://example.com/contact");
  assert.equal(parsed.draft.lineItems[0].quantity, 2);

  assert.throws(
    () => parseSaveBidDraftRequest(request({ pipelineStage: "submitted" })),
    (error) => error instanceof BidDraftInputError && error.code === "invalid_enum",
  );
  assert.throws(
    () => parseSaveBidDraftRequest(request({
      recipients: [{
        clientId: "bad",
        participantName: "Bad route",
        role: "contractor",
        channel: "javascript:alert(1)",
        verified: true,
      }],
    })),
    (error) => error instanceof BidDraftInputError && error.code === "invalid_recipient_channel",
  );

  const portal = parseSaveBidDraftRequest(request({
    recipients: [{
      clientId: "portal",
      participantName: "Procurement portal",
      role: "agency",
      channel: "https://procurement.example.gov/bids/123",
      verificationSourceUrl: "https://procurement.example.gov/contact",
      verified: true,
    }],
  }));
  assert.equal(portal.recipients[0].channel, "https://procurement.example.gov/bids/123");
  assert.equal(portal.recipients[0].verified, true);

  const missingEvidence = parseSaveBidDraftRequest(request({
    recipients: [{
      clientId: "unproven",
      participantName: "Unproven route",
      role: "contractor",
      channel: "estimating@example.com",
      verified: true,
    }],
  }));
  assert.equal(missingEvidence.recipients[0].verified, false);
  assert.throws(
    () => parseSaveBidDraftRequest(request({
      recipients: [{
        clientId: "bad-evidence",
        participantName: "Bad evidence",
        role: "contractor",
        channel: "estimating@example.com",
        verificationSourceUrl: "mailto:estimating@example.com",
        verified: true,
      }],
    })),
    (error) =>
      error instanceof BidDraftInputError &&
      error.code === "invalid_recipient_verification_source",
  );

  for (const channel of [
    "https://",
    "https://localhost/bids",
    "https://user:secret@example.gov/bids",
    String.raw`https:\example.gov\bids`,
    "estimator..team@example.com",
  ]) {
    assert.throws(
      () => parseSaveBidDraftRequest(request({
        recipients: [{
          clientId: "malformed",
          participantName: "Malformed route",
          role: "contractor",
          channel,
          verified: true,
        }],
      })),
      (error) => error instanceof BidDraftInputError && error.code === "invalid_recipient_channel",
      `expected ${channel} to be rejected`,
    );
  }
});

test("private bid drafts round-trip through the existing package schema without submitting", async () => {
  const { database, d1 } = await databaseFixture();
  const parsed = parseSaveBidDraftRequest(request());
  const saved = await persistBidDraft(d1, parsed, "estimator@tudelu.com", "2026-07-16T18:00:00.000Z");
  assert.equal(saved.notice, "Draft saved privately. Nothing was emailed, uploaded, or submitted.");

  const loaded = await loadBidDraft(d1, parsed.project.id, "estimator@tudelu.com");
  assert.ok(loaded);
  assert.equal(loaded.draft.scope, parsed.draft.scope);
  assert.equal(loaded.draft.lineItems.length, 1);
  assert.equal(loaded.draft.lineItems[0].unitPrice, 12500);
  assert.equal(loaded.pipelineStage, "package");
  assert.equal(loaded.recipients.length, 2);
  assert.equal(loaded.recipients[0].verified, false);
  assert.equal(loaded.recipients[1].verified, true);

  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM bid_packages").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM bid_submissions").get().count, 0);
  assert.equal(
    database.prepare("SELECT approval_status AS status FROM bid_packages").get().status,
    "pending",
  );

  const replacement = parseSaveBidDraftRequest(request({
    draft: {
      ...request().draft,
      lineItems: [
        { id: "replacement", description: "Revised package", quantity: 1, unit: "lot", unitPrice: 30000 },
      ],
    },
    recipients: [],
  }));
  await persistBidDraft(d1, replacement, "estimator@tudelu.com", "2026-07-16T19:00:00.000Z");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM bid_packages").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM bid_line_items").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM bid_recipients").get().count, 0);
  assert.equal(database.prepare("SELECT total FROM bid_packages").get().total, 30000);

  database.close();
});

test("private bid drafts are isolated by authenticated owner", async () => {
  const { database, d1 } = await databaseFixture();
  const alice = parseSaveBidDraftRequest(request({
    draft: {
      ...request().draft,
      quoteNumber: "ALICE-QUOTE",
      scope: "Alice private scope",
    },
  }));
  const bob = parseSaveBidDraftRequest(request({
    draft: {
      ...request().draft,
      quoteNumber: "BOB-QUOTE",
      scope: "Bob private scope",
    },
  }));

  await persistBidDraft(d1, alice, "Alice@Example.com", "2026-07-16T18:00:00.000Z");
  assert.equal(await loadBidDraft(d1, alice.project.id, "mallory@example.com"), null);
  await persistBidDraft(d1, bob, "bob@example.com", "2026-07-16T19:00:00.000Z");

  const aliceLoaded = await loadBidDraft(d1, alice.project.id, "alice@example.com");
  const bobLoaded = await loadBidDraft(d1, bob.project.id, "BOB@example.com");
  assert.equal(aliceLoaded?.draft.quoteNumber, "ALICE-QUOTE");
  assert.equal(aliceLoaded?.draft.scope, "Alice private scope");
  assert.equal(aliceLoaded?.savedBy, "alice@example.com");
  assert.equal(bobLoaded?.draft.quoteNumber, "BOB-QUOTE");
  assert.equal(bobLoaded?.draft.scope, "Bob private scope");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM bid_opportunities").get().count, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM bid_packages").get().count, 2);
  assert.deepEqual(
    database.prepare("SELECT DISTINCT owner_key AS owner FROM bid_packages ORDER BY owner")
      .all()
      .map((row) => ({ ...row })),
    [{ owner: "alice@example.com" }, { owner: "bob@example.com" }],
  );

  database.close();
});

test("saving a client snapshot never overwrites an existing canonical project", async () => {
  const { database, d1 } = await databaseFixture();
  const base = request();
  database.prepare(
    `INSERT INTO projects (
       id, canonical_key, title, summary, stage, status, agency,
       owner_name, state, first_seen_at, last_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    base.project.id,
    base.project.canonicalKey,
    "Canonical server title",
    "Canonical server summary",
    "design",
    "Official plan review",
    "Canonical public agency",
    "Canonical owner",
    "CA",
    "2026-07-01T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
  );
  const tampered = parseSaveBidDraftRequest(request({
    project: {
      ...base.project,
      title: "Untrusted browser title",
      summary: "Untrusted browser summary",
      stage: "awarded",
      status: "Browser says awarded",
      agency: "Untrusted browser agency",
      ownerName: "Untrusted browser owner",
    },
  }));

  await persistBidDraft(d1, tampered, "estimator@example.com", "2026-07-16T20:00:00.000Z");
  assert.deepEqual(
    { ...database.prepare(
      `SELECT title, summary, stage, status, agency, owner_name AS ownerName, updated_at AS updatedAt
       FROM projects WHERE id=?`,
    ).get(base.project.id) },
    {
      title: "Canonical server title",
      summary: "Canonical server summary",
      stage: "design",
      status: "Official plan review",
      agency: "Canonical public agency",
      ownerName: "Canonical owner",
      updatedAt: "2026-07-15T00:00:00.000Z",
    },
  );
  assert.ok(await loadBidDraft(d1, base.project.id, "estimator@example.com"));

  database.close();
});

test("Bid Desk releases failed hydration attempts and exposes an explicit retry", async () => {
  const source = await readFile(new URL("../app/BidDesk.tsx", import.meta.url), "utf8");
  assert.match(source, /hydratingDraftProjects = useRef\(new Map<string, AbortController>\(\)\)/);
  assert.match(source, /const releaseHydration = \(\) =>/);
  assert.match(source, /hydratedDraftProjects\.current\.delete\(projectId\)/);
  assert.match(source, /setDraftHydrationAttempt\(\(current\) => current \+ 1\)/);
  assert.match(source, />\s*Retry draft load\s*</);
});
