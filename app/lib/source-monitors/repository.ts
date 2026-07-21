import { sha256Hex } from "../project-documents/contracts";
import {
  SourceMonitorInputError,
  assessPostingReadiness,
  type CandidateReadinessReason,
  type CreateSourceMonitorInput,
  type DiscoveredPosting,
  type PostedProjectCandidate,
  type ReviewCandidateInput,
  type SourceMonitorRecord,
  type SourceMonitorStatus,
} from "./contracts";

export interface MonitorPreparedStatement {
  bind(...values: unknown[]): MonitorPreparedStatement;
  run(): Promise<{ meta?: { changes?: number } } | unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] } | T[]>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface MonitorD1Database {
  prepare(sql: string): MonitorPreparedStatement;
  batch(statements: MonitorPreparedStatement[]): Promise<unknown[]>;
}

type MonitorRow = {
  id: string;
  source_id: string;
  owner_key: string;
  name: string;
  publisher: string;
  jurisdiction: string;
  city: string | null;
  state: string | null;
  source_type: string;
  feed_url: string;
  feed_format: string;
  cadence_minutes: number;
  status: string;
  next_due_at: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
  candidate_count?: number | string;
  verified_count?: number | string;
};

type CandidateRow = {
  id: string;
  monitor_id: string;
  project_id: string | null;
  source_record_id: string;
  title: string;
  summary: string;
  source_url: string;
  publisher: string;
  city: string | null;
  state: string | null;
  posted_at: string | null;
  bid_date: string | null;
  document_url: string | null;
  document_name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  submission_url: string | null;
  trade_tags: string;
  opportunity_type: "public-bid" | "company-posted";
  status: "needs-review" | "verified" | "rejected" | "expired";
  readiness_reasons: string;
  evidence: string;
  first_seen_at: string;
  last_seen_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
};

