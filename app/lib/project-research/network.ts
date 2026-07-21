import { classifyIpAddress } from "../project-documents/contracts.ts";
import {
  MAX_RESEARCH_RESPONSE_BYTES,
  RESEARCH_SOURCE_TIMEOUT_MS,
  ProjectResearchError,
  normalizeAllowedHost,
  normalizeOfficialHttpsUrl,
} from "./contracts.ts";

const DNS_OVER_HTTPS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const MAX_REDIRECTS = 3;
const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "application/json",
  "application/ld+json",
  "application/xml",
  "text/xml",
];

export type ResearchFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ResearchHostResolver = (hostname: string, signal: AbortSignal) => Promise<string[]>;

export type SafeOfficialResponse = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytesRead: number;
};

async function resolveWithPublicDns(hostname: string, signal: AbortSignal): Promise<string[]> {
  const results = await Promise.all(["A", "AAAA"].map(async (type) => {
    const endpoint = new URL(DNS_OVER_HTTPS_ENDPOINT);
    endpoint.searchParams.set("name", hostname);
    endpoint.searchParams.set("type", type);
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/dns-json" },
      signal,
    });
    if (!response.ok) throw new ProjectResearchError(502, "official_dns_failed", "The official source hostname could not be validated.");
    const payload = await response.json() as { Status?: unknown; Answer?: Array<{ type?: unknown; data?: unknown }> };
    if (payload.Status !== 0) throw new ProjectResearchError(502, "official_dns_failed", "The official source hostname did not resolve through public DNS.");
    return (payload.Answer ?? []).flatMap((answer) =>
      (answer.type === 1 || answer.type === 28) && typeof answer.data === "string"
        ? [answer.data.trim()]
        : [],
    );
  }));
  return [...new Set(results.flat().filter(Boolean))];
}

async function assertPublicResolution(
  url: string,
  resolver: ResearchHostResolver,
  signal: AbortSignal,
): Promise<void> {
  const hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const literal = classifyIpAddress(hostname);
  if (literal === "blocked") {
    throw new ProjectResearchError(400, "unsafe_official_resolution", "The official source resolves to a private or non-routable address.");
  }
  if (literal === "public") return;
  let addresses: string[];
  try {
    addresses = await resolver(hostname, signal);
  } catch (error) {
    if (error instanceof ProjectResearchError || signal.aborted) throw error;
    throw new ProjectResearchError(502, "official_dns_failed", "The official source hostname could not be validated.");
  }
  if (!addresses.length || addresses.some((address) => classifyIpAddress(address) !== "public")) {
    throw new ProjectResearchError(400, "unsafe_official_resolution", "The official source did not resolve exclusively to public addresses.");
  }
}

async function readBoundedText(response: Response): Promise<{ body: string; bytesRead: number }> {
  if (!response.body) return { body: "", bytesRead: 0 };
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESEARCH_RESPONSE_BYTES) {
    await response.body.cancel();
    throw new ProjectResearchError(413, "official_response_too_large", "The official source response exceeds the research limit.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESEARCH_RESPONSE_BYTES) {
        await reader.cancel("research response limit exceeded");
        throw new ProjectResearchError(413, "official_response_too_large", "The official source response exceeds the research limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder("utf-8", { fatal: false }).decode(bytes), bytesRead };
}

export async function fetchOfficialText(
  sourceUrl: string,
  allowedHosts: readonly string[],
  options: {
    fetchImpl?: ResearchFetch;
    resolveHost?: ResearchHostResolver;
    parentSignal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<SafeOfficialResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolver = options.resolveHost ?? resolveWithPublicDns;
  const hostAllowlist = new Set(allowedHosts.flatMap((host) => {
    const normalized = normalizeAllowedHost(host);
    return normalized ? [normalized] : [];
  }));
  if (!hostAllowlist.size) throw new ProjectResearchError(400, "missing_official_allowlist", "No verified official source host is available.");

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), options.timeoutMs ?? RESEARCH_SOURCE_TIMEOUT_MS);
  const signal = options.parentSignal
    ? AbortSignal.any([options.parentSignal, timeoutController.signal])
    : timeoutController.signal;
  const requestedUrl = normalizeOfficialHttpsUrl(sourceUrl);
  let currentUrl = requestedUrl;
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const hostname = new URL(currentUrl).hostname.toLowerCase().replace(/\.$/, "");
      if (!hostAllowlist.has(hostname)) {
        throw new ProjectResearchError(400, "unapproved_official_host", "The source or redirect host is not on this project's official allowlist.");
      }
      await assertPublicResolution(currentUrl, resolver, signal);
      let response: Response;
      try {
        response = await fetchImpl(currentUrl, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          signal,
          headers: {
            Accept: "application/json,text/html,text/plain,application/xml;q=0.8",
            "User-Agent": "BidAtlasProjectResearch/1.0 (+official-public-project-research)",
          },
        });
      } catch {
        if (signal.aborted) throw new ProjectResearchError(504, "official_fetch_timeout", "The official source exceeded its bounded fetch time.");
        throw new ProjectResearchError(502, "official_fetch_failed", "The official source could not be fetched.");
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new ProjectResearchError(502, "invalid_official_redirect", "The official source returned a redirect without a location.");
        if (redirect === MAX_REDIRECTS) throw new ProjectResearchError(502, "too_many_official_redirects", "The official source redirected too many times.");
        currentUrl = normalizeOfficialHttpsUrl(new URL(location, currentUrl).toString());
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProjectResearchError(502, "official_http_error", `The official source returned HTTP ${response.status}.`);
      }
      const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
        await response.body?.cancel();
        throw new ProjectResearchError(415, "unsupported_official_content", "The official research source is not bounded text or JSON; it was retained as a document link instead.");
      }
      const { body, bytesRead } = await readBoundedText(response);
      return { requestedUrl, finalUrl: currentUrl, status: response.status, contentType, body, bytesRead };
    }
    throw new ProjectResearchError(502, "too_many_official_redirects", "The official source redirected too many times.");
  } finally {
    clearTimeout(timeout);
  }
}
