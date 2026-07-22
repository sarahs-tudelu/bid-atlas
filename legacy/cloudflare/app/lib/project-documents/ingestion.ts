import {
  DocumentInputError,
  MAX_DOCUMENT_BYTES,
  MAX_TEXT_INDEX_BYTES,
  classifyIpAddress,
  classifyDocumentPayload,
  normalizeFileName,
  normalizePublicHttpsUrl,
  normalizedMimeType,
  objectKeyForHash,
  processingStatusFor,
  sha256Hex,
  type DocumentMetadataInput,
} from "./contracts.ts";
import {
  assertDocumentProjectLinkage,
  persistDocumentExtraction,
  persistProjectDocument,
  type PersistedDocument,
  type StoredDocumentPayload,
} from "./storage.ts";

const MAX_REDIRECTS = 4;
const MAX_DIRECT_TEXT_CHUNKS = 200;
const TEXT_CHUNK_CHARACTERS = 8_000;
const REMOTE_FETCH_TIMEOUT_MS = 20_000;
const DNS_OVER_HTTPS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_RECORD_TYPES = ["A", "AAAA"] as const;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type HostResolver = (hostname: string, signal: AbortSignal) => Promise<string[]>;

type RemoteReadResult = {
  finalUrl: string;
  fileName: string;
  mimeType: string;
  reportedBytes?: number;
  payload?: StoredDocumentPayload;
  processingError?: string;
};

type DnsJsonAnswer = {
  type?: unknown;
  data?: unknown;
};

type DnsJsonResponse = {
  Status?: unknown;
  Answer?: unknown;
};

async function resolveHostWithDnsOverHttps(
  hostname: string,
  signal: AbortSignal,
): Promise<string[]> {
  const answers = await Promise.all(DNS_RECORD_TYPES.map(async (recordType) => {
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
      throw new DocumentInputError(
        502,
        "source_dns_validation_failed",
        "The source hostname could not be validated through the public DNS resolver.",
      );
    }
    if (!response.ok) {
      throw new DocumentInputError(
        502,
        "source_dns_validation_failed",
        "The public DNS resolver did not accept the source hostname lookup.",
      );
    }
    let body: DnsJsonResponse;
    try {
      body = await response.json() as DnsJsonResponse;
    } catch {
      throw new DocumentInputError(
        502,
        "source_dns_validation_failed",
        "The public DNS resolver returned an unreadable response.",
      );
    }
    if (body.Status !== 0) {
      throw new DocumentInputError(
        502,
        "source_dns_validation_failed",
        "The source hostname did not resolve successfully through public DNS.",
      );
    }
    if (!Array.isArray(body.Answer)) return [];
    return (body.Answer as DnsJsonAnswer[]).flatMap((answer) =>
      (answer.type === 1 || answer.type === 28) && typeof answer.data === "string"
        ? [answer.data.trim()]
        : []
    );
  }));
  return [...new Set(answers.flat().filter(Boolean))];
}