function resultRows<T>(result: { results?: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : result.results ?? [];
}

function parsedJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function monitorRecord(row: MonitorRow): SourceMonitorRecord {
  return {
    id: row.id,
    ownerKey: row.owner_key,
    name: row.name,
    publisher: row.publisher,
    jurisdiction: row.jurisdiction,
    ...(row.city ? { city: row.city } : {}),
    ...(row.state ? { state: row.state } : {}),
    sourceType: row.source_type as SourceMonitorRecord["sourceType"],
    feedUrl: row.feed_url,
    feedFormat: row.feed_format as SourceMonitorRecord["feedFormat"],
    cadenceMinutes: Number(row.cadence_minutes),
    status: row.status as SourceMonitorStatus,
    ...(row.next_due_at ? { nextDueAt: row.next_due_at } : {}),
    ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}),
    ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    consecutiveFailures: Number(row.consecutive_failures),
    candidateCount: Number(row.candidate_count ?? 0),
    verifiedCount: Number(row.verified_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function candidateRecord(row: CandidateRow): PostedProjectCandidate {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    sourceRecordId: row.source_record_id,
    title: row.title,
    summary: row.summary,
    sourceUrl: row.source_url,
    publisher: row.publisher,
    ...(row.city ? { city: row.city } : {}),
    ...(row.state ? { state: row.state } : {}),
    ...(row.posted_at ? { postedAt: row.posted_at } : {}),
    ...(row.bid_date ? { bidDate: row.bid_date } : {}),
    ...(row.document_url ? { documentUrl: row.document_url } : {}),
    ...(row.document_name ? { documentName: row.document_name } : {}),
    ...(row.contact_name ? { contactName: row.contact_name } : {}),
    ...(row.contact_email ? { contactEmail: row.contact_email } : {}),
    ...(row.contact_phone ? { contactPhone: row.contact_phone } : {}),
    ...(row.submission_url ? { submissionUrl: row.submission_url } : {}),
    tradeTags: parsedJson<string[]>(row.trade_tags, []),
    opportunityType: row.opportunity_type,
    status: row.status,
    readinessReasons: parsedJson<CandidateReadinessReason[]>(row.readiness_reasons, []),
    evidence: parsedJson<Record<string, unknown>>(row.evidence, {}),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
  };
}

async function stableId(prefix: string, value: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(value)).slice(0, 32)}`;
}

function canonicalOwnerKey(ownerKey: string): string {
  return ownerKey.trim().toLowerCase();
}

function normalizedOrganizationName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export async function getSourceMonitorDatabase(): Promise<MonitorD1Database> {
  try {
    const { env } = await import("cloudflare:workers");
    if (!env.DB) throw new Error("missing D1 binding");
    return env.DB as MonitorD1Database;
  } catch {
    throw new SourceMonitorInputError(
      503,
      "source_monitor_store_unavailable",
      "The source-monitor database is unavailable.",
    );
  }
}

const MONITOR_SELECT = `
  SELECT sm.*,
         (SELECT COUNT(*) FROM source_posting_candidates c WHERE c.monitor_id=sm.id) AS candidate_count,
         (SELECT COUNT(*) FROM source_posting_candidates c WHERE c.monitor_id=sm.id AND c.status='verified') AS verified_count
    FROM source_monitors sm`;

export async function listSourceMonitors(
  db: MonitorD1Database,
  ownerKey: string,
): Promise<{ monitors: SourceMonitorRecord[]; candidates: PostedProjectCandidate[] }> {
  ownerKey = canonicalOwnerKey(ownerKey);
  const [monitorResult, candidateResult] = await Promise.all([
    db.prepare(`${MONITOR_SELECT} WHERE sm.owner_key=? ORDER BY sm.updated_at DESC, sm.name`).bind(ownerKey).all<MonitorRow>(),
    db.prepare(
      `SELECT c.*
         FROM source_posting_candidates c
         JOIN source_monitors sm ON sm.id=c.monitor_id
        WHERE sm.owner_key=?
        ORDER BY CASE c.status WHEN 'needs-review' THEN 0 WHEN 'verified' THEN 1 WHEN 'expired' THEN 2 ELSE 3 END,
                 c.last_seen_at DESC
        LIMIT 100`,
    ).bind(ownerKey).all<CandidateRow>(),
  ]);
  return {
    monitors: resultRows(monitorResult).map(monitorRecord),
    candidates: resultRows(candidateResult).map(candidateRecord),
  };
}

export async function createSourceMonitor(
  db: MonitorD1Database,
  ownerKey: string,
  input: CreateSourceMonitorInput,
  now = new Date(),
): Promise<SourceMonitorRecord> {
  ownerKey = canonicalOwnerKey(ownerKey);
  const id = await stableId("monitor", `${ownerKey}|${input.feedUrl}`);
  const nowIso = now.toISOString();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO sources (
          id, name, owner, jurisdiction_name, jurisdiction_level, connector,
          connector_version, source_class, source_url, access_mode, cadence_minutes,
          status, lifecycle_stages, next_due_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'public-posting-monitor', '1', 'procurement', ?, 'open', ?,
                  'live', '["bidding"]', ?, ?, ?)`,
      ).bind(
        id,
        input.name,
        input.publisher,
        input.jurisdiction,
        input.city ? "local" : "state",
        input.feedUrl,
        input.cadenceMinutes,
        nowIso,
        nowIso,
        nowIso,
      ),
      db.prepare(
        `INSERT INTO source_monitors (
          id, source_id, owner_key, name, publisher, jurisdiction, city, state,
          source_type, feed_url, feed_format, cadence_minutes, status, next_due_at,
          consecutive_failures, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, ?)`,
      ).bind(
        id,
        id,
        ownerKey,
        input.name,
        input.publisher,
        input.jurisdiction,
        input.city ?? null,
        input.state ?? null,
        input.sourceType,
        input.feedUrl,
        input.feedFormat,
        input.cadenceMinutes,
        nowIso,
        ownerKey,
        nowIso,
        nowIso,
      ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/unique|constraint/i.test(message)) {
      throw new SourceMonitorInputError(409, "source_monitor_exists", "This source is already monitored by your account.");
    }
    throw error;
  }
  const row = await db.prepare(`${MONITOR_SELECT} WHERE sm.id=? AND sm.owner_key=? LIMIT 1`).bind(id, ownerKey).first<MonitorRow>();
  if (!row) throw new SourceMonitorInputError(500, "source_monitor_create_failed", "The source monitor could not be created.");
  return monitorRecord(row);
}

