import {
  CALTRANS_INDEX_URL,
  CALTRANS_SOURCE_ID,
  type ResolvedResearchProject,
} from "./caltrans.ts";
import { cleanResearchText, ProjectResearchError, RESEARCH_MAX_ATTEMPTS } from "./contracts.ts";
import {
  NYC_CITY_RECORD_DATASET_URL,
  NYC_CITY_RECORD_SOURCE_ID,
} from "./nyc-city-record.ts";
import { configuredPermitSourceRegistration } from "./configured-permit.ts";
import { publicDotSourceRegistration } from "./public-dot.ts";
import type {
  OfficialResearchSource,
  PlanExtractionHandoff,
  ProjectResearchJobStatus,
  ProjectResearchRecord,
  ResearchFinding,
  ResearchGap,
  ResearchSourceAttempt,
  ResearchRunOutput,
} from "./types.ts";

export interface ResearchPreparedStatement {
  bind(...values: unknown[]): ResearchPreparedStatement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] } | T[]>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface ResearchD1Database {
  prepare(sql: string): ResearchPreparedStatement;
  batch(statements: ResearchPreparedStatement[]): Promise<unknown[]>;
}

type KnownProjectRow = {
  id: string;
  canonical_key: string;
  title: string;
  status: string;
  stage: string;
};

type JobRow = {
  id: string;
  project_id: string;
  visibility: "workspace" | "public";
  status: ProjectResearchJobStatus;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  fresh_until: string | null;
  next_retry_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt: number;
  max_attempts: number;
};

export type ResearchClaim = {
  jobId: string;
  projectId: string;
  leaseOwner: string;
  attempt: number;
};

type ResolvedSourceRegistration = {
  id: string;
  name: string;
  owner: string;
  jurisdictionName: string;
  jurisdictionLevel: "state" | "local";
  connector: string;
  sourceClass: "procurement" | "permits";
  sourceUrl: string;
  accessMode: "open";
  cadenceMinutes: number;
  status: "live";
  lifecycleStages: string[];
};

const RESOLVED_SOURCE_REGISTRATIONS: Record<string, ResolvedSourceRegistration> = {
  [CALTRANS_SOURCE_ID]: {
    id: CALTRANS_SOURCE_ID,
    name: "Caltrans Contracting Opportunities Portal",
    owner: "California Department of Transportation",
    jurisdictionName: "California",
    jurisdictionLevel: "state",
    connector: CALTRANS_SOURCE_ID,
    sourceClass: "procurement",
    sourceUrl: CALTRANS_INDEX_URL,
    accessMode: "open",
    cadenceMinutes: 120,
    status: "live",
    lifecycleStages: ["planning", "bidding"],
  },
  [NYC_CITY_RECORD_SOURCE_ID]: {
    id: NYC_CITY_RECORD_SOURCE_ID,
    name: "NYC City Record procurement notices",
    owner: "New York City Department of Citywide Administrative Services",
    jurisdictionName: "New York City, New York",
    jurisdictionLevel: "local",
    connector: "socrata-dg92-zbpx",
    sourceClass: "procurement",
    sourceUrl: NYC_CITY_RECORD_DATASET_URL,
    accessMode: "open",
    cadenceMinutes: 1_440,
    status: "live",
    lifecycleStages: ["planning", "bidding", "bid-opened", "awarded", "unclassified"],
  },
};

function sourceRegistration(project: ResolvedResearchProject): ResolvedSourceRegistration {
  const registration = RESOLVED_SOURCE_REGISTRATIONS[project.sourceId] ??
    configuredPermitSourceRegistration(project.sourceId) ??
    publicDotSourceRegistration(project.sourceId);
  if (!registration) {
    throw new ProjectResearchError(
      500,
      "unregistered_research_source",
      "The verified project source is not registered for on-demand research persistence.",
    );
  }
  return registration;
}

