import {
  classifyIpAddress,
  normalizePublicHttpsUrl,
} from "../project-documents/contracts";
import { SourceMonitorInputError } from "./contracts";

const DNS_OVER_HTTPS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_RECORD_TYPES = ["A", "AAAA"] as const;
const MAX_REDIRECTS = 3;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const SOURCE_FETCH_TIMEOUT_MS = 12_000;

export type SourceFetchResult = {
  finalUrl: string;
  contentType: string;
  body: string;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type HostResolver = (hostname: string, signal: AbortSignal) => Promise<string[]>;

type DnsAnswer = { type?: unknown; data?: unknown };
type DnsResponse = { Status?: unknown; Answer?: unknown };

async function publicDnsAddresses(hostname: string, signal: AbortSignal): Promise<string[]> {
  const groups = await Promise.all(DNS_RECORD_TYPES.map(async (recordType) => {
    const endpoint = new URL(DNS_OVER_HTTPS_ENDPOINT);
    endpoint.searchParams.set("name", hostname);
    endpoint.searchParams.set("type", recordType);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "GET",
        signal,
        headers: { Accept: "application/dns-json" },
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SourceMonitorInputError(
        502,
        "source_dns_validation_failed",
        "The source hostname could not be validated through public DNS.",
      );
    }
    if (!response.ok) {
      throw new SourceMonitorInputError(
        502,
        "source_dns_validation_failed",
        "The public DNS resolver did not accept the source hostname lookup.",
      );
    }
    let body: DnsResponse;
    try {
      body = await response.json() as DnsResponse;
    } catch {
      throw new SourceMonitorInputError(
        502,
        "source_dns_validation_failed",
        "The public DNS resolver returned an unreadable response.",
      );
    }
    if (body.Status !== 0) return [];
    return Array.isArray(body.Answer)
      ? (body.Answer as DnsAnswer[]).flatMap((answer) =>
          (answer.type === 1 || answer.type === 28) && typeof answer.data === "string"
            ? [answer.data.trim()]
            : [],
        )
      : [];
  }));
  return [...new Set(groups.flat().filter(Boolean))];
}

async function assertPublicResolution(
  sourceUrl: string,
  resolveHost: HostResolver,
  signal: AbortSignal,
): Promise<void> {
  const hostname = new URL(sourceUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const literal = classifyIpAddress(hostname);
  if (literal === "blocked") {
    throw new SourceMonitorInputError(
      400,
      "unsafe_source_resolution",
      "The source hostname resolves to a private or non-routable address.",
    );
  }
  if (literal === "public") return;
  const addresses = await resolveHost(hostname, signal);
  if (addresses.length === 0 || addresses.some((address) => classifyIpAddress(address) !== "public")) {
    throw new SourceMonitorInputError(
      400,
      "unsafe_source_resolution",
      "The source hostname did not resolve exclusively to public network addresses.",
    );
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) {
    await response.body?.cancel();
    throw new SourceMonitorInputError(
      413,
      "source_too_large",
      "The monitored source exceeds the 2 MiB scan limit.",
    );
  }
  if (!response.body) {
    throw new SourceMonitorInputError(502, "empty_source", "The monitored source returned no content.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let total = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        await reader.cancel("source monitor byte limit exceeded");
        throw new SourceMonitorInputError(
          413,
          "source_too_large",
          "The monitored source exceeds the 2 MiB scan limit.",
        );
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return body;
}

async function fetchWithSafeRedirects(
  sourceUrl: string,
  fetchImpl: FetchLike,
  resolveHost: HostResolver,
  signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl: string;
  try {
    currentUrl = normalizePublicHttpsUrl(sourceUrl, "feedUrl");
  } catch {
    throw new SourceMonitorInputError(
      400,
      "invalid_feedUrl",
      "The monitored source must use a public HTTPS URL.",
    );
  }
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertPublicResolution(currentUrl, resolveHost, signal);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          Accept: "application/feed+json,application/json,application/atom+xml,application/rss+xml,application/xml,text/xml,text/html,text/plain;q=0.8",
          "User-Agent": "BidAtlasSourceMonitor/1.0 (+public-construction-postings)",
        },
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SourceMonitorInputError(502, "source_fetch_failed", "The monitored source could not be fetched.");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirect === MAX_REDIRECTS) {
        throw new SourceMonitorInputError(502, "unsafe_source_redirect", "The monitored source returned an unusable redirect.");
      }
      try {
        currentUrl = normalizePublicHttpsUrl(new URL(location, currentUrl).toString(), "feedUrl");
      } catch {
        throw new SourceMonitorInputError(502, "unsafe_source_redirect", "The monitored source redirected outside public HTTPS.");
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceMonitorInputError(
        502,
        "source_fetch_failed",
        `The monitored source returned HTTP ${response.status}.`,
      );
    }
    return { response, finalUrl: currentUrl };
  }
  throw new SourceMonitorInputError(502, "source_fetch_failed", "The monitored source could not be fetched.");
}

export async function fetchPublicSourceText(
  sourceUrl: string,
  fetchImpl: FetchLike = fetch,
  resolveHost: HostResolver = publicDnsAddresses,
  timeoutMs = SOURCE_FETCH_TIMEOUT_MS,
): Promise<SourceFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.trunc(timeoutMs)));
  try {
    const { response, finalUrl } = await fetchWithSafeRedirects(
      sourceUrl,
      fetchImpl,
      resolveHost,
      controller.signal,
    );
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "text/plain";
    if (!/(json|xml|rss|atom|html|text)/i.test(contentType)) {
      await response.body?.cancel();
      throw new SourceMonitorInputError(
        415,
        "unsupported_source_type",
        "The monitored source must return HTML, JSON, RSS, Atom, XML, or plain text.",
      );
    }
    return { finalUrl, contentType, body: await readBoundedText(response) };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new SourceMonitorInputError(504, "source_fetch_timeout", "The monitored source exceeded its scan timeout.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