export async function setSourceMonitorStatus(
  db: MonitorD1Database,
  ownerKey: string,
  id: string,
  status: SourceMonitorStatus,
  now = new Date(),
): Promise<SourceMonitorRecord> {
  ownerKey = canonicalOwnerKey(ownerKey);
  const result = await db.prepare(
    `UPDATE source_monitors
        SET status=?, next_due_at=CASE WHEN ?='active' THEN ? ELSE next_due_at END, updated_at=?
      WHERE id=? AND owner_key=?`,
  ).bind(status, status, now.toISOString(), now.toISOString(), id, ownerKey).run();
  if (Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) {
    throw new SourceMonitorInputError(404, "source_monitor_not_found", "The source monitor was not found.");
  }
  await db.prepare("UPDATE sources SET status=?, next_due_at=?, updated_at=? WHERE id=?")
    .bind(status === "active" ? "live" : "paused", status === "active" ? now.toISOString() : null, now.toISOString(), id)
    .run();
  const row = await db.prepare(`${MONITOR_SELECT} WHERE sm.id=? AND sm.owner_key=? LIMIT 1`).bind(id, ownerKey).first<MonitorRow>();
  if (!row) throw new SourceMonitorInputError(404, "source_monitor_not_found", "The source monitor was not found.");
  return monitorRecord(row);
}

export async function getSourceMonitor(
  db: MonitorD1Database,
  id: string,
  ownerKey?: string,
): Promise<SourceMonitorRecord | null> {
  const row = ownerKey
    ? await db.prepare(`${MONITOR_SELECT} WHERE sm.id=? AND sm.owner_key=? LIMIT 1`).bind(id, canonicalOwnerKey(ownerKey)).first<MonitorRow>()
    : await db.prepare(`${MONITOR_SELECT} WHERE sm.id=? LIMIT 1`).bind(id).first<MonitorRow>();
  return row ? monitorRecord(row) : null;
}

export async function listDueSourceMonitors(
  db: MonitorD1Database,
  now = new Date(),
  limit = 3,
): Promise<SourceMonitorRecord[]> {
  const result = await db.prepare(
    `${MONITOR_SELECT}
      WHERE sm.status='active' AND (sm.next_due_at IS NULL OR sm.next_due_at<=?)
      ORDER BY COALESCE(sm.next_due_at, sm.created_at), sm.id
      LIMIT ?`,
  ).bind(now.toISOString(), Math.min(10, Math.max(1, Math.trunc(limit)))).all<MonitorRow>();
  return resultRows(result).map(monitorRecord);
}

function statusForReadiness(reasons: CandidateReadinessReason[]): PostedProjectCandidate["status"] {
  return reasons.includes("deadline-passed") ? "expired" : reasons.length === 0 ? "verified" : "needs-review";
}

async function getCandidateRow(db: MonitorD1Database, id: string): Promise<CandidateRow | null> {
  return db.prepare("SELECT * FROM source_posting_candidates WHERE id=? LIMIT 1").bind(id).first<CandidateRow>();
}

