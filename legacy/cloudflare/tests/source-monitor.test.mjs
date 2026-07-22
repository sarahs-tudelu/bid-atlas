import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

register(new URL("./ts-extension-loader.mjs", import.meta.url));

const {
  assessPostingReadiness,
  SourceMonitorInputError,
} = await import("../app/lib/source-monitors/contracts.ts");
const { fetchPublicSourceText } = await import("../app/lib/source-monitors/network.ts");
const { parsePostedProjectFeed } = await import("../app/lib/source-monitors/parser.ts");
const {
  createSourceMonitor,
  listSourceMonitors,
  reviewSourceCandidate,
  upsertDiscoveredPostings,
} = await import("../app/lib/source-monitors/repository.ts");

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
    const sql = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
  return { database, db: new D1Fixture(database) };
}

function context(overrides = {}) {
  return {
    publisher: "Example Construction Authority",
    city: "New York",
    state: "NY",
    sourceType: "public-procurement",
    feedUrl: "https://bids.example.gov/feed.json",
    feedFormat: "auto",
    ...overrides,
  };
}

test("structured feeds normalize complete posted projects into bid-ready candidates", () => {
  const body = JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    items: [{
      id: "ITB-2026-104",
      url: "https://bids.example.gov/projects/ITB-2026-104",
      title: "Roof replacement at North Campus",
      summary: "Invitation to bid for removal and replacement of the existing roofing system.",
      date_published: "2026-07-20T13:00:00Z",
      bid_date: "2026-08-28",
      plans_url: "https://bids.example.gov/projects/ITB-2026-104/specifications.pdf",
      document_name: "Roof replacement plans and specifications",
      contact: { name: "Procurement Desk", email: "bids@example.gov" },
      submission_url: "https://bids.example.gov/submit/ITB-2026-104",
      tags: ["roofing", "demolition"],
    }],
  });
  const postings = parsePostedProjectFeed(body, "application/feed+json", context());
  assert.equal(postings.length, 1);
  assert.equal(postings[0].sourceRecordId, "ITB-2026-104");
  assert.equal(postings[0].bidDate, "2026-08-28");
  assert.equal(postings[0].documentName, "Roof replacement plans and specifications");
  assert.equal(postings[0].contactEmail, "bids@example.gov");
  assert.deepEqual(
    assessPostingReadiness(postings[0], new Date("2026-07-21T12:00:00Z")),
    [],
  );
});

test("HTML discovery retains incomplete postings for review instead of claiming they are open bids", () => {
  const html = `
    <html><body><table><tr>
      <td><a href="/projects/library-renovation">Library renovation bid</a></td>
      <td>Proposals due August 30, 2026</td>
    </tr></table></body></html>`;
  const [posting] = parsePostedProjectFeed(
    html,
    "text/html",
    context({ feedUrl: "https://bids.example.gov/projects", feedFormat: "html" }),
  );
  assert.equal(posting.title, "Library renovation bid");
  assert.equal(posting.bidDate, "2026-08-30");
  assert.deepEqual(
    assessPostingReadiness(posting, new Date("2026-07-21T12:00:00Z")),
    ["missing-bid-documents"],
  );
});

test("source fetching rejects private DNS destinations before making the source request", async () => {
  let fetched = false;
  await assert.rejects(
    () => fetchPublicSourceText(
      "https://monitor.example/feed",
      async () => {
        fetched = true;
        return new Response("should not run");
      },
      async () => ["127.0.0.1"],
      1_000,
    ),
    (error) => error instanceof SourceMonitorInputError && error.code === "unsafe_source_resolution",
  );
  assert.equal(fetched, false);
});

test("verified feed postings materialize into the canonical project, document, contact, and evidence tables", async () => {
  const { database, db } = await databaseFixture();
  try {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const monitor = await createSourceMonitor(db, "owner@example.com", {
      name: "NYC pilot bids",
      publisher: "Example Construction Authority",
      jurisdiction: "New York City, New York",
      city: "New York",
      state: "NY",
      sourceType: "public-procurement",
      feedUrl: "https://bids.example.gov/feed.json",
      feedFormat: "json-feed",
      cadenceMinutes: 1_440,
    }, now);
    const [posting] = parsePostedProjectFeed(JSON.stringify({ items: [{
      id: "ITB-2026-104",
      url: "https://bids.example.gov/projects/ITB-2026-104",
      title: "Roof replacement at North Campus",
      summary: "Invitation to bid for removal and replacement of the existing roofing system.",
      date_published: "2026-07-20T13:00:00Z",
      bid_date: "2026-08-28",
      plans_url: "https://bids.example.gov/projects/ITB-2026-104/specifications.pdf",
      contact_name: "Procurement Desk",
      contact_email: "bids@example.gov",
      tags: ["roofing"],
    }] }), "application/json", monitor);

    const saved = await upsertDiscoveredPostings(db, monitor, [posting], now);
    assert.equal(saved.discovered, 1);
    assert.equal(saved.verified, 1);
    assert.equal(saved.needsReview, 0);
    assert.ok(saved.candidates[0].projectId);

    const project = database.prepare(
      `SELECT stage, status, bid_date, agency FROM projects WHERE id=?`,
    ).get(saved.candidates[0].projectId);
    assert.deepEqual({ ...project }, {
      stage: "bidding",
      status: "Accepting bids",
      bid_date: "2026-08-28",
      agency: "Example Construction Authority",
    });
    assert.equal(database.prepare("SELECT count(*) AS count FROM documents").get().count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM contacts").get().count, 1);
    assert.equal(database.prepare(
      "SELECT accepting_bids FROM project_opportunity_verifications",
    ).get().accepting_bids, 1);

    const ownerView = await listSourceMonitors(db, "OWNER@EXAMPLE.COM");
    assert.equal(ownerView.monitors[0].candidateCount, 1);
    assert.equal(ownerView.monitors[0].verifiedCount, 1);
    assert.equal((await listSourceMonitors(db, "other@example.com")).monitors.length, 0);
  } finally {
    database.close();
  }
});

test("reviewers can complete an incomplete posting before it is published", async () => {
  const { database, db } = await databaseFixture();
  try {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const monitor = await createSourceMonitor(db, "reviewer@example.com", {
      name: "Local GC planroom",
      publisher: "Example General Contractor",
      jurisdiction: "New York City, New York",
      city: "New York",
      state: "NY",
      sourceType: "gc-planroom",
      feedUrl: "https://gc.example.com/bids",
      feedFormat: "html",
      cadenceMinutes: 1_440,
    }, now);
    const [posting] = parsePostedProjectFeed(
      `<table><tr><td><a href="/bids/storefront">Storefront construction bid</a></td><td>Quotes due 09/05/2026</td></tr></table>`,
      "text/html",
      monitor,
    );
    const saved = await upsertDiscoveredPostings(db, monitor, [posting], now);
    assert.equal(saved.needsReview, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM projects").get().count, 0);

    const verified = await reviewSourceCandidate(
      db,
      "reviewer@example.com",
      saved.candidates[0].id,
      {
        action: "verify",
        summary: "Invitation to quote the storefront construction scope.",
        city: "New York",
        state: "NY",
        bidDate: "2026-09-05",
        documentUrl: "https://gc.example.com/bids/storefront/specifications.pdf",
        documentName: "Storefront plans and specifications",
        tradeTags: ["storefront", "glazing"],
      },
      now,
    );
    assert.equal(verified.status, "verified");
    assert.ok(verified.projectId);
    assert.equal(database.prepare("SELECT count(*) AS count FROM projects").get().count, 1);
  } finally {
    database.close();
  }
});
