import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  PORTAL_FAMILIES,
  classifyPortal,
  createSafePortalAdapterCandidate,
} from "../app/lib/portal-classification.ts";
import { STATE_SOURCE_REGISTRY } from "../app/lib/state-source-registry.ts";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("official URL and metadata signatures classify every supported portal family", () => {
  const cases = [
    ["socrata", "https://data.example.gov/resource/abcd-1234.json"],
    ["arcgis", "https://services.arcgis.com/example/arcgis/rest/services/Capital_Projects/FeatureServer/0"],
    ["ckan", "https://data.example.gov/api/3/action/package_search"],
    ["carto", "https://phl.carto.com/api/v2/sql?q=select%20*%20from%20permits"],
    ["opengov", "https://procurement.opengov.com/portal/example"],
    ["bonfire", "https://example.bonfirehub.com/portal"],
    ["planetbids", "https://pbsystem.planetbids.com/portal/example"],
    ["bidnet", "https://www.bidnetdirect.com/example"],
    ["ionwave", "https://example.ionwave.net/Login.aspx"],
    ["demandstar", "https://network.demandstar.com/for-business"],
    ["public-purchase", "https://www.publicpurchase.com/gems/example/buyer/public/home"],
    ["html", STATE_SOURCE_REGISTRY.find((source) => source.code === "AZ").procurementUrl],
    ["manual", "https://procurement.example.gov/notices/bid-package.pdf"],
    ["unknown", "ftp://procurement.example.gov/notices"],
  ];

  assert.deepEqual(cases.map(([family]) => family), PORTAL_FAMILIES);
  for (const [expectedFamily, url] of cases) {
    const classification = classifyPortal({ url });
    assert.equal(classification.family, expectedFamily, url);
    assert.ok(classification.evidence.length > 0, url);
    assert.equal(classification.requiresHumanReview, true);
  }
});

test("classification uses bounded host suffixes and exposes conflicting evidence", () => {
  const spoofed = classifyPortal({ url: "https://opengov.com.evil.example/opportunities" });
  assert.equal(spoofed.family, "html");

  const metadataOnly = classifyPortal({
    url: "https://procurement.example.gov/opportunities",
    description: "Official opportunities powered by Bonfire",
  });
  assert.equal(metadataOnly.family, "bonfire");
  assert.ok(metadataOnly.evidence.some((item) => item.signal === "bonfire-name"));

  const conflict = classifyPortal({
    url: "https://procurement.opengov.com/portal/example",
    description: "Legacy listing described as powered by Bonfire",
  });
  assert.equal(conflict.family, "opengov");
  assert.equal(conflict.confidence, "medium");
  assert.deepEqual(conflict.conflictingFamilies.map((item) => item.family), ["bonfire"]);
});

test("safe candidates reject credentials and never imply connection or automated access", () => {
  const credentialBearing = classifyPortal({
    url: "https://procurement.example.gov/opportunities?token=do-not-retain",
  });
  assert.equal(credentialBearing.family, "unknown");
  assert.equal(credentialBearing.canonicalUrl, null);
  assert.doesNotMatch(JSON.stringify(credentialBearing), /do-not-retain/);
  assert.equal(
    createSafePortalAdapterCandidate({
      sourceKey: "example:unsafe",
      official: true,
      url: "https://procurement.example.gov/opportunities?token=do-not-retain",
    }),
    null,
  );

  const input = {
    sourceKey: "state:EX:procurement",
    official: true,
    url: "https://procurement.opengov.com/portal/example",
  };
  const first = createSafePortalAdapterCandidate(input);
  const second = createSafePortalAdapterCandidate(input);
  assert.deepEqual(first, second);
  assert.equal(first.verificationStatus, "unverified");
  assert.equal(first.connectionState, "not-connected");
  assert.equal(first.safety.automatedNetworkAccess, "disabled-until-reviewed");
  assert.deepEqual(first.safety.allowedMethodsAfterReview, ["GET", "HEAD"]);
  assert.equal(first.safety.credentialPolicy, "never-automate-or-store");
  assert.equal(first.safety.accessControlPolicy, "do-not-bypass");
  assert.equal(first.officialUrl, new URL(input.url).toString());
  assert.equal(
    createSafePortalAdapterCandidate({ ...input, official: false }),
    null,
  );
});