function rows<T>(result: { results?: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : result.results ?? [];
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return value && typeof value === "object" ? value as T : fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function getProjectResearchDatabase(): Promise<ResearchD1Database> {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new ProjectResearchError(503, "research_database_unavailable", "The project research database is unavailable.");
  return env.DB as ResearchD1Database;
}

export async function findKnownResearchProject(
  db: ResearchD1Database,
  projectId: string,
): Promise<KnownProjectRow | null> {
  return db.prepare(
    `SELECT id, canonical_key, title, status, stage
     FROM projects
     WHERE id=? OR canonical_key=?
     ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END
     LIMIT 1`,
  ).bind(projectId, projectId, projectId).first<KnownProjectRow>();
}

export async function persistResolvedResearchProject(
  db: ResearchD1Database,
  project: ResolvedResearchProject,
  now: string,
): Promise<KnownProjectRow> {
  const registration = sourceRegistration(project);
  await db.prepare(
    `INSERT INTO projects (
       id, canonical_key, title, summary, stage, status, agency, address, city,
       county, state, postal_code, estimated_value, posted_at, bid_date,
       first_seen_at, last_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       canonical_key=excluded.canonical_key,
       title=excluded.title,
       summary=excluded.summary,
       stage=excluded.stage,
       status=excluded.status,
       agency=excluded.agency,
       address=excluded.address,
       city=excluded.city,
       county=excluded.county,
       state=excluded.state,
       postal_code=excluded.postal_code,
       estimated_value=excluded.estimated_value,
       posted_at=excluded.posted_at,
       bid_date=excluded.bid_date,
       last_seen_at=excluded.last_seen_at,
       updated_at=excluded.updated_at`,
  ).bind(
    project.id,
    project.canonicalKey,
    project.title,
    project.summary,
    project.stage,
    project.status,
    project.agency,
    project.address ?? null,
    project.city ?? null,
    project.county ?? null,
    project.state ?? null,
    project.postalCode ?? null,
    project.estimatedValue ?? null,
    project.postedAt ?? null,
    project.bidDate ?? null,
    now,
    now,
    project.sourceActivityAt,
  ).run();
  await db.prepare(
    `INSERT INTO sources (
       id, name, owner, jurisdiction_name, jurisdiction_level, connector,
       connector_version, source_class, source_url, access_mode,
       cadence_minutes, status, lifecycle_stages, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, '1', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    registration.id,
    registration.name,
    registration.owner,
    registration.jurisdictionName,
    registration.jurisdictionLevel,
    registration.connector,
    registration.sourceClass,
    registration.sourceUrl,
    registration.accessMode,
    registration.cadenceMinutes,
    registration.status,
    JSON.stringify(registration.lifecycleStages),
    now,
    now,
  ).run();
  await db.prepare(
    `INSERT INTO project_sources (
       project_id, source_id, source_record_id, source_url, confidence,
       first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, 'official', ?, ?)
     ON CONFLICT(source_id, source_record_id) DO UPDATE SET
       source_url=excluded.source_url,
       last_seen_at=excluded.last_seen_at`,
  ).bind(
    project.id,
    registration.id,
    project.sourceRecordId,
    project.sourceUrl,
    now,
    now,
  ).run();
  const stored = await findKnownResearchProject(db, project.id);
  if (!stored) throw new ProjectResearchError(500, "research_project_persist_failed", "The verified project could not be cached for research.");
  return stored;
}

export async function loadProjectOfficialSources(
  db: ResearchD1Database,
  projectId: string,
): Promise<OfficialResearchSource[]> {
  const result = await db.prepare(
    `SELECT ps.source_id AS source_id, s.name AS source_label,
            ps.source_url AS project_url, s.source_url AS root_url,
            s.source_class AS source_class, s.connector AS connector
     FROM project_sources ps
     JOIN sources s ON s.id=ps.source_id
     WHERE ps.project_id=?
     ORDER BY ps.last_seen_at DESC
     LIMIT 8`,
  ).bind(projectId).all<{
    source_id: string;
    source_label: string;
    project_url: string;
    root_url: string;
    source_class: string;
    connector: string;
  }>();
  const sources: OfficialResearchSource[] = [];
  for (const row of rows(result)) {
    const isConfiguredExact = row.source_class === "permits" ||
      row.connector === "public-dot-exact";
    const candidates = (
      row.source_id === NYC_CITY_RECORD_SOURCE_ID || isConfiguredExact
        ? [row.project_url]
        : [row.project_url, row.root_url]
    ).filter((url, index, all) => url && all.indexOf(url) === index);
    const allowedHosts = candidates.flatMap((url) => {
      try {
        return [new URL(url).hostname.toLowerCase()];
      } catch {
        return [];
      }
    });
    for (const url of candidates) {
      try {
        if (new URL(url).protocol !== "https:") continue;
      } catch {
        continue;
      }
      sources.push({
        sourceId: row.source_id,
        sourceLabel: row.source_label,
        url,
        strategy: isConfiguredExact
          ? "configured-exact-record"
          : "generic-official-page",
        allowedHosts,
      });
    }
  }
  return sources;
}

async function jobFor(
  db: ResearchD1Database,
  projectId: string,
  visibility: "workspace" | "public",
  publicOnly = false,
): Promise<JobRow | null> {
  return db.prepare(
    `SELECT id, project_id, visibility, status, requested_at, started_at,
            completed_at, fresh_until, next_retry_at, lease_owner,
            lease_expires_at, attempt, max_attempts
     FROM project_research_jobs
     WHERE project_id=? AND visibility=?
       ${publicOnly ? "AND public_approved_at IS NOT NULL" : ""}
     LIMIT 1`,
  ).bind(projectId, visibility).first<JobRow>();
}

export async function getProjectResearchRecord(
  db: ResearchD1Database,
  projectId: string,
  options: { authenticated: boolean; cached?: boolean },
): Promise<ProjectResearchRecord | null> {
  const known = await findKnownResearchProject(db, projectId);
  if (!known) return null;
  const job = options.authenticated
    ? (await jobFor(db, known.id, "workspace")) ?? (await jobFor(db, known.id, "public", true))
    : await jobFor(db, known.id, "public", true);
  if (!job) {
    if (!options.authenticated) return null;
    return {
      projectId: known.id,
      status: "not-researched",
      visibility: "workspace",
      attempt: 0,
      maxAttempts: RESEARCH_MAX_ATTEMPTS,
      cached: false,
      contacts: [],
      documents: [],
      scopeFacts: [],
      lifecycle: [],
      gaps: [],
      extractionHandoffs: [],
      sources: [],
      notice: "Open-project research has not run yet. Findings are evidence-only and missing information remains an explicit gap.",
    };
  }

  const [findingResult, gapResult, handoffResult, attemptResult] = await Promise.all([
    db.prepare(
      `SELECT id, data FROM project_research_findings
       WHERE research_job_id=? ORDER BY category, created_at, id`,
    ).bind(job.id).all<{ id: string; data: unknown }>(),
    db.prepare(
      `SELECT id, gap_type, status, message, next_action
       FROM project_research_gaps WHERE research_job_id=? ORDER BY gap_type`,
    ).bind(job.id).all<{ id: string; gap_type: ResearchGap["gapType"]; status: "open"; message: string; next_action: string | null }>(),
    db.prepare(
      `SELECT id, finding_id, handoff_type, status, source_url, detail, requested_at, updated_at
       FROM project_research_handoffs WHERE research_job_id=? ORDER BY requested_at, id`,
    ).bind(job.id).all<{
      id: string; finding_id: string | null; handoff_type: "plan-text-extraction";
      status: PlanExtractionHandoff["status"]; source_url: string; detail: string;
      requested_at: string; updated_at: string;
    }>(),
    db.prepare(
      `SELECT id, source_id, source_url, final_url, status, http_status,
              content_type, bytes_read, duration_ms, error_code, error_message,
              started_at, completed_at
       FROM project_research_source_attempts WHERE research_job_id=? ORDER BY started_at, id`,
    ).bind(job.id).all<{
      id: string; source_id: string | null; source_url: string; final_url: string | null;
      status: ResearchSourceAttempt["status"]; http_status: number | null; content_type: string | null;
      bytes_read: number; duration_ms: number; error_code: string | null; error_message: string | null;
      started_at: string; completed_at: string;
    }>(),
  ]);

  const findings = rows(findingResult).flatMap((row) => {
    const finding = safeJson<ResearchFinding | null>(row.data, null);
    return finding ? [{ ...finding, id: row.id }] : [];
  });
  return {
    projectId: known.id,
    status: job.status,
    visibility: job.visibility,
    requestedAt: job.requested_at,
    ...(job.started_at ? { startedAt: job.started_at } : {}),
    ...(job.completed_at ? { completedAt: job.completed_at } : {}),
    ...(job.fresh_until ? { freshUntil: job.fresh_until } : {}),
    ...(job.next_retry_at ? { nextRetryAt: job.next_retry_at } : {}),
    attempt: job.attempt,
    maxAttempts: job.max_attempts,
    cached: options.cached ?? true,
    contacts: findings.filter((finding) => finding.kind === "contact"),
    documents: findings.filter((finding) => finding.kind === "document"),
    scopeFacts: findings.filter((finding) => finding.kind === "scope"),
    lifecycle: findings.filter((finding) => finding.kind === "lifecycle"),
    gaps: rows(gapResult).map((gap) => ({
      id: gap.id,
      gapType: gap.gap_type,
      status: "open",
      message: gap.message,
      ...(gap.next_action ? { nextAction: gap.next_action } : {}),
    })),
    extractionHandoffs: rows(handoffResult).map((handoff) => ({
      id: handoff.id,
      ...(handoff.finding_id ? { findingId: handoff.finding_id } : {}),
      handoffType: handoff.handoff_type,
      status: handoff.status,
      sourceUrl: handoff.source_url,
      detail: handoff.detail,
      requestedAt: handoff.requested_at,
      updatedAt: handoff.updated_at,
    })),
    sources: rows(attemptResult).map((attempt) => ({
      id: attempt.id,
      ...(attempt.source_id ? { sourceId: attempt.source_id } : {}),
      sourceUrl: attempt.source_url,
      ...(attempt.final_url ? { finalUrl: attempt.final_url } : {}),
      status: attempt.status,
      ...(attempt.http_status !== null ? { httpStatus: attempt.http_status } : {}),
      ...(attempt.content_type ? { contentType: attempt.content_type } : {}),
      bytesRead: attempt.bytes_read,
      durationMs: attempt.duration_ms,
      ...(attempt.error_code ? { errorCode: attempt.error_code } : {}),
      ...(attempt.error_message ? { errorMessage: attempt.error_message } : {}),
      startedAt: attempt.started_at,
      completedAt: attempt.completed_at,
    })),
    notice: "Research is source-backed and cached. Empty fields are gaps, not guesses. Plan OCR, PDF extraction, and CAD conversion run only through the separate authorized extraction handoff.",
  };
}

export async function claimProjectResearch(
  db: ResearchD1Database,
  projectId: string,
  requestedBy: string,
  force: boolean,
  now: Date,
): Promise<ResearchClaim | null> {
  const cacheKey = `${projectId}:workspace`;
  const nowIso = now.toISOString();
  const initialId = `research:${crypto.randomUUID()}`;
  await db.prepare(
    `INSERT INTO project_research_jobs (
       id, project_id, cache_key, visibility, status, requested_by,
       trigger, attempt, max_attempts, requested_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'workspace', 'queued', ?, 'project-open', 0, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO NOTHING`,
  ).bind(initialId, projectId, cacheKey, requestedBy, RESEARCH_MAX_ATTEMPTS, nowIso, nowIso, nowIso).run();

  let job = await jobFor(db, projectId, "workspace");
  if (!job) throw new ProjectResearchError(500, "research_job_create_failed", "The research job could not be created.");
  const fresh = ["complete", "partial"].includes(job.status) && timestamp(job.fresh_until) > now.getTime();
  const activeLease = job.status === "running" && timestamp(job.lease_expires_at) > now.getTime();
  const backoffActive = job.status === "failed" && timestamp(job.next_retry_at) > now.getTime();
  const attemptsExhausted = job.status === "failed" && job.attempt >= job.max_attempts;
  if (!force && (fresh || activeLease || backoffActive || attemptsExhausted)) return null;

  const resetAttempts = force || ["complete", "partial"].includes(job.status);
  await db.prepare(
    `UPDATE project_research_jobs
     SET status='queued', requested_by=?, requested_at=?, started_at=NULL,
         completed_at=NULL, fresh_until=NULL, next_retry_at=NULL,
         lease_owner=NULL, lease_expires_at=NULL, error_code=NULL,
         error_message=NULL, attempt=?, updated_at=?
     WHERE id=?`,
  ).bind(requestedBy, nowIso, resetAttempts ? 0 : job.attempt, nowIso, job.id).run();

  const leaseOwner = `lease:${crypto.randomUUID()}`;
  const leaseExpiresAt = new Date(now.getTime() + 30_000).toISOString();
  await db.prepare(
    `UPDATE project_research_jobs
     SET status='running', attempt=attempt+1, started_at=?, lease_owner=?,
         lease_expires_at=?, updated_at=?
     WHERE id=? AND status='queued'`,
  ).bind(nowIso, leaseOwner, leaseExpiresAt, nowIso, job.id).run();
  job = await jobFor(db, projectId, "workspace");
  if (!job || job.lease_owner !== leaseOwner || job.status !== "running") return null;
  return { jobId: job.id, projectId, leaseOwner, attempt: job.attempt };
}

function findingDedupeKey(finding: ResearchFinding): string {
  const key = finding.kind === "contact"
    ? `${finding.email ?? ""}|${finding.phone ?? ""}|${finding.displayName ?? ""}`
    : finding.kind === "document"
      ? finding.url
      : finding.kind === "scope"
        ? `${finding.factType}|${finding.value}`
        : `${finding.officialStatus}|${finding.sourceUrl}`;
  return cleanResearchText(`${finding.kind}|${key}`.toLowerCase(), 700);
}

export async function finalizeProjectResearch(
  db: ResearchD1Database,
  claim: ResearchClaim,
  output: ResearchRunOutput,
  status: "complete" | "partial" | "failed",
  now: Date,
  options: { freshUntil?: Date; nextRetryAt?: Date; errorCode?: string; errorMessage?: string } = {},
): Promise<boolean> {
  const current = await db.prepare(
    `SELECT lease_owner FROM project_research_jobs WHERE id=? AND status='running'`,
  ).bind(claim.jobId).first<{ lease_owner: string | null }>();
  if (!current || current.lease_owner !== claim.leaseOwner) return false;
  const nowIso = now.toISOString();
  const statements: ResearchPreparedStatement[] = [
    db.prepare("DELETE FROM project_research_handoffs WHERE research_job_id=?").bind(claim.jobId),
    db.prepare("DELETE FROM project_research_findings WHERE research_job_id=?").bind(claim.jobId),
    db.prepare("DELETE FROM project_research_gaps WHERE research_job_id=?").bind(claim.jobId),
    db.prepare("DELETE FROM project_research_source_attempts WHERE research_job_id=?").bind(claim.jobId),
  ];
  for (const finding of output.findings) {
    statements.push(db.prepare(
      `INSERT INTO project_research_findings (
         id, research_job_id, project_id, category, finding_type, dedupe_key,
         data, source_id, source_url, source_label, evidence, provenance,
         confidence, observed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      finding.id,
      claim.jobId,
      claim.projectId,
      finding.kind,
      finding.kind === "scope" ? finding.factType : finding.kind === "document" ? finding.documentType : finding.kind,
      findingDedupeKey(finding),
      JSON.stringify(finding),
      finding.sourceId ?? null,
      finding.sourceUrl,
      finding.sourceLabel ?? null,
      finding.evidence,
      JSON.stringify(finding.provenance),
      finding.confidence,
      finding.observedAt,
      nowIso,
    ));
  }
  for (const gap of output.gaps) {
    statements.push(db.prepare(
      `INSERT INTO project_research_gaps (
         id, research_job_id, project_id, gap_type, status, message, next_action, created_at
       ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), claim.jobId, claim.projectId, gap.gapType, gap.message, gap.nextAction ?? null, nowIso));
  }
  for (const attempt of output.attempts) {
    statements.push(db.prepare(
      `INSERT INTO project_research_source_attempts (
         id, research_job_id, project_id, source_id, source_url, final_url,
         status, http_status, content_type, bytes_read, duration_ms,
         error_code, error_message, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), claim.jobId, claim.projectId, attempt.sourceId ?? null,
      attempt.sourceUrl, attempt.finalUrl ?? null, attempt.status,
      attempt.httpStatus ?? null, attempt.contentType ?? null, attempt.bytesRead,
      attempt.durationMs, attempt.errorCode ?? null, attempt.errorMessage ?? null,
      attempt.startedAt, attempt.completedAt,
    ));
  }
  for (const handoff of output.handoffs) {
    statements.push(db.prepare(
      `INSERT INTO project_research_handoffs (
         id, research_job_id, project_id, finding_id, handoff_type, status,
         source_url, detail, requested_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), claim.jobId, claim.projectId, handoff.findingId ?? null,
      handoff.handoffType, handoff.status, handoff.sourceUrl, handoff.detail,
      nowIso, nowIso,
    ));
  }
  statements.push(db.prepare(
    `UPDATE project_research_jobs
     SET status=?, completed_at=?, fresh_until=?, next_retry_at=?,
         lease_owner=NULL, lease_expires_at=NULL, error_code=?, error_message=?,
         updated_at=?
     WHERE id=? AND lease_owner=? AND status='running'`,
  ).bind(
    status,
    nowIso,
    options.freshUntil?.toISOString() ?? null,
    options.nextRetryAt?.toISOString() ?? null,
    options.errorCode ?? null,
    options.errorMessage ? cleanResearchText(options.errorMessage, 500) : null,
    nowIso,
    claim.jobId,
    claim.leaseOwner,
  ));
  await db.batch(statements);
  return true;
}
