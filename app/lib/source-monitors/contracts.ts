import { normalizePublicHttpsUrl } from "../project-documents/contracts";

export const SOURCE_MONITOR_TYPES = [
  "public-procurement",
  "gc-planroom",
  "owner-planroom",
  "builders-exchange",
] as const;

export const SOURCE_MONITOR_FORMATS = [
  "auto",
  "rss",
  "atom",
  "json-feed",
  "html",
] as const;

export const SOURCE_MONITOR_STATUSES = ["active", "paused"] as const;
export const SOURCE_CANDIDATE_STATUSES = [
  "needs-review",
  "verified",
  "rejected",
  "expired",
] as const;

export type SourceMonitorType = (typeof SOURCE_MONITOR_TYPES)[number];
export type SourceMonitorFormat = (typeof SOURCE_MONITOR_FORMATS)[number];
export type SourceMonitorStatus = (typeof SOURCE_MONITOR_STATUSES)[number];
export type SourceCandidateStatus = (typeof SOURCE_CANDIDATE_STATUSES)[number];

export type SourceMonitorRecord = {
  id: string;
  ownerKey: string;
  name: string;
  publisher: string;
  jurisdiction: string;
  city?: string;
  state?: string;
  sourceType: SourceMonitorType;
  feedUrl: string;
  feedFormat: SourceMonitorFormat;
  cadenceMinutes: number;
  status: SourceMonitorStatus;
  nextDueAt?: string;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  candidateCount: number;
  verifiedCount: number;
  createdAt: string;
  updatedAt: string;
};

export type PostedProjectCandidate = {
  id: string;
  monitorId: string;
  projectId?: string;
  sourceRecordId: string;
  title: string;
  summary: string;
  sourceUrl: string;
  publisher: string;
  city?: string;
  state?: string;
  postedAt?: string;
  bidDate?: string;
  documentUrl?: string;
  documentName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  submissionUrl?: string;
  tradeTags: string[];
  opportunityType: "public-bid" | "company-posted";
  status: SourceCandidateStatus;
  readinessReasons: CandidateReadinessReason[];
  evidence: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
};

export type CandidateReadinessReason =
  | "missing-title"
  | "missing-summary"
  | "missing-location"
  | "missing-deadline"
  | "deadline-passed"
  | "missing-source-url"
  | "source-host-mismatch"
  | "missing-bid-language"
  | "missing-bid-documents";

export type DiscoveredPosting = Omit<
  PostedProjectCandidate,
  | "id"
  | "monitorId"
  | "projectId"
  | "status"
  | "readinessReasons"
  | "firstSeenAt"
  | "lastSeenAt"
  | "reviewedAt"
  | "reviewedBy"
>;

export class SourceMonitorInputError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceMonitorInputError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function objectValue(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SourceMonitorInputError(400, "invalid_body", "The request body must be a JSON object.");
  }
  return input as Record<string, unknown>;
}

function cleanText(value: unknown, field: string, maximum: number, required = false): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new SourceMonitorInputError(400, `missing_${field}`, `${field} is required.`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new SourceMonitorInputError(400, `invalid_${field}`, `${field} must be text.`);
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned && required) {
    throw new SourceMonitorInputError(400, `missing_${field}`, `${field} is required.`);
  }
  if (cleaned.length > maximum) {
    throw new SourceMonitorInputError(400, `invalid_${field}`, `${field} is too long.`);
  }
  return cleaned || undefined;
}

function enumValue<T extends string>(
  value: unknown,
  field: string,
  choices: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new SourceMonitorInputError(
      400,
      `invalid_${field}`,
      `${field} must be one of: ${choices.join(", ")}.`,
    );
  }
  return value as T;
}

function publicUrl(value: unknown, field: string, required = false): string | undefined {
  const text = cleanText(value, field, 2_048, required);
  if (!text) return undefined;
  try {
    return normalizePublicHttpsUrl(text, field);
  } catch {
    throw new SourceMonitorInputError(
      400,
      `invalid_${field}`,
      `${field} must be a public HTTPS URL without embedded credentials.`,
    );
  }
}

function stateCode(value: unknown): string | undefined {
  const state = cleanText(value, "state", 2)?.toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(state)) {
    throw new SourceMonitorInputError(400, "invalid_state", "state must be a two-letter code.");
  }
  return state;
}

function cadence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 1_440);
  if (!Number.isFinite(parsed) || parsed < 15 || parsed > 10_080) {
    throw new SourceMonitorInputError(
      400,
      "invalid_cadenceMinutes",
      "cadenceMinutes must be between 15 minutes and 7 days.",
    );
  }
  return Math.trunc(parsed);
}

export type CreateSourceMonitorInput = {
  name: string;
  publisher: string;
  jurisdiction: string;
  city?: string;
  state?: string;
  sourceType: SourceMonitorType;
  feedUrl: string;
  feedFormat: SourceMonitorFormat;
  cadenceMinutes: number;
};