test("all existing state and DC roots produce unique review-only candidates without derived URLs", () => {
  const candidates = STATE_SOURCE_REGISTRY.flatMap((state) => [
    createSafePortalAdapterCandidate({
      sourceKey: `state:${state.code}:procurement`,
      official: true,
      url: state.procurementUrl,
      owner: state.name,
    }),
    createSafePortalAdapterCandidate({
      sourceKey: `state:${state.code}:transportation`,
      official: true,
      url: state.transportationUrl,
      owner: state.name,
    }),
  ]);

  assert.equal(candidates.length, 102);
  assert.ok(candidates.every(Boolean));
  assert.equal(new Set(candidates.map((candidate) => candidate.id)).size, 102);
  assert.ok(candidates.every((candidate) => candidate.verificationStatus === "unverified"));
  assert.ok(candidates.every((candidate) => candidate.connectionState === "not-connected"));
  for (const candidate of candidates) {
    const state = STATE_SOURCE_REGISTRY.find((record) => candidate.sourceKey.includes(`:${record.code}:`));
    const sourceUrl = candidate.sourceKey.endsWith(":procurement")
      ? state.procurementUrl
      : state.transportationUrl;
    assert.equal(candidate.officialUrl, new URL(sourceUrl).toString());
  }
});

test("jurisdiction discovery persists classification only as gated candidate review metadata", async () => {
  const [worker, schema, migration] = await Promise.all([
    readFile(join(repoRoot, "worker", "jurisdiction-discovery.ts"), "utf8"),
    readFile(join(repoRoot, "db", "schema.ts"), "utf8"),
    readFile(join(repoRoot, "drizzle", "0011_robust_adam_destine.sql"), "utf8"),
  ]);

  assert.match(worker, /from "\.\.\/app\/lib\/portal-classification"/);
  assert.match(worker, /classifyPortal\(\{[\s\S]*url: candidate\.sourceUrl/);
  assert.match(worker, /createSafePortalAdapterCandidate\(/);
  assert.match(
    worker,
    /portalReview:\s*classifyDiscoveredCandidatePortal\(\{ id, \.\.\.candidate \}\)/,
  );
  assert.match(worker, /'unverified', 'not-connected', CURRENT_TIMESTAMP/);
  assert.doesNotMatch(worker, /INSERT INTO sources\b/);
  for (const column of [
    "portal_family",
    "portal_confidence",
    "portal_classifier_version",
    "portal_evidence",
    "portal_network_access_status",
    "portal_review_status",
    "portal_connection_state",
    "classified_at",
  ]) {
    assert.match(schema, new RegExp(`text\\(\"${column}\"|real\\(\"${column}\"`));
    assert.ok(migration.includes("ADD `" + column + "`"));
  }

  const sqlMatch = worker.match(
    /db\.prepare\(\s*`(INSERT INTO dataset_candidates[\s\S]*?)`,\s*\)\.bind\(/,
  );
  assert.ok(sqlMatch, "expected the production candidate upsert SQL");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE dataset_candidates (
      id text PRIMARY KEY NOT NULL,
      catalog text NOT NULL,
      publisher text,
      jurisdiction_name text,
      title text NOT NULL,
      description text,
      source_url text NOT NULL,
      api_url text,
      source_class text NOT NULL,
      status text DEFAULT 'candidate' NOT NULL,
      discovered_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
      last_verified_at text
    );
    CREATE UNIQUE INDEX dataset_candidates_catalog_uidx
      ON dataset_candidates (catalog, source_url);`);
    database.exec(migration.replaceAll("--> statement-breakpoint", ""));
    const upsert = database.prepare(sqlMatch[1]);
    const writeCandidate = (family, confidence, version, evidence) => upsert.run(
      "candidate-1",
      "Example publisher",
      "Example, NY",
      "Example capital projects",
      "Official catalog description",
      "https://example.bonfirehub.com/portal",
      "https://catalog.data.gov/search?q=example",
      "procurement",
      family,
      confidence,
      version,
      JSON.stringify(evidence),
      "disabled-until-reviewed",
    );

    writeCandidate("bonfire", 0.98, "classifier-a", { signals: ["hostname"] });
    let row = database.prepare(`SELECT
      portal_family AS portalFamily,
      portal_confidence AS portalConfidence,
      portal_classifier_version AS classifierVersion,
      portal_evidence AS portalEvidence,
      portal_network_access_status AS networkAccess,
      portal_review_status AS reviewStatus,
      portal_connection_state AS connectionState,
      classified_at AS classifiedAt
      FROM dataset_candidates WHERE id='candidate-1'`).get();
    assert.equal(row.portalFamily, "bonfire");
    assert.equal(row.portalConfidence, 0.98);
    assert.equal(row.classifierVersion, "classifier-a");
    assert.deepEqual(JSON.parse(row.portalEvidence), { signals: ["hostname"] });
    assert.equal(row.networkAccess, "disabled-until-reviewed");
    assert.equal(row.reviewStatus, "unverified");
    assert.equal(row.connectionState, "not-connected");
    assert.ok(row.classifiedAt);

    writeCandidate("opengov", 0.91, "classifier-b", { signals: ["metadata"] });
    row = database.prepare(`SELECT
      portal_family AS portalFamily,
      portal_classifier_version AS classifierVersion,
      portal_review_status AS reviewStatus,
      portal_connection_state AS connectionState
      FROM dataset_candidates WHERE id='candidate-1'`).get();
    assert.equal(row.portalFamily, "opengov");
    assert.equal(row.classifierVersion, "classifier-b");
    assert.equal(row.reviewStatus, "unverified");
    assert.equal(row.connectionState, "not-connected");

    database.prepare(`UPDATE dataset_candidates SET
      portal_family='human-reviewed-family',
      portal_confidence=1,
      portal_classifier_version='human-review',
      portal_evidence='{"reviewed":true}',
      portal_network_access_status='approved-public-read',
      portal_review_status='verified',
      portal_connection_state='reviewed-partial',
      classified_at='2026-07-16T00:00:00.000Z'
      WHERE id='candidate-1'`).run();
    writeCandidate("arcgis", 0.99, "classifier-c", { signals: ["new-automation"] });
    row = database.prepare(`SELECT
      portal_family AS portalFamily,
      portal_classifier_version AS classifierVersion,
      portal_evidence AS portalEvidence,
      portal_network_access_status AS networkAccess,
      portal_review_status AS reviewStatus,
      portal_connection_state AS connectionState,
      classified_at AS classifiedAt
      FROM dataset_candidates WHERE id='candidate-1'`).get();
    assert.equal(row.portalFamily, "human-reviewed-family");
    assert.equal(row.classifierVersion, "human-review");
    assert.deepEqual(JSON.parse(row.portalEvidence), { reviewed: true });
    assert.equal(row.networkAccess, "approved-public-read");
    assert.equal(row.reviewStatus, "verified");
    assert.equal(row.connectionState, "reviewed-partial");
    assert.equal(row.classifiedAt, "2026-07-16T00:00:00.000Z");
  } finally {
    database.close();
  }
});

test("seed enrichment is incremental, deterministic, and preserves review annotations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bidatlas-portals-"));
  const outputPath = join(directory, "portals.json");
  const scriptPath = join(repoRoot, "scripts", "enrich-jurisdiction-source-seeds.mjs");
  const firstCheckedAt = "2026-07-16T12:00:00.000Z";
  const laterCheckedAt = "2026-07-17T12:00:00.000Z";
  const recheckAt = "2026-07-18T12:00:00.000Z";

  try {
    const firstRun = await execFileAsync(process.execPath, [
      scriptPath,
      "--out",
      outputPath,
      "--checked-at",
      firstCheckedAt,
    ], { cwd: repoRoot });
    const firstSummary = JSON.parse(firstRun.stdout);
    assert.equal(firstSummary.changedRecords, 102);
    assert.equal(firstSummary.managedRecordCount, 102);

    const firstManifest = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(firstManifest.recordCount, 102);
    assert.equal(firstManifest.sourceRegistry.officialRoots, 102);
    assert.ok(firstManifest.records.every((record) => record.lastCheckedAt === firstCheckedAt));
    assert.ok(firstManifest.records.every((record) => record.checkScope === "registry-metadata-only"));
    assert.ok(firstManifest.records.every((record) => record.connectionState === "not-connected"));
    assert.deepEqual(
      firstManifest.records.map((record) => record.sourceKey),
      [...firstManifest.records.map((record) => record.sourceKey)].sort(),
    );

    firstManifest.records[0].reviewNotes = "Keep this human review annotation.";
    await writeFile(outputPath, `${JSON.stringify(firstManifest, null, 2)}\n`, "utf8");
    const unchangedRun = await execFileAsync(process.execPath, [
      scriptPath,
      "--out",
      outputPath,
      "--checked-at",
      laterCheckedAt,
    ], { cwd: repoRoot });
    assert.equal(JSON.parse(unchangedRun.stdout).changedRecords, 0);
    const unchangedBytes = await readFile(outputPath, "utf8");
    const unchangedManifest = JSON.parse(unchangedBytes);
    assert.equal(unchangedManifest.records[0].lastCheckedAt, firstCheckedAt);
    assert.equal(unchangedManifest.records[0].reviewNotes, "Keep this human review annotation.");

    await execFileAsync(process.execPath, [
      scriptPath,
      "--out",
      outputPath,
      "--checked-at",
      laterCheckedAt,
    ], { cwd: repoRoot });
    assert.equal(await readFile(outputPath, "utf8"), unchangedBytes);

    const withObservedMetadata = JSON.parse(unchangedBytes);
    withObservedMetadata.records[0].observedMetadata = {
      sourceUrl: withObservedMetadata.records[0].officialUrl,
      title: "Official opportunities powered by Bonfire",
      observedAt: laterCheckedAt,
    };
    await writeFile(outputPath, `${JSON.stringify(withObservedMetadata, null, 2)}\n`, "utf8");
    const metadataRun = await execFileAsync(process.execPath, [
      scriptPath,
      "--out",
      outputPath,
      "--checked-at",
      laterCheckedAt,
    ], { cwd: repoRoot });
    assert.equal(JSON.parse(metadataRun.stdout).changedRecords, 1);
    const metadataManifest = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(metadataManifest.records[0].classification.family, "bonfire");
    assert.equal(metadataManifest.records[0].lastCheckedAt, laterCheckedAt);
    assert.equal(metadataManifest.records[0].reviewNotes, "Keep this human review annotation.");

    await execFileAsync(process.execPath, [
      scriptPath,
      "--out",
      outputPath,
      "--checked-at",
      recheckAt,
      "--recheck-all",
    ], { cwd: repoRoot });
    const refreshedManifest = JSON.parse(await readFile(outputPath, "utf8"));
    assert.ok(refreshedManifest.records.every((record) => record.lastCheckedAt === recheckAt));
    assert.equal(refreshedManifest.records[0].firstSeenAt, firstCheckedAt);
    assert.equal(refreshedManifest.records[0].reviewNotes, "Keep this human review annotation.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
