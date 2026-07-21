import {
  enrichProfessionalPersonWithApollo,
  EnrichmentInputError,
  EnrichmentProviderError,
  getIntegrationCapabilityFlags,
  parseProfessionalPersonEnrichmentInput,
} from "../../lib/contact-enrichment";
import {
  credentialsMasterKeyConfigured,
  deleteIntegrationCredential,
  getIntegrationCredential,
  getIntegrationDatabase,
  IntegrationCredentialError,
  listIntegrationCredentials,
  parseIntegrationApiKey,
  parseIntegrationProvider,
  platformIntegrationSecret,
  upsertIntegrationCredential,
  type IntegrationD1Database,
  type IntegrationProvider,
} from "../../lib/integration-credentials";
import {
  getDocumentActor,
  type DocumentActor,
} from "../../lib/project-documents/http";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 16_384;

export async function GET(request?: Request) {
  const actor = request ? await getDocumentActor(request) : null;
  if (!actor || actor.kind !== "workspace-user") {
    // Preserve a non-sensitive capability response for public Bid Desk UI.
    // Personal credential metadata is never included without user identity.
    return Response.json(getIntegrationCapabilityFlags(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  return authenticatedCapabilityResponse(actor);
}

export async function PUT(request: Request) {
  try {
    const actor = await requireWorkspaceUser(request);
    const body = requireObject(await readJson(request));
    requireOnlyKeys(body, ["provider", "apiKey"]);
    const provider = parseIntegrationProvider(body.provider);
    const apiKey = parseIntegrationApiKey(body.apiKey);
    const db = await getIntegrationDatabase();
    await upsertIntegrationCredential(db, actor.id, provider, apiKey);
    return authenticatedCapabilityResponse(actor, db);
  } catch (error) {
    return integrationErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await requireWorkspaceUser(request);
    const body = requireObject(await readJson(request));
    requireOnlyKeys(body, ["provider"]);
    const provider = parseIntegrationProvider(body.provider);
    const db = await getIntegrationDatabase();
    await deleteIntegrationCredential(db, actor.id, provider);
    return authenticatedCapabilityResponse(actor, db);
  } catch (error) {
    return integrationErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getDocumentActor(request);
    if (!actor) {
      return errorResponse(
        401,
        "unauthorized",
        "An authenticated workspace user or valid internal token is required.",
      );
    }

    const body = await readJson(request);
    const input = parseProfessionalPersonEnrichmentInput(body);
    const apiKey = await resolveApolloApiKey(actor);
    if (!apiKey) {
      return errorResponse(
        503,
        "apollo_not_configured",
        "Apollo professional-person enrichment is not configured for this account.",
      );
    }

    const result = await enrichProfessionalPersonWithApollo(input, apiKey);
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof EnrichmentInputError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (error instanceof EnrichmentProviderError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return integrationErrorResponse(error, {
      status: 500,
      code: "enrichment_failed",
      message: "The professional-person enrichment request failed unexpectedly.",
    });
  }
}

async function authenticatedCapabilityResponse(
  actor: DocumentActor,
  providedDb?: IntegrationD1Database,
): Promise<Response> {
  const base = getIntegrationCapabilityFlags();
  const masterKeyConfigured = await credentialsMasterKeyConfigured();
  let credentials: Awaited<ReturnType<typeof listIntegrationCredentials>> = [];
  let vaultAvailable = masterKeyConfigured;

  try {
    const db = providedDb ?? await getIntegrationDatabase();
    credentials = await listIntegrationCredentials(db, actor.id);
  } catch {
    vaultAvailable = false;
  }

  const saved = new Map(credentials.map((credential) => [credential.provider, credential]));
  const personalApolloActive = vaultAvailable && saved.has("apollo");
  const personalSamActive = vaultAvailable && saved.has("sam");
  const platformSamActive = Boolean(await platformIntegrationSecret("SAM_API_KEY"));
  const samActive = personalSamActive || platformSamActive;

  return Response.json(
    {
      ...base,
      apolloConfigured: base.apolloConfigured || personalApolloActive,
      samConfigured: samActive,
      authenticated: true,
      credentialVault: {
        available: vaultAvailable,
        encryption: "AES-256-GCM",
        ownerScoped: true,
      },
      integrations: [
        integrationStatus(
          "sam",
          saved.get("sam"),
          samActive,
          personalSamActive
            ? "Active for authenticated live federal search, exact notice lookup, and public-attachment access. Scheduled national ingestion still uses the platform connector key."
            : platformSamActive
              ? "A platform SAM.gov connection is active for federal search and scheduled ingestion. Add your own key to keep interactive usage account-scoped."
            : "Add a free SAM.gov public API key to activate authenticated federal search, exact notice lookup, and public-attachment access for this account.",
        ),
        integrationStatus(
          "apollo",
          saved.get("apollo"),
          base.apolloConfigured || personalApolloActive,
          personalApolloActive
            ? "Active for authenticated, credit-confirmed professional contact enrichment."
            : base.apolloConfigured
              ? "A platform Apollo connection is active. Add your own key to keep usage account-scoped."
              : "Add an Apollo key to enable credit-confirmed professional contact enrichment.",
        ),
      ],
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

function integrationStatus(
  provider: IntegrationProvider,
  credential: { createdAt: string; updatedAt: string } | undefined,
  active: boolean,
  note: string,
) {
  return {
    provider,
    personalCredentialSaved: Boolean(credential),
    active,
    ...(credential
      ? { createdAt: credential.createdAt, updatedAt: credential.updatedAt }
      : {}),
    note,
  };
}

async function resolveApolloApiKey(actor: DocumentActor): Promise<string | null> {
  if (actor.kind === "workspace-user") {
    let db: IntegrationD1Database | null = null;
    try {
      db = await getIntegrationDatabase();
    } catch {
      db = null;
    }
    if (db) {
      const personalApiKey = await getIntegrationCredential(db, actor.id, "apollo");
      if (personalApiKey) return personalApiKey;
    }
  }

  const environmentApiKey = process.env.APOLLO_API_KEY?.trim();
  if (!environmentApiKey || process.env.APOLLO_ENRICHMENT_ENABLED !== "true") {
    return null;
  }
  return environmentApiKey;
}

async function requireWorkspaceUser(request: Request): Promise<DocumentActor> {
  const actor = await getDocumentActor(request);
  if (!actor) {
    throw new IntegrationCredentialError(
      401,
      "unauthorized",
      "An authenticated user is required to manage personal API keys.",
    );
  }
  if (actor.kind !== "workspace-user") {
    throw new IntegrationCredentialError(
      403,
      "personal_credentials_require_user",
      "Personal API keys require an authenticated user account.",
    );
  }
  return actor;
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new IntegrationCredentialError(
      415,
      "json_required",
      "Content-Type must be application/json.",
    );
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new IntegrationCredentialError(
      413,
      "request_too_large",
      "Request body is too large.",
    );
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new IntegrationCredentialError(
      413,
      "request_too_large",
      "Request body is too large.",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new IntegrationCredentialError(
      400,
      "invalid_json",
      "Request body must contain valid JSON.",
    );
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrationCredentialError(
      400,
      "invalid_integration_request",
      "Request body must be a JSON object.",
    );
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new IntegrationCredentialError(
      400,
      "invalid_integration_request",
      "The integration request contains unsupported fields.",
    );
  }
}

function integrationErrorResponse(
  error: unknown,
  fallback = {
    status: 500,
    code: "integration_operation_failed",
    message: "The integration operation failed unexpectedly.",
  },
): Response {
  if (error instanceof IntegrationCredentialError) {
    return errorResponse(error.status, error.code, error.message);
  }
  return errorResponse(fallback.status, fallback.code, fallback.message);
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
