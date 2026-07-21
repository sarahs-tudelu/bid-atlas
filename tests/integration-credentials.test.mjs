import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const {
  IntegrationCredentialError,
  deleteIntegrationCredential,
  getIntegrationCredential,
  listIntegrationCredentials,
  parseIntegrationProvider,
  upsertIntegrationCredential,
} = await import("../app/lib/integration-credentials.ts");

const { localDevelopmentUserEmail } = await import(
  "../app/lib/local-development-auth.ts"
);

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

const MASTER_KEY = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index + 1),
).toString("base64");

test("credential vault encrypts per owner and never returns stored secret metadata", async () => {
  const original = process.env.BIDATLAS_CREDENTIALS_MASTER_KEY;
  process.env.BIDATLAS_CREDENTIALS_MASTER_KEY = MASTER_KEY;
  const { database, db } = await databaseFixture();
  const secret = "apollo-test-key-with-sensitive-value";
  try {
    const saved = await upsertIntegrationCredential(
      db,
      "owner@example.com",
      "apollo",
      secret,
      new Date("2026-07-16T20:00:00.000Z"),
    );
    assert.equal(saved.provider, "apollo");
    assert.equal(saved.updatedAt, "2026-07-16T20:00:00.000Z");

    const raw = database.prepare(
      "SELECT owner_key, encrypted_secret, iv FROM integration_credentials",
    ).get();
    assert.equal(raw.owner_key, "owner@example.com");
    assert.notEqual(raw.encrypted_secret, secret);
    assert.equal(String(raw.encrypted_secret).includes(secret), false);
    assert.notEqual(raw.iv, "");

    const listed = await listIntegrationCredentials(db, "owner@example.com");
    assert.deepEqual(listed, [{
      provider: "apollo",
      createdAt: "2026-07-16T20:00:00.000Z",
      updatedAt: "2026-07-16T20:00:00.000Z",
    }]);
    assert.equal(JSON.stringify(listed).includes(secret), false);
    assert.equal(
      await getIntegrationCredential(db, "owner@example.com", "apollo"),
      secret,
    );
    assert.equal(
      await getIntegrationCredential(db, " Owner@Example.COM ", "apollo"),
      secret,
    );
    assert.equal(
      await getIntegrationCredential(db, "different@example.com", "apollo"),
      null,
    );

    await deleteIntegrationCredential(db, "different@example.com", "apollo");
    assert.equal(await getIntegrationCredential(db, "owner@example.com", "apollo"), secret);
    await deleteIntegrationCredential(db, "owner@example.com", "apollo");
    assert.deepEqual(await listIntegrationCredentials(db, "owner@example.com"), []);
  } finally {
    database.close();
    restoreEnvironment("BIDATLAS_CREDENTIALS_MASTER_KEY", original);
  }
});

