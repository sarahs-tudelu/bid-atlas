import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localD1Directory = join(
  projectRoot,
  ".wrangler",
  "state",
  "v3",
  "d1",
  "miniflare-D1DatabaseObject",
);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function localDatabasePath() {
  const explicit = argumentValue("--db");
  if (explicit) return resolve(explicit);
  const candidates = readdirSync(localD1Directory)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => join(localD1Directory, name));
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one local D1 database in ${localD1Directory}; found ${candidates.length}. Pass --db <path>.`,
    );
  }
  const candidate = resolve(candidates[0]);
  const withinLocalState = relative(localD1Directory, candidate);
  if (withinLocalState.startsWith("..")) {
    throw new Error("Resolved local D1 path escaped the expected Miniflare directory.");
  }
  return candidate;
}

const databasePath = localDatabasePath();
const database = new DatabaseSync(databasePath);
database.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
database.exec(`CREATE TABLE IF NOT EXISTS __bidatlas_local_migrations (
  name TEXT PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
database.exec(`CREATE TABLE IF NOT EXISTS __bidatlas_local_seeds (
  name TEXT PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

const migrationDirectory = join(projectRoot, "drizzle");
const migrations = readdirSync(migrationDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
for (const name of migrations) {
  const applied = database
    .prepare("SELECT 1 AS applied FROM __bidatlas_local_migrations WHERE name=?")
    .get(name);
  if (applied) continue;
  const sql = readFileSync(join(migrationDirectory, name), "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(sql);
    database
      .prepare("INSERT INTO __bidatlas_local_migrations (name) VALUES (?)")
      .run(name);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

if (process.argv.includes("--with-census")) {
  const censusPath = resolve(
    argumentValue("--census") ?? join(projectRoot, "outputs", "census-jurisdictions.sql"),
  );
  if (!existsSync(censusPath)) {
    throw new Error(
      `Census SQL was not found at ${censusPath}. Generate it with scripts/import-census-jurisdictions.mjs --out <path>.`,
    );
  }
  const censusSql = readFileSync(censusPath, "utf8");
  const seedHash = createHash("sha256").update(censusSql).digest("hex").slice(0, 16);
  const seedName = `census-government-units-2025:${seedHash}`;
  const applied = database
    .prepare("SELECT 1 AS applied FROM __bidatlas_local_seeds WHERE name=?")
    .get(seedName);
  if (!applied) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(censusSql);
      database
        .prepare("INSERT INTO __bidatlas_local_seeds (name) VALUES (?)")
        .run(seedName);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  const requiredSourceClasses = JSON.stringify([
    "planning",
    "permits",
    "procurement",
    "documents",
    "bid-results",
    "awards",
    "capital-plans",
  ]).replaceAll("'", "''");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`INSERT INTO jurisdiction_discovery_jobs (
      id,jurisdiction_id,status,priority,required_source_classes,completed_source_classes,
      source_candidates_found,connected_sources,loaded_projects,indexed_documents,
      attempt_count,next_run_at,created_at,updated_at
    )
    SELECT 'discovery:' || id,id,'queued',0,'${requiredSourceClasses}','[]',0,0,0,0,0,
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    FROM jurisdictions
    WHERE active=1
    ON CONFLICT(jurisdiction_id) DO NOTHING;

    INSERT INTO jurisdiction_metrics (jurisdiction_id,refreshed_at)
    SELECT id,CURRENT_TIMESTAMP
    FROM jurisdictions
    WHERE active=1
    ON CONFLICT(jurisdiction_id) DO NOTHING;`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const counts = {
  databasePath,
  migrations: Number(
    database.prepare("SELECT count(*) AS count FROM __bidatlas_local_migrations").get().count,
  ),
  tables: Number(
    database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get().count,
  ),
  jurisdictions: Number(database.prepare("SELECT count(*) AS count FROM jurisdictions").get().count),
  discoveryJobs: Number(
    database.prepare("SELECT count(*) AS count FROM jurisdiction_discovery_jobs").get().count,
  ),
  jurisdictionMetrics: Number(
    database.prepare("SELECT count(*) AS count FROM jurisdiction_metrics").get().count,
  ),
  projects: Number(database.prepare("SELECT count(*) AS count FROM projects").get().count),
  foreignKeyViolations: database.prepare("PRAGMA foreign_key_check").all().length,
};
console.log(JSON.stringify(counts, null, 2));