async function materializeCandidate(
  db: MonitorD1Database,
  monitor: SourceMonitorRecord,
  candidate: PostedProjectCandidate,
  verifiedBy: string,
  now: Date,
): Promise<string> {
  const reasons = assessPostingReadiness(candidate, now);
  if (reasons.length > 0) {
    throw new SourceMonitorInputError(
      422,
      "candidate_not_bid_ready",
      `The posting cannot be published yet: ${reasons.join(", ")}.`,
    );
  }
  const projectId = candidate.projectId ?? await stableId(
    "posted",
    `${monitor.id}|${candidate.sourceRecordId}`,
  );
  const organizationKey = normalizedOrganizationName(candidate.publisher) || candidate.publisher.toLowerCase();
  const organizationId = await stableId("org", organizationKey);
  const documentId = await stableId("doc", `${projectId}|${candidate.documentUrl}`);
  const versionId = await stableId("docv", `${projectId}|${candidate.documentUrl}|posting-v1`);
  const nowIso = now.toISOString();
  const participantRole = candidate.opportunityType === "public-bid" ? "agency" : "owner";
  const statements: MonitorPreparedStatement[] = [
    db.prepare(
      `INSERT INTO projects (
        id, canonical_key, title, summary, stage, status, agency, owner_name,
        city, state, posted_at, bid_date, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, 'bidding', 'Accepting bids', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, summary=excluded.summary, stage='bidding', status='Accepting bids',
        agency=excluded.agency, owner_name=excluded.owner_name, city=excluded.city,
        state=excluded.state, posted_at=excluded.posted_at, bid_date=excluded.bid_date,
        last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at`,
    ).bind(
      projectId,
      `${monitor.id}:${candidate.sourceRecordId}`,
      candidate.title,
      candidate.summary,
      candidate.publisher,
      candidate.opportunityType === "company-posted" ? candidate.publisher : null,
      candidate.city ?? null,
      candidate.state ?? null,
      candidate.postedAt ?? nowIso,
      candidate.bidDate,
      candidate.firstSeenAt,
      nowIso,
      nowIso,
    ),
    db.prepare(
      `INSERT INTO project_sources (
        project_id, source_id, source_record_id, source_url, confidence, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, 'official', ?, ?)
      ON CONFLICT(source_id, source_record_id) DO UPDATE SET
        project_id=excluded.project_id, source_url=excluded.source_url,
        confidence='official', last_seen_at=excluded.last_seen_at`,
    ).bind(projectId, monitor.id, candidate.sourceRecordId, candidate.sourceUrl, candidate.firstSeenAt, nowIso),
    db.prepare(
      `INSERT INTO organizations (
        id, normalized_name, display_name, organization_type, city, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(normalized_name) DO UPDATE SET
        display_name=excluded.display_name, city=COALESCE(excluded.city, organizations.city),
        state=COALESCE(excluded.state, organizations.state), updated_at=excluded.updated_at`,
    ).bind(
      organizationId,
      organizationKey,
      candidate.publisher,
      candidate.opportunityType === "public-bid" ? "agency" : "owner",
      candidate.city ?? null,
      candidate.state ?? null,
      nowIso,
      nowIso,
    ),
    db.prepare(
      `INSERT INTO project_participants (
        project_id, organization_id, role, participation_status, source_id, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, 'observed', ?, ?, ?)
      ON CONFLICT(project_id, organization_id, role) DO UPDATE SET
        participation_status='observed', source_id=excluded.source_id,
        last_seen_at=excluded.last_seen_at`,
    ).bind(projectId, organizationId, participantRole, monitor.id, candidate.firstSeenAt, nowIso),
    db.prepare(
      `INSERT INTO documents (
        id, project_id, source_id, name, document_type, description, keywords,
        source_url, access_mode, visibility, redistribution_allowed, provenance,
        ingestion_method, processing_status, search_text, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, 'specifications', ?, ?, ?, 'public', 'workspace', 0, ?,
                'source-link', 'metadata-only', ?, ?, ?)
      ON CONFLICT(project_id, source_url) DO UPDATE SET
        name=excluded.name, description=excluded.description, keywords=excluded.keywords,
        access_mode='public', ingestion_method='source-link',
        search_text=excluded.search_text, last_seen_at=excluded.last_seen_at`,
    ).bind(
      documentId,
      projectId,
      monitor.id,
      candidate.documentName ?? "Plans, specifications, or bid documents",
      `Bid document route published by ${candidate.publisher}.`,
      JSON.stringify(candidate.tradeTags),
      candidate.documentUrl,
      JSON.stringify({
        acquisitionMethod: "public-posting-monitor",
        publisher: candidate.publisher,
        sourceRecordId: candidate.sourceRecordId,
        sourceUrl: candidate.sourceUrl,
      }),
      [candidate.title, candidate.summary, ...candidate.tradeTags].join(" ").slice(0, 20_000),
      candidate.firstSeenAt,
      nowIso,
    ),
    db.prepare(
      `INSERT INTO document_versions (
        id, document_id, normalized_url, access_mode, archive_policy,
        retrieval_status, ingestion_method, authoritative, posted_at, created_at
      ) VALUES (?, ?, ?, 'public', 'link-only', 'metadata-only', 'source-link', 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        normalized_url=excluded.normalized_url, access_mode='public', authoritative=1`,
    ).bind(versionId, documentId, candidate.documentUrl, candidate.postedAt ?? nowIso, nowIso),
    db.prepare(
      `UPDATE source_posting_candidates
          SET project_id=?, status='verified', readiness_reasons='[]', reviewed_at=COALESCE(reviewed_at, ?),
              reviewed_by=COALESCE(reviewed_by, ?), last_seen_at=?
        WHERE id=?`,
    ).bind(projectId, nowIso, verifiedBy, nowIso, candidate.id),
    db.prepare(
      `INSERT INTO project_opportunity_verifications (
        project_id, candidate_id, opportunity_type, verification_status, accepting_bids,
        submission_url, evidence, verified_at, verified_by, last_checked_at, updated_at
      ) VALUES (?, ?, ?, 'verified', 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        candidate_id=excluded.candidate_id, opportunity_type=excluded.opportunity_type,
        verification_status='verified', accepting_bids=1,
        submission_url=excluded.submission_url, evidence=excluded.evidence,
        verified_at=excluded.verified_at, verified_by=excluded.verified_by,
        last_checked_at=excluded.last_checked_at, updated_at=excluded.updated_at`,
    ).bind(
      projectId,
      candidate.id,
      candidate.opportunityType,
      candidate.submissionUrl ?? null,
      JSON.stringify(candidate.evidence),
      nowIso,
      verifiedBy,
      nowIso,
      nowIso,
    ),
  ];

  if (candidate.contactName || candidate.contactEmail || candidate.contactPhone) {
    const contactIdentity = candidate.contactEmail ?? candidate.contactPhone ?? `${candidate.contactName}|${organizationKey}`;
    const contactId = await stableId("contact", `${monitor.id}|${contactIdentity}`);
    const displayName = candidate.contactName ?? candidate.contactEmail ?? candidate.contactPhone ?? candidate.publisher;
    const provenance = JSON.stringify({
      acquisitionMethod: "configured-connector",
      sourceId: monitor.id,
      sourceRecordId: candidate.sourceRecordId,
      sourceUrl: candidate.sourceUrl,
      displayName,
      participantType: "person",
      organization: candidate.publisher,
      ...(candidate.contactEmail ? { email: candidate.contactEmail } : {}),
      ...(candidate.contactPhone ? { phone: candidate.contactPhone } : {}),
    });
    statements.push(
      db.prepare(
        `INSERT INTO contacts (
          id, canonical_key, organization_id, contact_type, display_name, email,
          normalized_email, phone, source_id, source_record_id, source_url,
          provenance, confidence, verification_status, first_seen_at, last_seen_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'person', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'source-reported', ?, ?, ?, ?)
        ON CONFLICT(canonical_key) DO UPDATE SET
          display_name=excluded.display_name, email=excluded.email,
          normalized_email=excluded.normalized_email, phone=excluded.phone,
          source_url=excluded.source_url, provenance=excluded.provenance,
          verification_status='source-reported', last_seen_at=excluded.last_seen_at,
          updated_at=excluded.updated_at`,
      ).bind(
        contactId,
        `source:${monitor.id}:${candidate.sourceRecordId}:contact`,
        organizationId,
        displayName,
        candidate.contactEmail ?? null,
        candidate.contactEmail?.toLowerCase() ?? null,
        candidate.contactPhone ?? null,
        monitor.id,
        `${candidate.sourceRecordId}:contact`,
        candidate.sourceUrl,
        provenance,
        candidate.firstSeenAt,
        nowIso,
        nowIso,
        nowIso,
      ),
      db.prepare(
        `INSERT INTO project_contacts (
          project_id, contact_id, organization_id, role, role_source_text,
          relationship_status, is_primary, source_id, source_record_id, source_url,
          provenance, confidence, verification_status, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, 'Published posting contact', 'observed', 1, ?, ?, ?, ?, 1,
                  'source-reported', ?, ?)
        ON CONFLICT(project_id, contact_id, role) DO UPDATE SET
          is_primary=1, source_url=excluded.source_url, provenance=excluded.provenance,
          verification_status='source-reported', last_seen_at=excluded.last_seen_at`,
      ).bind(
        projectId,
        contactId,
        organizationId,
        participantRole,
        monitor.id,
        `${candidate.sourceRecordId}:contact`,
        candidate.sourceUrl,
        provenance,
        candidate.firstSeenAt,
        nowIso,
      ),
    );
  }
  await db.batch(statements);
  return projectId;
}