test("credential vault binds ciphertext to owner and provider with AES-GCM", async () => {
  const original = process.env.BIDATLAS_CREDENTIALS_MASTER_KEY;
  process.env.BIDATLAS_CREDENTIALS_MASTER_KEY = MASTER_KEY;
  const { database, db } = await databaseFixture();
  try {
    await upsertIntegrationCredential(
      db,
      "owner@example.com",
      "sam",
      "sam-sensitive-test-key",
    );
    const row = database.prepare(
      "SELECT encrypted_secret, iv, key_version FROM integration_credentials WHERE owner_key=?",
    ).get("owner@example.com");
    database.prepare(
      `INSERT INTO integration_credentials (
         id, owner_key, provider, encrypted_secret, iv, key_version
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      "attacker@example.com",
      "sam",
      row.encrypted_secret,
      row.iv,
      row.key_version,
    );
    await assert.rejects(
      () => getIntegrationCredential(db, "attacker@example.com", "sam"),
      (error) => error instanceof IntegrationCredentialError &&
        error.code === "credential_decryption_failed",
    );
  } finally {
    database.close();
    restoreEnvironment("BIDATLAS_CREDENTIALS_MASTER_KEY", original);
  }
});

test("credential vault fails closed without an exact 32-byte base64 master key", async () => {
  const original = process.env.BIDATLAS_CREDENTIALS_MASTER_KEY;
  process.env.BIDATLAS_CREDENTIALS_MASTER_KEY = "not-a-valid-master-key";
  const { database, db } = await databaseFixture();
  try {
    await assert.rejects(
      () => upsertIntegrationCredential(
        db,
        "owner@example.com",
        "apollo",
        "apollo-sensitive-test-key",
      ),
      (error) => error instanceof IntegrationCredentialError &&
        error.code === "credential_vault_not_configured",
    );
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM integration_credentials").get().count,
      0,
    );
  } finally {
    database.close();
    restoreEnvironment("BIDATLAS_CREDENTIALS_MASTER_KEY", original);
  }
});

test("integration provider allowlist rejects arbitrary credential namespaces", () => {
  assert.equal(parseIntegrationProvider("SAM"), "sam");
  assert.equal(parseIntegrationProvider("apollo"), "apollo");
  assert.throws(
    () => parseIntegrationProvider("custom-webhook"),
    (error) => error instanceof IntegrationCredentialError &&
      error.code === "invalid_integration_provider",
  );
});

test("integration settings are authenticated, write-only, and do not store secrets in browser storage", async () => {
  const [page, client, route, repository, migration, projectsPage] = await Promise.all([
    readFile(new URL("../app/integrations/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/integrations/IntegrationsClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/integration-credentials.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0014_careless_master_chief.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/projects/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /getChatGPTUser\(\)/);
  assert.match(page, /chatGPTSignInPath\("\/integrations"\)/);
  assert.match(page, /user\s*\?\s*\(\s*<IntegrationsClient/s);
  assert.match(client, /type="password"/);
  assert.match(client, /method:\s*"PUT"/);
  assert.match(client, /method:\s*"DELETE"/);
  assert.doesNotMatch(client, /localStorage|sessionStorage/);
  assert.doesNotMatch(client, /\?apiKey|URLSearchParams.*apiKey/s);
  assert.match(route, /actor\.kind !== "workspace-user"/);
  assert.match(route, /getIntegrationCredential\(db, actor\.id, "apollo"\)/);
  assert.match(repository, /additionalData:\s*credentialAdditionalData/);
  assert.match(repository, /AES-GCM/);
  assert.match(migration, /CREATE UNIQUE INDEX[^\n]+\(`owner_key`,`provider`\)/);
  assert.doesNotMatch(route, /console\.(?:log|error|warn)/);
  assert.doesNotMatch(repository, /console\.(?:log|error|warn)/);
  assert.match(projectsPage, /resolveIntegrationCredential/);
  assert.match(projectsPage, /getDashboardFeed\(\{ samApiKey: samCredential\?\.apiKey \}\)/);
});

test("local development identity requires an explicit email and a loopback host", () => {
  for (const host of [
    "localhost",
    "localhost:3000",
    "127.0.0.1:3000",
    "[::1]:3000",
    "::1",
  ]) {
    assert.equal(
      localDevelopmentUserEmail({
        development: true,
        host,
        configuredEmail: " Local.User@Example.Test ",
      }),
      "local.user@example.test",
    );
  }
});

test("local development identity cannot activate in production or on a network host", () => {
  const configuredEmail = "local.user@example.test";
  for (const options of [
    { development: false, host: "localhost" },
    { development: undefined, host: "localhost" },
    { development: true, host: "bidatlas.example.com" },
    { development: true, host: "localhost.example.com" },
    { development: true, host: "localhost@evil.example" },
    { development: true, host: "192.168.1.20:3000" },
  ]) {
    assert.equal(
      localDevelopmentUserEmail({ ...options, configuredEmail }),
      null,
    );
  }
});

test("local development identity rejects missing and malformed email settings", () => {
  for (const configuredEmail of [undefined, "", "local-user", "local@localhost", "a b@example.test"]) {
    assert.equal(
      localDevelopmentUserEmail({
        development: true,
        host: "localhost:3000",
        configuredEmail,
      }),
      null,
    );
  }
});

test("ChatGPT auth centralizes the local fallback and documents an empty example setting", async () => {
  const [authSource, environmentExample] = await Promise.all([
    readFile(new URL("../app/chatgpt-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);

  assert.match(authSource, /platformEmail \?\? localDevelopmentUserEmail\(\{/);
  assert.match(authSource, /development:\s*import\.meta\.env\.DEV/);
  assert.match(authSource, /host:\s*requestHeaders\.get\("host"\)/);
  assert.match(authSource, /configuredEmail:\s*await configuredLocalDevelopmentEmail\(\)/);
  assert.match(authSource, /await import\("cloudflare:workers"\)/);
  assert.match(environmentExample, /^BIDATLAS_DEV_USER_EMAIL=$/m);
  assert.doesNotMatch(environmentExample, /^BIDATLAS_DEV_USER_EMAIL=.+$/m);
});

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
