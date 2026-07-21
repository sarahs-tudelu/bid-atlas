import { getChatGPTUser } from "../../chatgpt-auth";
import {
  BidDraftInputError,
  BidDraftStorageUnavailableError,
  loadBidDraftFromConfiguredStorage,
  parseSaveBidDraftRequest,
  persistBidDraftToConfiguredStorage,
} from "../../../db/bid-draft-repository";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 128 * 1024;
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const user = await authenticatedUser();
  if (!user) return errorResponse(401, "unauthorized", "Sign in to load private bid drafts.");

  const projectId = new URL(request.url).searchParams.get("projectId")?.trim();
  if (!projectId) {
    return errorResponse(400, "project_required", "The projectId query parameter is required.");
  }

  try {
    const draft = await loadBidDraftFromConfiguredStorage(projectId, user.email);
    if (!draft) {
      return errorResponse(404, "draft_not_found", "No saved bid draft exists for this project.");
    }
    return Response.json(draft, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return repositoryError(error);
  }
}

export async function POST(request: Request) {
  const user = await authenticatedUser();
  if (!user) return errorResponse(401, "unauthorized", "Sign in to save private bid drafts.");

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return errorResponse(415, "json_required", "Content-Type must be application/json.");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return errorResponse(413, "request_too_large", "The bid draft is too large to save.");
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return errorResponse(400, "unreadable_json", "The request body could not be read.");
  }
  if (new TextEncoder().encode(bodyText).byteLength > MAX_REQUEST_BYTES) {
    return errorResponse(413, "request_too_large", "The bid draft is too large to save.");
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return errorResponse(400, "invalid_json", "The request body must contain valid JSON.");
  }

  try {
    const input = parseSaveBidDraftRequest(body);
    const saved = await persistBidDraftToConfiguredStorage(input, user.email);
    return Response.json(saved, { status: 201, headers: PRIVATE_HEADERS });
  } catch (error) {
    return repositoryError(error);
  }
}

async function authenticatedUser(): Promise<{ email: string } | null> {
  const user = await getChatGPTUser();
  const email = user?.email?.trim().toLowerCase() ?? "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { email };
}

function repositoryError(error: unknown): Response {
  if (error instanceof BidDraftInputError) {
    return errorResponse(error.status, error.code, error.message);
  }
  if (error instanceof BidDraftStorageUnavailableError) {
    return errorResponse(503, "storage_unavailable", error.message);
  }
  return errorResponse(500, "draft_storage_failed", "The private bid draft could not be stored.");
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: PRIVATE_HEADERS },
  );
}
