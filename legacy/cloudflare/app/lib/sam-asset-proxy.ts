import {
  resolveSamOpportunityDescriptionUrl,
  resolveSamOpportunityResourceUrl,
} from "./connectors";
import { resolveIntegrationCredential } from "./integration-credentials";
import { getDocumentActor } from "./project-documents/http";

const MAX_SAM_ASSET_BYTES = 50 * 1024 * 1024;
const SAM_ASSET_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

type SamAsset =
  | { kind: "description" }
  | { kind: "resource"; index: number };

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

function credentialedSamUrl(value: string, apiKey: string): string | null {
  if (!apiKey.trim()) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      (hostname !== "sam.gov" && !hostname.endsWith(".sam.gov"))
    ) {
      return null;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase() === "api_key" || key.toLowerCase() === "apikey") {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.set("api_key", apiKey);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function readBoundedBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SAM_ASSET_BYTES) {
    await response.body?.cancel();
    throw new Error("asset-too-large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SAM_ASSET_BYTES) {
        await reader.cancel("SAM asset limit exceeded");
        throw new Error("asset-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchSamAsset(url: string, apiKey: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SAM_ASSET_TIMEOUT_MS);
  let current = credentialedSamUrl(url, apiKey);
  if (!current) {
    clearTimeout(timeout);
    return errorResponse(400, "unsafe_sam_asset", "The SAM.gov asset URL was not trusted.");
  }
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      let response: Response;
      try {
        response = await fetch(current, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            Accept: "application/pdf,application/zip,application/octet-stream,text/plain,text/html,*/*;q=0.5",
            "User-Agent": "BidAtlas/0.1 authenticated-public-SAM-asset-proxy",
          },
        });
      } catch {
        return errorResponse(
          controller.signal.aborted ? 504 : 502,
          controller.signal.aborted ? "sam_asset_timeout" : "sam_asset_fetch_failed",
          controller.signal.aborted
            ? "The SAM.gov asset request timed out."
            : "The SAM.gov asset could not be retrieved.",
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirect === MAX_REDIRECTS) {
          return errorResponse(502, "invalid_sam_redirect", "The SAM.gov asset redirect was invalid.");
        }
        current = credentialedSamUrl(new URL(location, current).toString(), apiKey);
        if (!current) {
          return errorResponse(400, "unsafe_sam_redirect", "The SAM.gov asset redirected outside its trusted hosts.");
        }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
          return errorResponse(
            403,
            "sam_asset_access_required",
            "This attachment requires additional SAM.gov access or a contracting-officer approval.",
          );
        }
        return errorResponse(
          response.status === 404 ? 404 : 502,
          response.status === 404 ? "sam_asset_not_found" : "sam_asset_http_error",
          response.status === 404
            ? "The SAM.gov asset was not found."
            : "SAM.gov returned an error while retrieving this asset.",
        );
      }
      try {
        const bytes = await readBoundedBytes(response);
        const body = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        return new Response(body, {
          status: 200,
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Type": response.headers.get("content-type") ?? "application/octet-stream",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch (error) {
        return error instanceof Error && error.message === "asset-too-large"
          ? errorResponse(413, "sam_asset_too_large", "The SAM.gov asset exceeds the 50 MB interactive limit.")
          : errorResponse(502, "sam_asset_read_failed", "The SAM.gov asset could not be read safely.");
      }
    }
    return errorResponse(502, "invalid_sam_redirect", "The SAM.gov asset redirected too many times.");
  } finally {
    clearTimeout(timeout);
  }
}

function visibleDescription(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>|<\/p\s*>|<\/li\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\t\r ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeAttachmentToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return token.slice(0, 80) || "notice";
}

export async function proxySamOpportunityAsset(
  request: Request,
  noticeId: string,
  asset: SamAsset,
): Promise<Response> {
  const actor = await getDocumentActor(request);
  if (!actor || actor.kind !== "workspace-user") {
    return errorResponse(401, "unauthorized", "Sign in to use an account-scoped SAM.gov key.");
  }
  const credential = await resolveIntegrationCredential(actor.id, "sam");
  if (!credential) {
    return errorResponse(
      503,
      "sam_not_configured",
      "Add a SAM.gov public API key in Integrations before opening this asset.",
    );
  }
  let sourceUrl: string | null;
  try {
    sourceUrl = asset.kind === "description"
      ? await resolveSamOpportunityDescriptionUrl(noticeId, credential.apiKey)
      : await resolveSamOpportunityResourceUrl(noticeId, asset.index, credential.apiKey);
  } catch {
    return errorResponse(
      502,
      "sam_notice_lookup_failed",
      "The SAM.gov notice could not be refreshed before opening this asset.",
    );
  }
  if (!sourceUrl) {
    return errorResponse(404, "sam_asset_not_found", "This notice did not publish that SAM.gov asset.");
  }
  const response = await fetchSamAsset(sourceUrl, credential.apiKey);
  if (!response.ok) return response;
  if (asset.kind === "resource") {
    const headers = new Headers(response.headers);
    headers.set(
      "Content-Disposition",
      `attachment; filename="sam-${safeAttachmentToken(noticeId)}-${asset.index + 1}"`,
    );
    return new Response(response.body, { status: response.status, headers });
  }
  const raw = await response.text();
  return new Response(visibleDescription(raw), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
