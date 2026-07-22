const CREDENTIAL_KEY_VERSION = 1;
const CREDENTIAL_ALGORITHM = "AES-GCM";
const CREDENTIAL_IV_BYTES = 12;

export const INTEGRATION_PROVIDERS = ["sam", "apollo"] as const;

export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export type StoredIntegrationCredential = {
  provider: IntegrationProvider;
  createdAt: string;
  updatedAt: string;
};

export type ResolvedIntegrationCredential = {
  apiKey: string;
  scope: "personal" | "platform";
};

type IntegrationCredentialRow = {
  provider: string;
  encrypted_secret: string;
  iv: string;
  key_version: number;
  created_at: string;
  updated_at: string;
};

export interface IntegrationPreparedStatement {
  bind(...values: unknown[]): IntegrationPreparedStatement;
  run(): Promise<{ meta?: { changes?: number } } | unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] } | T[]>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface IntegrationD1Database {
  prepare(sql: string): IntegrationPreparedStatement;
}

export class IntegrationCredentialError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationCredentialError";
    this.status = status;
    this.code = code;
  }
}

function canonicalOwnerKey(value: string): string {
  return value.trim().toLowerCase();
}

export async function getIntegrationDatabase(): Promise<IntegrationD1Database> {
  try {
    const { env } = await import("cloudflare:workers");
    if (!env.DB) throw new Error("missing DB binding");
    return env.DB as IntegrationD1Database;
  } catch {
    throw new IntegrationCredentialError(
      503,
      "credential_store_unavailable",
      "The private integration vault is unavailable right now.",
    );
  }
}

export function parseIntegrationProvider(value: unknown): IntegrationProvider {
  if (typeof value !== "string") {
    throw new IntegrationCredentialError(
      400,
      "invalid_integration_provider",
      "Choose a supported integration provider.",
    );
  }
  const normalized = value.trim().toLowerCase();
  if (!INTEGRATION_PROVIDERS.includes(normalized as IntegrationProvider)) {
    throw new IntegrationCredentialError(
      400,
      "invalid_integration_provider",
      "Choose a supported integration provider.",
    );
  }
  return normalized as IntegrationProvider;
}

export function parseIntegrationApiKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new IntegrationCredentialError(
      400,
      "invalid_integration_api_key",
      "Enter an API key.",
    );
  }
  const apiKey = value.trim();
  if (
    apiKey.length < 8 ||
    apiKey.length > 2_048 ||
    /[\u0000-\u001F\u007F]/.test(apiKey)
  ) {
    throw new IntegrationCredentialError(
      400,
      "invalid_integration_api_key",
      "Enter a valid API key between 8 and 2,048 characters.",
    );
  }
  return apiKey;
}

export async function credentialsMasterKeyConfigured(): Promise<boolean> {
  try {
    await importCredentialsMasterKey();
    return true;
  } catch {
    return false;
  }
}

export async function listIntegrationCredentials(
  db: IntegrationD1Database,
  ownerKey: string,
): Promise<StoredIntegrationCredential[]> {
  ownerKey = canonicalOwnerKey(ownerKey);
  const result = await db.prepare(
    `SELECT provider, created_at, updated_at
       FROM integration_credentials
      WHERE owner_key=?
      ORDER BY provider`,
  ).bind(ownerKey).all<{
    provider: string;
    created_at: string;
    updated_at: string;
  }>();
  const rows = Array.isArray(result) ? result : result.results ?? [];
  return rows.flatMap((row) => {
    try {
      return [{
        provider: parseIntegrationProvider(row.provider),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }];
    } catch {
      return [];
    }
  });
}

export async function upsertIntegrationCredential(
  db: IntegrationD1Database,
  ownerKey: string,
  provider: IntegrationProvider,
  apiKey: string,
  now = new Date(),
): Promise<StoredIntegrationCredential> {
  ownerKey = canonicalOwnerKey(ownerKey);
  const normalizedApiKey = parseIntegrationApiKey(apiKey);
  const encrypted = await encryptCredential(ownerKey, provider, normalizedApiKey);
  const timestamp = now.toISOString();
  await db.prepare(
    `INSERT INTO integration_credentials (
       id, owner_key, provider, encrypted_secret, iv, key_version,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_key, provider) DO UPDATE SET
       encrypted_secret=excluded.encrypted_secret,
       iv=excluded.iv,
       key_version=excluded.key_version,
       updated_at=excluded.updated_at`,
  ).bind(
    crypto.randomUUID(),
    ownerKey,
    provider,
    encrypted.ciphertext,
    encrypted.iv,
    CREDENTIAL_KEY_VERSION,
    timestamp,
    timestamp,
  ).run();
  const stored = await findCredentialRow(db, ownerKey, provider);
  if (!stored) {
    throw new IntegrationCredentialError(
      500,
      "credential_save_failed",
      "The API key could not be saved.",
    );
  }
  return {
    provider,
    createdAt: stored.created_at,
    updatedAt: stored.updated_at,
  };
}

export async function deleteIntegrationCredential(
  db: IntegrationD1Database,
  ownerKey: string,
  provider: IntegrationProvider,
): Promise<void> {
  ownerKey = canonicalOwnerKey(ownerKey);
  await db.prepare(
    "DELETE FROM integration_credentials WHERE owner_key=? AND provider=?",
  ).bind(ownerKey, provider).run();
}

