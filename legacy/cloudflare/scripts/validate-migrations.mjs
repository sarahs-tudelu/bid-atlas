import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = join(projectRoot, "drizzle");
const files = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort();

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");

for (const file of files) {
  const migration = readFileSync(join(migrationDirectory, file), "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
  database.exec(migration);
}

const tableCount = database
  .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'")
  .get().count;
const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();

if (foreignKeyViolations.length) {
  console.error(JSON.stringify({ files, tableCount, foreignKeyViolations }, null, 2));
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      { migrations: files.length, latest: files.at(-1), tableCount, foreignKeyViolations: 0 },
      null,
      2,
    ),
  );
}