export type CandidateUpsertResult = {
  discovered: number;
  verified: number;
  needsReview: number;
  expired: number;
  candidates: PostedProjectCandidate[];
};

export async function upsertDiscoveredPostings(
  db: MonitorD1Database,
  monitor: SourceMonitorRecord,
  postings: DiscoveredPosting[],
  now = new Date(),
): Promise<CandidateUpsertResult> {
  const saved: PostedProjectCandidate[] = [];
  for (const posting of postings) {
    const id = await stableId("candidate", `${monitor.id}|${posting.sourceRecordId}`);
    const existing = await getCandidateRow(db, id);
    const observedReasons = assessPostingReadiness(posting, now);
    const observedStatus = statusForReadiness(observedReasons);
    const preserveReview = Boolean(
      existing?.reviewed_by && existing.reviewed_by !== "automatic-source-verification",
    );
    const status = preserveReview ? existing!.status : observedStatus;
    const reasons = preserveReview
      ? parsedJson<CandidateReadinessReason[]>(existing!.readiness_reasons, [])
      : observedReasons;
    const nowIso = now.toISOString();
    await db.prepare(
      `INSERT INTO source_posting_candidates (
        id, monitor_id, source_record_id, title, summary, source_url, publisher,
        city, state, posted_at, bid_date, document_url, document_name, contact_name,
        contact_email, contact_phone, submission_url, trade_tags, opportunity_type,
        status, readiness_reasons, evidence, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(monitor_id, source_record_id) DO UPDATE SET
        title=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.title ELSE source_posting_candidates.title END,
        summary=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.summary ELSE source_posting_candidates.summary END,
        source_url=excluded.source_url, publisher=excluded.publisher,
        city=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.city ELSE source_posting_candidates.city END,
        state=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.state ELSE source_posting_candidates.state END,
        posted_at=COALESCE(excluded.posted_at, source_posting_candidates.posted_at),
        bid_date=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.bid_date ELSE source_posting_candidates.bid_date END,
        document_url=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.document_url ELSE source_posting_candidates.document_url END,
        document_name=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.document_name ELSE source_posting_candidates.document_name END,
        contact_name=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.contact_name ELSE source_posting_candidates.contact_name END,
        contact_email=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.contact_email ELSE source_posting_candidates.contact_email END,
        contact_phone=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.contact_phone ELSE source_posting_candidates.contact_phone END,
        submission_url=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.submission_url ELSE source_posting_candidates.submission_url END,
        trade_tags=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.trade_tags ELSE source_posting_candidates.trade_tags END,
        status=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.status ELSE source_posting_candidates.status END,
        readiness_reasons=CASE WHEN source_posting_candidates.reviewed_by IS NULL OR source_posting_candidates.reviewed_by='automatic-source-verification' THEN excluded.readiness_reasons ELSE source_posting_candidates.readiness_reasons END,
        evidence=excluded.evidence, last_seen_at=excluded.last_seen_at`,
    ).bind(
      id,
      monitor.id,
      posting.sourceRecordId,
      posting.title,
      posting.summary,
      posting.sourceUrl,
      posting.publisher,
      posting.city ?? null,
      posting.state ?? null,
      posting.postedAt ?? null,
      posting.bidDate ?? null,
      posting.documentUrl ?? null,
      posting.documentName ?? null,
      posting.contactName ?? null,
      posting.contactEmail ?? null,
      posting.contactPhone ?? null,
      posting.submissionUrl ?? null,
      JSON.stringify(posting.tradeTags),
      posting.opportunityType,
      status,
      JSON.stringify(reasons),
      JSON.stringify(posting.evidence),
      existing?.first_seen_at ?? nowIso,
      nowIso,
    ).run();
    const row = await getCandidateRow(db, id);
    if (!row) continue;
    let candidate = candidateRecord(row);
    const currentReasons = assessPostingReadiness(candidate, now);
    if (candidate.status === "verified" && currentReasons.includes("deadline-passed")) {
      await db.prepare(
        `UPDATE source_posting_candidates
            SET status='expired', readiness_reasons=?, last_seen_at=?
          WHERE id=?`,
      ).bind(JSON.stringify(currentReasons), nowIso, candidate.id).run();
      candidate = { ...candidate, status: "expired", readinessReasons: currentReasons };
    }
    if (candidate.status === "verified") {
      const projectId = await materializeCandidate(
        db,
        monitor,
        candidate,
        candidate.reviewedBy ?? "automatic-source-verification",
        now,
      );
      candidate = { ...candidate, projectId };
    } else if (candidate.projectId && candidate.status === "expired") {
      await closeMaterializedCandidate(db, candidate, now, "Deadline passed");
    }
    saved.push(candidate);
  }
  return {
    discovered: saved.length,
    verified: saved.filter((candidate) => candidate.status === "verified").length,
    needsReview: saved.filter((candidate) => candidate.status === "needs-review").length,
    expired: saved.filter((candidate) => candidate.status === "expired").length,
    candidates: saved,
  };
}