export async function getIntegrationCredential(
  db: IntegrationD1Database,
  ownerKey: string,
  provider: IntegrationProvider,
): Promise<string | null> {
  ownerKey = canonicalOwnerKey(ownerKey);
  const row = await findCredentialRow(db, ownerKey, provider);
  if (!row) return null;
  if (row.key_version !== CREDENTIAL_KEY_VERSION) {
    throw new IntegrationCredentialError(
      503,
      "credential_key_version_unavailable",
      "The saved API key cannot be opened with the active vault version.",
    );
  }
  return decryptCredential(ownerKey, provider, row.encrypted_secret, row.iv);
}

export async function platformIntegrationSecret(
  name: "SAM_API_KEY" | "APOLLO_API_KEY",
): Promise<string | null> {
  const processValue = process.env[name]?.trim();
  if (processValue) return processValue;
  try {
    const { env } = await import("cloudflare:workers");
    const value = (env as unknown as Record<string, unknown>)[name];
    return typeof value === "string" ? value.trim() || null : null;
  } catch {
    return null;
  }
}

/** Resolve a write-only account key first, then a platform key, without logging either. */
export async function resolveIntegrationCredential(
  ownerKey: string | null | undefined,
  provider: IntegrationProvider,
): Promise<ResolvedIntegrationCredential | null> {
  if (ownerKey) {
    try {
      const db = await getIntegrationDatabase();
      const apiKey = await getIntegrationCredential(db, ownerKey, provider);
      if (apiKey) return { apiKey, scope: "personal" };
    } catch {
      // A locked/unavailable personal vault must not prevent a configured
      // platform connector from serving the same public source data.
    }
  }
  const environmentName = provider === "sam" ? "SAM_API_KEY" : "APOLLO_API_KEY";
  const apiKey = await platformIntegrationSecret(environmentName);
  return apiKey ? { apiKey, scope: "platform" } : null;
}

async function findCredentialRow(
  db: IntegrationD1Database,
  ownerKey: string,
  provider: IntegrationProvider,
): Promise<IntegrationCredentialRow | null> {
  return db.prepare(
    `SELECT provider, encrypted_secret, iv, key_version, created_at, updated_at
       FROM integration_credentials
      WHERE owner_key=? AND provider=?
      LIMIT 1`,
  ).bind(ownerKey, provider).first<IntegrationCredentialRow>();
}

async function encryptCredential(
  ownerKey: string,
  provider: IntegrationProvider,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importCredentialsMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(CREDENTIAL_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: CREDENTIAL_ALGORITHM,
      iv,
      additionalData: credentialAdditionalData(ownerKey, provider),
    },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    iv: encodeBase64(iv),
  };
}

async function decryptCredential(
  ownerKey: string,
  provider: IntegrationProvider,
  ciphertext: string,
  encodedIv: string,
): Promise<string> {
  try {
    const key = await importCredentialsMasterKey();
    const iv = decodeBase64(encodedIv);
    if (iv.byteLength !== CREDENTIAL_IV_BYTES) throw new Error("invalid IV");
    const decrypted = await crypto.subtle.decrypt(
      {
        name: CREDENTIAL_ALGORITHM,
        iv,
        additionalData: credentialAdditionalData(ownerKey, provider),
      },
      key,
      decodeBase64(ciphertext),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
  } catch (error) {
    if (error instanceof IntegrationCredentialError) throw error;
    throw new IntegrationCredentialError(
      503,
      "credential_decryption_failed",
      "The saved API key could not be opened safely.",
    );
  }
}

function credentialAdditionalData(
  ownerKey: string,
  provider: IntegrationProvider,
): Uint8Array {
  return new TextEncoder().encode(
    `bidatlas-credential\u0000${CREDENTIAL_KEY_VERSION}\u0000${ownerKey}\u0000${provider}`,
  );
}

async function importCredentialsMasterKey(): Promise<CryptoKey> {
  const configured = await configuredMasterKey();
  if (!configured) {
    throw new IntegrationCredentialError(
      503,
      "credential_vault_not_configured",
      "Private API-key storage is not configured for this environment.",
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(configured);
  } catch {
    throw new IntegrationCredentialError(
      503,
      "credential_vault_not_configured",
      "Private API-key storage is not configured for this environment.",
    );
  }
  if (bytes.byteLength !== 32) {
    throw new IntegrationCredentialError(
      503,
      "credential_vault_not_configured",
      "Private API-key storage is not configured for this environment.",
    );
  }
  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: CREDENTIAL_ALGORITHM },
    false,
    ["encrypt", "decrypt"],
  );
}

async function configuredMasterKey(): Promise<string | undefined> {
  const processValue = process.env.BIDATLAS_CREDENTIALS_MASTER_KEY?.trim();
  if (processValue) return processValue;
  try {
    const { env } = await import("cloudflare:workers");
    const value = (env as unknown as Record<string, unknown>)[
      "BIDATLAS_CREDENTIALS_MASTER_KEY"
    ];
    return typeof value === "string" ? value.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("invalid base64");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
