import { getChatGPTUser } from "../../chatgpt-auth";
import { DocumentInputError, MAX_DOCUMENT_JSON_BYTES } from "./contracts";
import { DocumentStorageError } from "./storage";

export interface DocumentActor {
  id: string;
  kind: "workspace-user" | "internal-service";
}

function constantTimeEqual(candidate: string, expected: string): boolean {
  if (candidate.length > 2_048 || expected.length > 2_048) return false;
  const encoder = new TextEncoder();
  const left = encoder.encode(candidate);
  const right = encoder.encode(expected);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function internalToken(request: Request): boolean {
  const expected = process.env.BIDATLAS_INTERNAL_TOKEN?.trim();
  if (!expected) return false;
  const match = /^Bearer\s+([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  return Boolean(match && constantTimeEqual(match[1], expected));
}

export async function getDocumentActor(request: Request): Promise<DocumentActor | null> {
  if (internalToken(request)) return { id: "internal-service", kind: "internal-service" };
  const user = await getChatGPTUser();
  if (!user?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) return null;
  return { id: user.email.toLowerCase(), kind: "workspace-user" };
}

export async function requireDocumentActor(request: Request): Promise<DocumentActor> {
  const actor = await getDocumentActor(request);
  if (!actor) {
    throw new DocumentInputError(
      401,
      "unauthorized",
      "An authenticated workspace user or valid internal token is required.",
    );
  }
  return actor;
}

export async function requireInternalDocumentActor(request: Request): Promise<DocumentActor> {
  const actor = await requireDocumentActor(request);
  if (actor.kind !== "internal-service") {
    throw new DocumentInputError(
      403,
      "internal_document_service_required",
      "Document extraction callbacks require the configured internal service token.",
    );
  }
  return actor;
}

export async function readDocumentJson(
  request: Request,
  maxBytes = MAX_DOCUMENT_JSON_BYTES,
): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new DocumentInputError(415, "json_required", "Content-Type must be application/json.");
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DocumentInputError(413, "request_too_large", "Request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new DocumentInputError(413, "request_too_large", "Request body is too large.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DocumentInputError(400, "invalid_json", "Request body must contain valid JSON.");
  }
}

export function documentErrorResponse(error: unknown): Response {
  if (error instanceof DocumentInputError || error instanceof DocumentStorageError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  return Response.json(
    { error: { code: "document_operation_failed", message: "The document operation failed unexpectedly." } },
    { status: 500, headers: { "Cache-Control": "private, no-store" } },
  );
}

export function privateJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return Response.json(body, { ...init, headers });
}