async function closeMaterializedCandidate(
  db: MonitorD1Database,
  candidate: PostedProjectCandidate,
  now: Date,
  status: string,
): Promise<void> {
  if (!candidate.projectId) return;
  await db.batch([
    db.prepare("UPDATE projects SET stage='bid-opened', status=?, updated_at=? WHERE id=?")
      .bind(status, now.toISOString(), candidate.projectId),
    db.prepare(
      `UPDATE project_opportunity_verifications
          SET verification_status='closed', accepting_bids=0, last_checked_at=?, updated_at=?
        WHERE project_id=?`,
    ).bind(now.toISOString(), now.toISOString(), candidate.projectId),
  ]);
}

export async function reviewSourceCandidate(
  db: MonitorD1Database,
  ownerKey: string,
  candidateId: string,
  input: ReviewCandidateInput,
  now = new Date(),
): Promise<PostedProjectCandidate> {
  ownerKey = canonicalOwnerKey(ownerKey);
  const row = await db.prepare(
    `SELECT c.*
       FROM source_posting_candidates c
       JOIN source_monitors sm ON sm.id=c.monitor_id
      WHERE c.id=? AND sm.owner_key=? LIMIT 1`,
  ).bind(candidateId, ownerKey).first<CandidateRow>();
  if (!row) throw new SourceMonitorInputError(404, "candidate_not_found", "The posting candidate was not found.");
  const monitor = await getSourceMonitor(db, row.monitor_id, ownerKey);
  if (!monitor) throw new SourceMonitorInputError(404, "source_monitor_not_found", "The source monitor was not found.");
  let candidate = candidateRecord(row);
  const nowIso = now.toISOString();
  if (input.action === "reject") {
    await db.prepare(
      `UPDATE source_posting_candidates
          SET status='rejected', reviewed_at=?, reviewed_by=?, readiness_reasons='[]'
        WHERE id=?`,
    ).bind(nowIso, ownerKey, candidateId).run();
    await closeMaterializedCandidate(db, candidate, now, "Rejected during source review");
    const rejected = await getCandidateRow(db, candidateId);
    if (!rejected) throw new SourceMonitorInputError(404, "candidate_not_found", "The posting candidate was not found.");
    return candidateRecord(rejected);
  }

  candidate = {
    ...candidate,
    ...(input.title ? { title: input.title } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.city ? { city: input.city } : {}),
    ...(input.state ? { state: input.state } : {}),
    ...(input.bidDate ? { bidDate: input.bidDate } : {}),
    ...(input.documentUrl ? { documentUrl: input.documentUrl } : {}),
    ...(input.documentName ? { documentName: input.documentName } : {}),
    ...(input.contactName ? { contactName: input.contactName } : {}),
    ...(input.contactEmail ? { contactEmail: input.contactEmail } : {}),
    ...(input.contactPhone ? { contactPhone: input.contactPhone } : {}),
    ...(input.submissionUrl ? { submissionUrl: input.submissionUrl } : {}),
    ...(input.tradeTags ? { tradeTags: input.tradeTags } : {}),
    evidence: {
      ...candidate.evidence,
      bidLanguage: `${input.title ?? candidate.title} ${input.summary ?? candidate.summary}`,
      reviewerConfirmed: true,
      reviewedAt: nowIso,
    },
  };
  const reasons = assessPostingReadiness(candidate, now);
  if (reasons.length > 0) {
    throw new SourceMonitorInputError(
      422,
      "candidate_not_bid_ready",
      `Complete the posting before publishing: ${reasons.join(", ")}.`,
    );
  }
  await db.prepare(
    `UPDATE source_posting_candidates SET
      title=?, summary=?, city=?, state=?, bid_date=?, document_url=?, document_name=?,
      contact_name=?, contact_email=?, contact_phone=?, submission_url=?, trade_tags=?,
      status='verified', readiness_reasons='[]', evidence=?, reviewed_at=?, reviewed_by=?, last_seen_at=?
      WHERE id=?`,
  ).bind(
    candidate.title,
    candidate.summary,
    candidate.city ?? null,
    candidate.state ?? null,
    candidate.bidDate,
    candidate.documentUrl,
    candidate.documentName ?? null,
    candidate.contactName ?? null,
    candidate.contactEmail ?? null,
    candidate.contactPhone ?? null,
    candidate.submissionUrl ?? null,
    JSON.stringify(candidate.tradeTags),
    JSON.stringify(candidate.evidence),
    nowIso,
    ownerKey,
    nowIso,
    candidateId,
  ).run();
  const verifiedRow = await getCandidateRow(db, candidateId);
  if (!verifiedRow) throw new SourceMonitorInputError(404, "candidate_not_found", "The posting candidate was not found.");
  const verified = candidateRecord(verifiedRow);
  const projectId = await materializeCandidate(db, monitor, verified, ownerKey, now);
  return { ...verified, projectId, status: "verified", readinessReasons: [] };
}

