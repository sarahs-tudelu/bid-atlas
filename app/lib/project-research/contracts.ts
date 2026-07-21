export const MAX_RESEARCH_JSON_BYTES = 16 * 1024;
export const MAX_RESEARCH_RESPONSE_BYTES = 1_000_000;
export const MAX_RESEARCH_SOURCES = 4;
export const RESEARCH_TOTAL_TIMEOUT_MS = 20_000;
export const RESEARCH_SOURCE_TIMEOUT_MS = 7_000;
export const RESEARCH_FRESHNESS_MS = 6 * 60 * 60 * 1_000;
export const RESEARCH_MAX_ATTEMPTS = 3;

export class ProjectResearchError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectResearchError";
    this.status = status;
    this.code = code;
  }
}

export function parseResearchRequest(value: unknown): { force: boolean } {
  if (value === undefined || value === null) return { force: false };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectResearchError(400, "invalid_research_request", "Request body must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "force")) {
    throw new ProjectResearchError(400, "invalid_research_request", "Only the force field is accepted.");
  }
  if (body.force !== undefined && typeof body.force !== "boolean") {
    throw new ProjectResearchError(400, "invalid_research_request", "force must be a boolean.");
  }
  return { force: body.force === true };
}

export function normalizeProjectId(value: string): string {
  const projectId = value.trim();
  if (!projectId || projectId.length > 180 || /[\u0000-\u001f\u007f]/.test(projectId)) {
    throw new ProjectResearchError(400, "invalid_project_id", "The project ID is invalid.");
  }
  return projectId;
}

export function cleanResearchText(value: string, maxLength = 600): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function normalizeOfficialHttpsUrl(value: string): string {
  if (!value || value.length > 2_048) {
    throw new ProjectResearchError(400, "unsafe_official_url", "The official source URL is invalid.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProjectResearchError(400, "unsafe_official_url", "The official source URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new ProjectResearchError(400, "unsafe_official_url", "Official research sources must use credential-free HTTPS on the standard port.");
  }
  url.hash = "";
  return url.toString();
}

export function normalizeAllowedHost(value: string): string | undefined {
  try {
    return new URL(normalizeOfficialHttpsUrl(value)).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    const host = value.trim().toLowerCase().replace(/\.$/, "");
    return /^[a-z0-9.-]{1,253}$/.test(host) && !host.includes("..") ? host : undefined;
  }
}

export async function readOptionalResearchJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESEARCH_JSON_BYTES) {
    throw new ProjectResearchError(413, "research_request_too_large", "The research request is too large.");
  }
  const text = await request.text();
  if (!text.trim()) return undefined;
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ProjectResearchError(415, "json_required", "Content-Type must be application/json.");
  }
  if (new TextEncoder().encode(text).byteLength > MAX_RESEARCH_JSON_BYTES) {
    throw new ProjectResearchError(413, "research_request_too_large", "The research request is too large.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProjectResearchError(400, "invalid_json", "Request body must contain valid JSON.");
  }
}

export function researchErrorResponse(error: unknown): Response {
  if (error instanceof ProjectResearchError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  return Response.json(
    { error: { code: "project_research_failed", message: "Project research failed unexpectedly." } },
    { status: 500, headers: { "Cache-Control": "private, no-store" } },
  );
}