export function parseCreateSourceMonitor(input: unknown): CreateSourceMonitorInput {
  const record = objectValue(input);
  const city = cleanText(record.city, "city", 120);
  const state = stateCode(record.state);
  const jurisdiction = cleanText(record.jurisdiction, "jurisdiction", 200, true)!;
  if (!city && !state) {
    throw new SourceMonitorInputError(
      400,
      "missing_market",
      "Add a city or state so discovered postings have a usable market location.",
    );
  }
  return {
    name: cleanText(record.name, "name", 160, true)!,
    publisher: cleanText(record.publisher, "publisher", 200, true)!,
    jurisdiction,
    ...(city ? { city } : {}),
    ...(state ? { state } : {}),
    sourceType: enumValue(record.sourceType, "sourceType", SOURCE_MONITOR_TYPES, "public-procurement"),
    feedUrl: publicUrl(record.feedUrl, "feedUrl", true)!,
    feedFormat: enumValue(record.feedFormat, "feedFormat", SOURCE_MONITOR_FORMATS, "auto"),
    cadenceMinutes: cadence(record.cadenceMinutes),
  };
}

export type ReviewCandidateInput = {
  action: "verify" | "reject";
  title?: string;
  summary?: string;
  city?: string;
  state?: string;
  bidDate?: string;
  documentUrl?: string;
  documentName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  submissionUrl?: string;
  tradeTags?: string[];
};

function isoDate(value: unknown): string | undefined {
  const text = cleanText(value, "bidDate", 80);
  if (!text) return undefined;
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(text)?.[1];
  if (dateOnly) return dateOnly;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw new SourceMonitorInputError(400, "invalid_bidDate", "bidDate must be an ISO date or timestamp.");
  }
  return new Date(timestamp).toISOString();
}

function email(value: unknown): string | undefined {
  const text = cleanText(value, "contactEmail", 254)?.toLowerCase();
  if (text && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text)) {
    throw new SourceMonitorInputError(400, "invalid_contactEmail", "contactEmail is invalid.");
  }
  return text;
}

function tags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new SourceMonitorInputError(400, "invalid_tradeTags", "tradeTags must be a list.");
  }
  return [...new Set(value.map((item) => cleanText(item, "tradeTags", 80)).filter(Boolean) as string[])].slice(0, 30);
}

export function parseReviewCandidate(input: unknown): ReviewCandidateInput {
  const record = objectValue(input);
  const action = enumValue(record.action, "action", ["verify", "reject"] as const, "verify");
  return {
    action,
    title: cleanText(record.title, "title", 300),
    summary: cleanText(record.summary, "summary", 5_000),
    city: cleanText(record.city, "city", 120),
    state: stateCode(record.state),
    bidDate: isoDate(record.bidDate),
    documentUrl: publicUrl(record.documentUrl, "documentUrl"),
    documentName: cleanText(record.documentName, "documentName", 300),
    contactName: cleanText(record.contactName, "contactName", 200),
    contactEmail: email(record.contactEmail),
    contactPhone: cleanText(record.contactPhone, "contactPhone", 80),
    submissionUrl: publicUrl(record.submissionUrl, "submissionUrl"),
    tradeTags: tags(record.tradeTags),
  };
}

export function parseMonitorStatus(input: unknown): { id: string; status: SourceMonitorStatus } {
  const record = objectValue(input);
  return {
    id: cleanText(record.id, "id", 100, true)!,
    status: enumValue(record.status, "status", SOURCE_MONITOR_STATUSES, "active"),
  };
}

export function assessPostingReadiness(
  candidate: Pick<
    DiscoveredPosting,
    "title" | "summary" | "city" | "state" | "bidDate" | "sourceUrl" | "documentUrl" | "evidence"
  >,
  now = new Date(),
): CandidateReadinessReason[] {
  const reasons: CandidateReadinessReason[] = [];
  if (!candidate.title.trim()) reasons.push("missing-title");
  if (!candidate.summary.trim()) reasons.push("missing-summary");
  if (!candidate.city?.trim() && !candidate.state?.trim()) reasons.push("missing-location");
  if (!candidate.sourceUrl.trim()) reasons.push("missing-source-url");
  if (candidate.evidence.sourceHostMatched === false && candidate.evidence.reviewerConfirmed !== true) {
    reasons.push("source-host-mismatch");
  }
  const bidLanguage = String(candidate.evidence.bidLanguage ?? "");
  if (!/\b(bid|bids|bidding|proposal|proposals|quote|quotes|tender|invitation to bid|itb|rfp|rfq)\b/i.test(bidLanguage)) {
    reasons.push("missing-bid-language");
  }
  if (!candidate.documentUrl?.trim()) reasons.push("missing-bid-documents");
  if (!candidate.bidDate) {
    reasons.push("missing-deadline");
  } else {
    const deadline = Date.parse(candidate.bidDate);
    if (!Number.isFinite(deadline)) {
      reasons.push("missing-deadline");
    } else {
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(candidate.bidDate);
      const today = now.toISOString().slice(0, 10);
      if ((dateOnly && candidate.bidDate < today) || (!dateOnly && deadline < now.getTime())) {
        reasons.push("deadline-passed");
      }
    }
  }
  return reasons;
}

export function sourceMonitorErrorResponse(error: unknown): Response {
  if (error instanceof SourceMonitorInputError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.statusCode, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  if (error && typeof error === "object") {
    const record = error as { status?: unknown; code?: unknown; message?: unknown };
    if (
      typeof record.status === "number" &&
      typeof record.code === "string" &&
      typeof record.message === "string"
    ) {
      return Response.json(
        { error: { code: record.code, message: record.message } },
        { status: record.status, headers: { "Cache-Control": "private, no-store" } },
      );
    }
  }
  const message = error instanceof Error ? error.message : "The source-monitor operation failed.";
  return Response.json(
    { error: { code: "source_monitor_failed", message } },
    { status: 500, headers: { "Cache-Control": "private, no-store" } },
  );
}