export async function recordSourceMonitorSuccess(
  db: MonitorD1Database,
  monitor: SourceMonitorRecord,
  result: CandidateUpsertResult,
  now = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  const nextDue = new Date(now.getTime() + monitor.cadenceMinutes * 60_000).toISOString();
  await db.batch([
    db.prepare(
      `UPDATE source_monitors SET
        last_checked_at=?, last_success_at=?, last_error=NULL, consecutive_failures=0,
        next_due_at=?, updated_at=? WHERE id=?`,
    ).bind(nowIso, nowIso, nextDue, nowIso, monitor.id),
    db.prepare(
      `UPDATE sources SET
        status='live', last_checked_at=?, last_success_at=?, last_error=NULL,
        consecutive_failures=0, next_due_at=?, source_reported_total=?, updated_at=?
        WHERE id=?`,
    ).bind(nowIso, nowIso, nextDue, result.discovered, nowIso, monitor.id),
  ]);
}

export async function recordSourceMonitorFailure(
  db: MonitorD1Database,
  monitor: SourceMonitorRecord,
  error: unknown,
  now = new Date(),
): Promise<void> {
  const message = (error instanceof Error ? error.message : "Source scan failed.").slice(0, 1_000);
  const failures = monitor.consecutiveFailures + 1;
  const delayMinutes = Math.min(monitor.cadenceMinutes, 15 * 2 ** Math.min(failures - 1, 6));
  const nextDue = new Date(now.getTime() + delayMinutes * 60_000).toISOString();
  await db.batch([
    db.prepare(
      `UPDATE source_monitors SET
        last_checked_at=?, last_error=?, consecutive_failures=consecutive_failures+1,
        next_due_at=?, updated_at=? WHERE id=?`,
    ).bind(now.toISOString(), message, nextDue, now.toISOString(), monitor.id),
    db.prepare(
      `UPDATE sources SET
        status='degraded', last_checked_at=?, last_error=?,
        consecutive_failures=consecutive_failures+1, next_due_at=?, updated_at=?
        WHERE id=?`,
    ).bind(now.toISOString(), message, nextDue, now.toISOString(), monitor.id),
  ]);
}
