const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const WORKSPACE_KEY = "bidatlas.workspace-id";

function workspaceId(): string {
  const existing = window.localStorage.getItem(WORKSPACE_KEY);
  if (existing) return existing;
  const identifier = `${crypto.randomUUID()}@device.bidatlas`;
  window.localStorage.setItem(WORKSPACE_KEY, identifier);
  return identifier;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "x-bidatlas-user": workspaceId(),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // The status is still useful when an upstream returns a non-JSON body.
    }
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}

export function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === "" || value === "all" || value === false) continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}