async function assertPublicHostResolution(
  sourceUrl: string,
  resolveHost: HostResolver,
  signal: AbortSignal,
): Promise<void> {
  const hostname = new URL(sourceUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const literalClass = classifyIpAddress(hostname);
  if (literalClass === "blocked") {
    throw new DocumentInputError(
      400,
      "unsafe_source_resolution",
      "The source hostname resolves to a private or non-routable network address.",
    );
  }
  if (literalClass === "public") return;

  let addresses: string[];
  try {
    addresses = await resolveHost(hostname, signal);
  } catch (error) {
    if (error instanceof DocumentInputError || signal.aborted) throw error;
    throw new DocumentInputError(
      502,
      "source_dns_validation_failed",
      "The source hostname could not be validated through public DNS.",
    );
  }
  if (addresses.length === 0) {
    throw new DocumentInputError(
      502,
      "source_dns_validation_failed",
      "The source hostname did not resolve to a public IP address.",
    );
  }
  if (addresses.some((address) => classifyIpAddress(address) !== "public")) {
    throw new DocumentInputError(
      400,
      "unsafe_source_resolution",
      "The source hostname resolves to a private, invalid, or non-routable network address.",
    );
  }
}

function fileNameFromContentDisposition(value: string | null): string | undefined {
  if (!value) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try {
      return normalizeFileName(decodeURIComponent(encoded));
    } catch {
      return undefined;
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(value)?.[1];
  const plain = /filename=([^;]+)/i.exec(value)?.[1];
  return quoted || plain ? normalizeFileName(quoted ?? plain ?? "") : undefined;
}

function fileNameFromUrl(value: string): string | undefined {
  try {
    const pathname = new URL(value).pathname;
    const leaf = pathname.split("/").at(-1);
    return leaf ? normalizeFileName(decodeURIComponent(leaf)) : undefined;
  } catch {
    return undefined;
  }
}

async function responseBytesWithinLimit(
  response: Response,
): Promise<{ bytes?: Uint8Array; exceeded: boolean }> {
  if (!response.body) {
    throw new DocumentInputError(502, "empty_source_response", "The source returned no document body.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOCUMENT_BYTES) {
        await reader.cancel("document exceeds import limit");
        return { exceeded: true };
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
  return { bytes, exceeded: false };
}

async function fetchWithoutUnsafeRedirects(
  sourceUrl: string,
  fetchImpl: FetchLike,
  resolveHost: HostResolver,
  signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = normalizePublicHttpsUrl(sourceUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertPublicHostResolution(currentUrl, resolveHost, signal);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          Accept: "application/pdf,text/plain,text/csv,image/*,application/zip,application/octet-stream,*/*;q=0.1",
          "User-Agent": "BidAtlasDocumentImporter/1.0 (+public-project-document)",
        },
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new DocumentInputError(502, "source_fetch_failed", "The source document could not be fetched.");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) {
        throw new DocumentInputError(502, "invalid_source_redirect", "The source returned a redirect without a location.");
      }
      if (redirect === MAX_REDIRECTS) {
        throw new DocumentInputError(502, "too_many_source_redirects", "The source redirected too many times.");
      }
      currentUrl = normalizePublicHttpsUrl(new URL(location, currentUrl).toString());
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DocumentInputError(
        502,
        "source_fetch_failed",
        `The source returned HTTP ${response.status}; no bytes were stored.`,
      );
    }
    return { response, finalUrl: currentUrl };
  }
  throw new DocumentInputError(502, "too_many_source_redirects", "The source redirected too many times.");
}

export async function readRemoteProjectDocument(
  sourceUrl: string,
  displayName: string,
  fetchImpl: FetchLike = fetch,
  resolveHost: HostResolver = resolveHostWithDnsOverHttps,
  timeoutMs = REMOTE_FETCH_TIMEOUT_MS,
): Promise<RemoteReadResult> {
  const controller = new AbortController();
  const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.trunc(timeoutMs)) : REMOTE_FETCH_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), boundedTimeout);
  try {
    return await readRemoteProjectDocumentWithSignal(
      sourceUrl,
      displayName,
      fetchImpl,
      resolveHost,
      controller.signal,
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new DocumentInputError(504, "source_fetch_timeout", "The source document fetch exceeded its time limit.");
    }
    if (error instanceof DocumentInputError) throw error;
    throw new DocumentInputError(502, "source_fetch_failed", "The source document could not be fetched.");
  } finally {
    clearTimeout(timer);
  }
}

async function readRemoteProjectDocumentWithSignal(
  sourceUrl: string,
  displayName: string,
  fetchImpl: FetchLike,
  resolveHost: HostResolver,
  signal: AbortSignal,
): Promise<RemoteReadResult> {
  const { response, finalUrl } = await fetchWithoutUnsafeRedirects(
    sourceUrl,
    fetchImpl,
    resolveHost,
    signal,
  );
  const mimeType = normalizedMimeType(response.headers.get("content-type"));
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  const reportedBytes = Number.isFinite(contentLength) && contentLength > 0
    ? Math.trunc(contentLength)
    : undefined;
  const fileName = fileNameFromContentDisposition(response.headers.get("content-disposition")) ??
    fileNameFromUrl(finalUrl) ??
    normalizeFileName(displayName);
  const classification = classifyDocumentPayload(fileName, mimeType);
  if (!classification.supported) {
    await response.body?.cancel();
    return {
      finalUrl,
      fileName,
      mimeType,
      reportedBytes,
      processingError: "The source file type is not on the safe byte-import allowlist; searchable metadata was retained.",
    };
  }
  if (reportedBytes !== undefined && reportedBytes > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel();
    return {
      finalUrl,
      fileName,
      mimeType,
      reportedBytes,
      processingError: `The source file exceeds the ${MAX_DOCUMENT_BYTES}-byte import limit; searchable metadata was retained.`,
    };
  }
  const read = await responseBytesWithinLimit(response);
  if (read.exceeded || !read.bytes) {
    return {
      finalUrl,
      fileName,
      mimeType,
      reportedBytes,
      processingError: `The source stream exceeds the ${MAX_DOCUMENT_BYTES}-byte import limit; searchable metadata was retained.`,
    };
  }
  if (read.bytes.byteLength === 0) {
    throw new DocumentInputError(422, "empty_document", "The source document is empty.");
  }
  if (signal.aborted) throw new DOMException("The source fetch timed out.", "AbortError");
  const contentHash = await sha256Hex(read.bytes);
  if (signal.aborted) throw new DOMException("The source fetch timed out.", "AbortError");
  return {
    finalUrl,
    fileName,
    mimeType,
    reportedBytes: read.bytes.byteLength,
    payload: {
      bytes: read.bytes,
      contentHash,
      objectKey: objectKeyForHash(contentHash),
      fileName,
      classification,
    },
  };
}

function directTextChunks(bytes: Uint8Array): string[] {
  if (bytes.byteLength > MAX_TEXT_INDEX_BYTES) return [];
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes)
    .replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!text) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length && chunks.length < MAX_DIRECT_TEXT_CHUNKS; offset += TEXT_CHUNK_CHARACTERS) {
    const chunk = text.slice(offset, offset + TEXT_CHUNK_CHARACTERS).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

async function indexDirectText(
  persisted: PersistedDocument,
  payload: StoredDocumentPayload | undefined,
  actor: string,
): Promise<PersistedDocument> {
  if (!payload?.classification.directText) return persisted;
  const chunks = directTextChunks(payload.bytes);
  if (chunks.length === 0) return persisted;
  await persistDocumentExtraction({
    documentId: persisted.documentId,
    versionId: persisted.versionId,
    extractor: "bidatlas-direct-text",
    extractorVersion: "1",
    method: "native-text",
    chunks: chunks.map((text) => ({ text })),
    actor,
  });
  return { ...persisted, processingStatus: "text-indexed" };
}

export async function importProjectDocumentFromUrl(
  metadata: DocumentMetadataInput,
  actor: string,
  fetchImpl: FetchLike = fetch,
): Promise<PersistedDocument> {
  if (!metadata.sourceUrl) {
    throw new DocumentInputError(400, "missing_sourceUrl", "sourceUrl is required for a URL import.");
  }
  await assertDocumentProjectLinkage(metadata.projectId, metadata.sourceId);
  const remote = metadata.fetchBytes
    ? await readRemoteProjectDocument(metadata.sourceUrl, metadata.name, fetchImpl)
    : {
        finalUrl: metadata.sourceUrl,
        fileName: fileNameFromUrl(metadata.sourceUrl) ?? normalizeFileName(metadata.name),
        mimeType: "application/octet-stream",
        processingError: "Byte retrieval was intentionally deferred; searchable metadata was retained.",
      };
  const metadataWithResolution: DocumentMetadataInput = {
    ...metadata,
    provenance: {
      ...metadata.provenance,
      resolvedSourceUrl: remote.finalUrl,
    },
  };
  const persisted = await persistProjectDocument({
    metadata: metadataWithResolution,
    method: "url-import",
    actor,
    sourceUrl: metadata.sourceUrl,
    fileName: remote.fileName,
    payload: remote.payload,
    processingStatus: processingStatusFor(remote.payload?.classification),
    processingError: remote.processingError,
    reportedBytes: remote.reportedBytes,
    reportedMimeType: remote.mimeType,
  });
  return indexDirectText(persisted, remote.payload, actor);
}

export async function uploadProjectDocument(
  metadata: DocumentMetadataInput,
  file: File,
  actor: string,
): Promise<PersistedDocument> {
  await assertDocumentProjectLinkage(metadata.projectId, metadata.sourceId);
  if (file.size <= 0) {
    throw new DocumentInputError(422, "empty_document", "The uploaded document is empty.");
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new DocumentInputError(
      413,
      "document_too_large",
      `The uploaded document exceeds the ${MAX_DOCUMENT_BYTES}-byte limit. Import its metadata by URL instead.`,
    );
  }
  const fileName = normalizeFileName(file.name || metadata.name);
  const classification = classifyDocumentPayload(fileName, file.type);
  if (!classification.supported) {
    throw new DocumentInputError(
      415,
      "unsupported_document_type",
      "This file type is not on the project-document upload allowlist. Its source URL can still be imported as metadata.",
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentHash = await sha256Hex(bytes);
  const payload: StoredDocumentPayload = {
    bytes,
    contentHash,
    objectKey: objectKeyForHash(contentHash),
    fileName,
    classification,
  };
  const sourceUrl = metadata.sourceUrl ?? `urn:bidatlas:upload:${crypto.randomUUID()}`;
  const persisted = await persistProjectDocument({
    metadata,
    method: "upload",
    actor,
    sourceUrl,
    fileName,
    payload,
    processingStatus: processingStatusFor(classification),
  });
  return indexDirectText(persisted, payload, actor);
}
