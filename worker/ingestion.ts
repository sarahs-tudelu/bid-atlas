import { getProjectFeed, PROJECT_SOURCE_IDS } from "../app/lib/connectors";
import {
  REGISTRATION_FIELDS_REQUIRING_OWNER_CONFIRMATION,
  TUDELU_PUBLIC_PROFILE,
} from "../app/lib/company-profile";
import { projectMetadataText } from "../app/lib/search";
import type {
  ProjectDocument,
  ProjectParticipant,
  ProjectRecord,
  SourceCursorRecord,
  SourceRecord,
} from "../app/lib/types";
import {
  completedRefreshPageTransition,
  failedRefreshPageTransition,
  type RefreshPhase,
} from "./ingestion-pagination";

export interface IngestionEnv {
  DB: D1Database;
  DOCUMENTS?: R2Bucket;
  SAM_API_KEY?: string;
}

export interface IngestionResult {
  mode: "incremental" | "bootstrap";
  status: "complete" | "partial" | "skipped";
  sources: number;
  fetchedProjects: number;
  projects: number;
  documents: number;
  participants: number;
  startedAt: string;
  finishedAt: string;
  warnings: string[];
}

const INGESTION_LOCK_SOURCE_ID = "system:ingestion-lock";
const MAX_D1_STATEMENTS_PER_RUN = 850;
const LEASE_DURATION_MS = 30 * 60 * 1000;
const JURISDICTION_INPUT_BATCH_SIZE = 15;
const JURISDICTION_ID_BATCH_SIZE = 50;
const JURISDICTION_STATEMENT_RESERVE = 30;
const AUTO_JURISDICTION_MATCH_METHODS = [
  "exact-city-state-place-name",
  "exact-county-state-government-name",
] as const;

export interface IngestionCursorState {
  pageProjectOffset: number;
  pageProjectId?: string;
  pageProcessedProjectIds: string[];
  deferredProject?: ProjectRecord;
  projectDocumentOffset: number;
  sourceIndex: number;
  refreshSourceIndex: number;
  backfillRunsSinceRefresh: number;
  activeLane?: "backfill" | "refresh";
  activeSourceIndex?: number;
  activeRefreshPhase?: RefreshPhase;
  activeRefreshCursor?: SourceCursorRecord;
  refreshCursors: Record<string, SourceCursorRecord>;
  refreshPhases: Record<string, RefreshPhase>;
  sourceCursors: Record<string, SourceCursorRecord>;
}

function cursorNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function parsedSourceCursor(value: unknown): SourceCursorRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const cursor: SourceCursorRecord = { offset: cursorNumber(record.offset) };
  if (record.refreshAfter === true) cursor.refreshAfter = true;
  if (typeof record.lastRecordUniqueId === "string" || typeof record.lastRecordUniqueId === "number") {
    cursor.lastRecordUniqueId = record.lastRecordUniqueId;
  }
  if (typeof record.lastRecordSortValue === "string" || typeof record.lastRecordSortValue === "number") {
    cursor.lastRecordSortValue = record.lastRecordSortValue;
  }
  if (typeof record.matchedRecords === "number" && Number.isFinite(record.matchedRecords)) {
    cursor.matchedRecords = cursorNumber(record.matchedRecords);
  }
  if (typeof record.windowStart === "string") cursor.windowStart = record.windowStart;
  if (typeof record.windowEnd === "string") cursor.windowEnd = record.windowEnd;
  return cursor;
}

function cursorProject(value: unknown): ProjectRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const project = value as Partial<ProjectRecord>;
  return typeof project.id === "string" &&
    typeof project.sourceId === "string" &&
    typeof project.sourceRecordId === "string" &&
    typeof project.title === "string" &&
    Array.isArray(project.documents) &&
    Array.isArray(project.participants)
    ? (project as ProjectRecord)
    : undefined;
}

function cursorProjectIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 1_000),
  )];
}

export function parseCursorState(value: string | null): IngestionCursorState {
  const empty: IngestionCursorState = {
    pageProjectOffset: 0,
    pageProcessedProjectIds: [],
    projectDocumentOffset: 0,
    sourceIndex: 0,
    refreshSourceIndex: 0,
    backfillRunsSinceRefresh: 0,
    refreshCursors: {},
    refreshPhases: {},
    sourceCursors: {},
  };
  if (!value) return empty;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const rawCursors =
      parsed.sourceCursors && typeof parsed.sourceCursors === "object"
        ? (parsed.sourceCursors as Record<string, unknown>)
        : {};
    const rawRefreshCursors =
      parsed.refreshCursors && typeof parsed.refreshCursors === "object"
        ? (parsed.refreshCursors as Record<string, unknown>)
        : {};
    const rawRefreshPhases =
      parsed.refreshPhases && typeof parsed.refreshPhases === "object"
        ? (parsed.refreshPhases as Record<string, unknown>)
        : {};
    const sourceCursors: Record<string, SourceCursorRecord> = {};
    const refreshCursors: Record<string, SourceCursorRecord> = {};
    const refreshPhases: Record<string, RefreshPhase> = {};
    for (const sourceId of PROJECT_SOURCE_IDS) {
      const sourceCursor = parsedSourceCursor(rawCursors[sourceId]);
      if (sourceCursor) sourceCursors[sourceId] = sourceCursor;
      const refreshCursor = parsedSourceCursor(rawRefreshCursors[sourceId]);
      if (refreshCursor && (refreshCursor.offset > 0 || refreshCursor.refreshAfter === true)) {
        refreshCursors[sourceId] = refreshCursor;
      }
      if (rawRefreshPhases[sourceId] === "head" || rawRefreshPhases[sourceId] === "continuation") {
        refreshPhases[sourceId] = rawRefreshPhases[sourceId];
      }
      if (refreshCursor?.refreshAfter === true) refreshPhases[sourceId] = "continuation";
    }
    const refreshSourceIndex = cursorNumber(parsed.refreshSourceIndex) % PROJECT_SOURCE_IDS.length;
    const activeLane =
      parsed.activeLane === "backfill" || parsed.activeLane === "refresh"
        ? parsed.activeLane
        : undefined;
    const activeSourceIndex =
      typeof parsed.activeSourceIndex === "number" && Number.isFinite(parsed.activeSourceIndex)
        ? cursorNumber(parsed.activeSourceIndex) % PROJECT_SOURCE_IDS.length
        : undefined;
    let activeRefreshCursor = parsedSourceCursor(parsed.activeRefreshCursor);
    let activeRefreshPhase =
      parsed.activeRefreshPhase === "head" || parsed.activeRefreshPhase === "continuation"
        ? parsed.activeRefreshPhase
        : undefined;
    // Backward-compatible import of the former single refresh cursor. It was
    // either an in-progress page or the selected source's saved continuation.
    const legacyRefreshCursor = parsedSourceCursor(parsed.refreshCursor);
    if (legacyRefreshCursor) {
      if (activeLane === "refresh") {
        activeRefreshCursor ??= legacyRefreshCursor;
        activeRefreshPhase ??=
          legacyRefreshCursor.offset > 0 || legacyRefreshCursor.refreshAfter === true
            ? "continuation"
            : "head";
      } else {
        const legacySourceId = PROJECT_SOURCE_IDS[refreshSourceIndex];
        if (legacyRefreshCursor.offset > 0 || legacyRefreshCursor.refreshAfter === true) {
          refreshCursors[legacySourceId] ??= legacyRefreshCursor;
          refreshPhases[legacySourceId] ??= "continuation";
        }
      }
    }
    return {
      // Legacy offsets addressed a single cross-source array and are not valid
      // source-page cursors. Reset them instead of skipping an unrelated page.
      pageProjectOffset: cursorNumber(parsed.pageProjectOffset),
      pageProjectId: typeof parsed.pageProjectId === "string" ? parsed.pageProjectId : undefined,
      pageProcessedProjectIds: cursorProjectIds(parsed.pageProcessedProjectIds),
      deferredProject: cursorProject(parsed.deferredProject),
      projectDocumentOffset: cursorNumber(parsed.projectDocumentOffset),
      sourceIndex: cursorNumber(parsed.sourceIndex) % PROJECT_SOURCE_IDS.length,
      refreshSourceIndex,
      backfillRunsSinceRefresh: cursorNumber(parsed.backfillRunsSinceRefresh),
      activeLane,
      activeSourceIndex,
      activeRefreshPhase,
      activeRefreshCursor,
      refreshCursors,
      refreshPhases,
      sourceCursors,
    };
  } catch {
    return empty;
  }
}

function cadenceMinutes(source: SourceRecord): number {
  const amount = Number(source.cadence.match(/\d+/)?.[0] ?? 24);
  if (/hour/i.test(source.cadence)) return amount * 60;
  if (/minute/i.test(source.cadence)) return amount;
  return amount * 24 * 60;
}

function normalizedOrganizationName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function literalParticipantEmail(value: string | undefined): {
  email: string;
  normalizedEmail: string;
} | undefined {
  const email = value?.trim();
  if (!email || email.length > 254 || /[\u0000-\u001f\u007f]/.test(email)) return undefined;
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return undefined;
  return { email, normalizedEmail: email.toLowerCase() };
}

function literalParticipantPhone(value: string | undefined): string | undefined {
  const phone = value?.trim();
  if (!phone || phone.length > 80 || /[\u0000-\u001f\u007f]/.test(phone)) return undefined;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? phone : undefined;
}

function literalParticipantSourceUrl(
  value: string | undefined,
  fallback: string,
): string | undefined {
  for (const candidate of [value, fallback]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && !url.username && !url.password) return url.toString();
    } catch {
      // Configured connectors can omit a participant URL; malformed values are not persisted.
    }
  }
  return undefined;
}

async function stableId(prefix: string, value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${prefix}_${hex}`;
}

export interface SourceParticipantContactRecord {
  id: string;
  canonicalKey: string;
  sourceRecordId: string;
  contactType: "person" | "organization";
  displayName: string;
  organizationName?: string;
  email?: string;
  normalizedEmail?: string;
  phone?: string;
  sourceUrl?: string;
  provenance: string;
  confidence: number;
}

/**
 * Build a persistence record only from literal fields already emitted by a
 * configured connector. This intentionally does not parse names, descriptions,
 * plans, or URLs for additional contact channels.
 */
export async function sourceParticipantContactRecord(
  project: Pick<ProjectRecord, "sourceId" | "sourceRecordId" | "sourceUrl" | "confidence">,
  participant: ProjectParticipant,
): Promise<SourceParticipantContactRecord | null> {
  const displayName = participant.name.trim();
  if (!displayName) return null;
  const emailRecord = literalParticipantEmail(participant.email);
  const phone = literalParticipantPhone(participant.phone);
  if (participant.participantType !== "person" && !emailRecord && !phone) return null;

  const contactType = participant.participantType ?? "person";
  const explicitOrganization = participant.organization?.trim();
  const organizationName =
    explicitOrganization || (contactType === "organization" ? displayName : undefined);
  const sourceUrl = literalParticipantSourceUrl(participant.sourceUrl, project.sourceUrl);
  const identity = [
    project.sourceId,
    project.sourceRecordId,
    participant.role,
    normalizedOrganizationName(displayName) || displayName.toLowerCase(),
    organizationName
      ? normalizedOrganizationName(organizationName) || organizationName.toLowerCase()
      : "",
    emailRecord?.normalizedEmail ?? "",
    phone?.replace(/\D/g, "") ?? "",
  ].join("|");
  const id = await stableId("contact", identity);
  const sourceRecordId = `${project.sourceRecordId}:participant:${id.slice("contact_".length)}`;
  const canonicalKey = `source:${project.sourceId}:${sourceRecordId}`;
  const literalFields = [
    "name",
    ...(participant.participantType ? ["participantType"] : []),
    ...(explicitOrganization ? ["organization"] : []),
    ...(emailRecord ? ["email"] : []),
    ...(phone ? ["phone"] : []),
    ...(participant.sourceUrl ? ["sourceUrl"] : []),
  ];
  const provenance = JSON.stringify({
    acquisitionMethod: "configured-connector",
    sourceId: project.sourceId,
    sourceRecordId: project.sourceRecordId,
    ...(sourceUrl ? { sourceUrl } : {}),
    displayName,
    role: participant.role,
    participantType: contactType,
    ...(organizationName ? { organization: organizationName } : {}),
    ...(emailRecord ? { email: emailRecord.email } : {}),
    ...(phone ? { phone } : {}),
    literalFields,
  });

  return {
    id,
    canonicalKey,
    sourceRecordId,
    contactType,
    displayName,
    ...(organizationName ? { organizationName } : {}),
    ...(emailRecord
      ? { email: emailRecord.email, normalizedEmail: emailRecord.normalizedEmail }
      : {}),
    ...(phone ? { phone } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    provenance,
    confidence: project.confidence === "official" ? 1 : 0.75,
  };
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[], size = 50) {
  for (let index = 0; index < statements.length; index += size) {
    await db.batch(statements.slice(index, index + size));
  }
}

async function acquireLease(
  db: D1Database,
  leaseOwner: string,
  now: string,
  expiresAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO sources (
        id, name, owner, jurisdiction_name, jurisdiction_level, connector,
        connector_version, source_class, source_url, access_mode, cadence_minutes,
        status, lifecycle_stages, lease_owner, lease_expires_at, created_at, updated_at
      ) VALUES (
        ?, 'BidAtlas ingestion lease', 'BidAtlas', 'System', 'system', 'internal',
        '1', 'system', 'https://bidatlas.invalid/internal', 'internal', 15,
        'system', '[]', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT(id) DO UPDATE SET
        lease_owner=excluded.lease_owner,
        lease_expires_at=excluded.lease_expires_at,
        updated_at=CURRENT_TIMESTAMP
      WHERE sources.lease_expires_at IS NULL OR sources.lease_expires_at < ?`,
    )
    .bind(INGESTION_LOCK_SOURCE_ID, leaseOwner, expiresAt, now)
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

async function releaseLease(
  db: D1Database,
  leaseOwner: string,
  cursor: IngestionCursorState | undefined,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE sources
       SET lease_owner=NULL, lease_expires_at=NULL,
           cursor=COALESCE(?, cursor), updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND lease_owner=?`,
    )
    .bind(cursor ? JSON.stringify(cursor) : null, INGESTION_LOCK_SOURCE_ID, leaseOwner)
    .run();
  if (cursor && Number(result.meta.changes ?? 0) !== 1) {
    throw new Error(
      "Ingestion cursor was not published because this run no longer owns the lease.",
    );
  }
}

function projectStatementCost(project: ProjectRecord): number {
  // project + project source + FTS delete/insert, plus as many as two exact
  // jurisdiction links, two per-source coverage-evidence rows, two aggregate
  // coverage cells, one source-contact refresh, two statements per document,
  // and as many as five statements per participant (organization,
  // relationship, contact organization, contact, and project contact).
  // Chunked lookup/delete/metric statements are covered by the fixed reserve.
  return 11 + project.documents.length * 2 + project.participants.length * 5;
}

function sourceStatement(db: D1Database, source: SourceRecord): D1PreparedStatement {
  const snapshotComplete = source.snapshotComplete ? 1 : 0;
  return db
    .prepare(
      `INSERT INTO sources (
        id, name, owner, jurisdiction_name, jurisdiction_level, connector,
        connector_version, source_class, source_url, access_mode, cadence_minutes,
        status, lifecycle_stages, last_checked_at, last_success_at,
        source_reported_total, snapshot_complete, last_complete_snapshot_at,
        consecutive_failures, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, owner=excluded.owner, jurisdiction_name=excluded.jurisdiction_name,
        jurisdiction_level=excluded.jurisdiction_level, source_class=excluded.source_class,
        source_url=excluded.source_url, access_mode=excluded.access_mode,
        cadence_minutes=excluded.cadence_minutes, status=excluded.status,
        lifecycle_stages=excluded.lifecycle_stages, last_checked_at=excluded.last_checked_at,
        last_success_at=COALESCE(sources.last_success_at, excluded.last_success_at),
        source_reported_total=CASE
          WHEN excluded.status IN ('degraded', 'credential-required')
            THEN sources.source_reported_total
          ELSE excluded.source_reported_total
        END,
        snapshot_complete=CASE
          WHEN excluded.snapshot_complete=1 THEN 1
          ELSE sources.snapshot_complete
        END,
        last_complete_snapshot_at=CASE WHEN excluded.snapshot_complete=1 THEN excluded.last_checked_at ELSE sources.last_complete_snapshot_at END,
        consecutive_failures=CASE WHEN excluded.status='degraded' THEN sources.consecutive_failures + 1 ELSE 0 END,
        updated_at=CURRENT_TIMESTAMP`,
    )
    .bind(
      source.id,
      source.name,
      source.owner,
      source.jurisdiction,
      source.level,
      source.id,
      source.sourceClass,
      source.url,
      source.access,
      cadenceMinutes(source),
      source.status,
      JSON.stringify(source.stages),
      source.lastChecked,
      null,
      source.recordCount,
      snapshotComplete,
      snapshotComplete ? source.lastChecked : null,
    );
}

function projectStatement(db: D1Database, project: ProjectRecord): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO projects (
        id, canonical_key, title, summary, stage, status, agency, address, city, county,
        state, postal_code, estimated_value, posted_at, bid_date, first_seen_at,
        last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, summary=excluded.summary, stage=excluded.stage,
        status=excluded.status, agency=excluded.agency, address=excluded.address,
        city=excluded.city, county=excluded.county, state=excluded.state,
        postal_code=excluded.postal_code, estimated_value=excluded.estimated_value,
        posted_at=excluded.posted_at, bid_date=excluded.bid_date,
        last_seen_at=CURRENT_TIMESTAMP, updated_at=excluded.updated_at`,
    )
    .bind(
      project.id,
      `${project.sourceId}:${project.sourceRecordId}`,
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
      project.value ?? null,
      project.postedAt ?? null,
      project.bidDate ?? null,
      project.updatedAt,
    );
}

function projectSourceStatement(db: D1Database, project: ProjectRecord): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_sources (
        project_id, source_id, source_record_id, source_url, confidence,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(source_id, source_record_id) DO UPDATE SET
        project_id=excluded.project_id, source_url=excluded.source_url,
        confidence=excluded.confidence, last_seen_at=CURRENT_TIMESTAMP`,
    )
    .bind(
      project.id,
      project.sourceId,
      project.sourceRecordId,
      project.sourceUrl,
      project.confidence,
    );
}

async function documentStatements(
  db: D1Database,
  project: ProjectRecord,
  document: ProjectDocument,
): Promise<D1PreparedStatement[]> {
  // The database identity is (project_id, source_url), so use the same stable
  // identity here. A source may label one URL as two document kinds without
  // creating an orphaned document-version foreign key.
  const documentId = await stableId("doc", `${project.id}|${document.url}`);
  const versionId = await stableId(
    "docv",
    `${project.id}|${document.url}|metadata-v1`,
  );
  return [
    db
      .prepare(
        `INSERT INTO documents (
          id, project_id, source_id, name, document_type, source_url, access_mode,
          first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(project_id, source_url) DO UPDATE SET
          name=excluded.name, document_type=excluded.document_type,
          access_mode=excluded.access_mode, last_seen_at=CURRENT_TIMESTAMP`,
      )
      .bind(
        documentId,
        project.id,
        project.sourceId,
        document.name,
        document.kind,
        document.url,
        document.access,
      ),
    db
      .prepare(
        `INSERT INTO document_versions (
          id, document_id, normalized_url, access_mode, archive_policy,
          retrieval_status, authoritative, created_at
        )
        SELECT ?, documents.id, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP
        FROM documents
        WHERE documents.project_id=? AND documents.source_url=?
        ON CONFLICT(id) DO UPDATE SET
          access_mode=excluded.access_mode,
          archive_policy=excluded.archive_policy,
          retrieval_status=CASE
            WHEN document_versions.retrieval_status IN (
              'metadata-only', 'account-gated', 'not-public'
            ) THEN excluded.retrieval_status
            ELSE document_versions.retrieval_status
          END,
          authoritative=MAX(document_versions.authoritative, excluded.authoritative)`,
      )
      .bind(
        versionId,
        document.url,
        document.access,
        document.access === "public" ? "review-before-archive" : "link-only",
        document.indexStatus ?? "metadata-only",
        project.id,
        document.url,
      ),
  ];
}

type ExactJurisdictionRelationship = "site" | "county";

interface JurisdictionLocationInput {
  projectId: string;
  state: string;
  city: string | null;
  county: string | null;
  countyBase: string | null;
  sourceUrl: string;
}

interface JurisdictionCandidateRow {
  projectId: string;
  jurisdictionId: string;
  relationship: ExactJurisdictionRelationship;
  matchMethod: (typeof AUTO_JURISDICTION_MATCH_METHODS)[number];
}

interface ExactJurisdictionLink extends JurisdictionCandidateRow {
  sourceUrl: string;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function exactLocationValue(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function countyBaseName(value: string | null): string | null {
  if (!value) return null;
  const base = value
    .replace(/^county of\s+/i, "")
    .replace(/\s+(county|parish|borough|census area|municipality)$/i, "")
    .trim();
  return base || null;
}

function jurisdictionLocationInputs(projects: ProjectRecord[]): JurisdictionLocationInput[] {
  return projects.flatMap((project) => {
    const state = project.state?.trim().toUpperCase();
    if (!state || !/^[A-Z]{2}$/.test(state)) return [];

    let city = exactLocationValue(project.city);
    if (
      state === "DC" &&
      city &&
      ["washington", "washington dc", "district of columbia"].includes(
        normalizedOrganizationName(city),
      )
    ) {
      city = "District of Columbia";
    }
    const county = exactLocationValue(project.county);
    if (!city && !county) return [];
    return [{
      projectId: project.id,
      state,
      city,
      county,
      countyBase: countyBaseName(county),
      sourceUrl: project.sourceUrl,
    }];
  });
}

async function findExactJurisdictionLinks(
  db: D1Database,
  projects: ProjectRecord[],
): Promise<ExactJurisdictionLink[]> {
  const inputs = jurisdictionLocationInputs(projects);
  const sourceUrlByProject = new Map(inputs.map((input) => [input.projectId, input.sourceUrl]));
  const candidates: JurisdictionCandidateRow[] = [];

  for (const batch of chunks(inputs, JURISDICTION_INPUT_BATCH_SIZE)) {
    const values = batch.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const bindings = batch.flatMap((input) => [
      input.projectId,
      input.state,
      input.city,
      input.county,
      input.countyBase,
    ]);
    const result = await db
      .prepare(
        `WITH location_input(project_id, state, city, county_name, county_base) AS (
           VALUES ${values}
         )
         SELECT
           location_input.project_id AS projectId,
           jurisdictions.id AS jurisdictionId,
           'site' AS relationship,
           'exact-city-state-place-name' AS matchMethod
         FROM location_input
         JOIN jurisdictions
           ON jurisdictions.active=1
          AND jurisdictions.registry_kind='independent-government'
          AND jurisdictions.state=location_input.state
          AND (
            (jurisdictions.fips_place IS NOT NULL AND trim(jurisdictions.fips_place) <> '')
            OR (
              location_input.state='DC'
              AND lower(trim(jurisdictions.name))='district of columbia'
            )
          )
          AND location_input.city IS NOT NULL
          AND lower(trim(jurisdictions.name)) IN (
            lower(trim(location_input.city)),
            lower(trim(location_input.city || ' city')),
            lower(trim(location_input.city || ' town')),
            lower(trim(location_input.city || ' village')),
            lower(trim(location_input.city || ' borough')),
            lower(trim(location_input.city || ' municipality')),
            lower(trim(location_input.city || ' city and borough')),
            lower(trim(location_input.city || ' city and county')),
            lower(trim(location_input.city || ' unified government')),
            lower(trim(location_input.city || ' consolidated government')),
            lower(trim('city of ' || location_input.city)),
            lower(trim('town of ' || location_input.city)),
            lower(trim('village of ' || location_input.city)),
            lower(trim('city and county of ' || location_input.city))
          )
         UNION ALL
         SELECT
           location_input.project_id AS projectId,
           jurisdictions.id AS jurisdictionId,
           'county' AS relationship,
           'exact-county-state-government-name' AS matchMethod
         FROM location_input
         JOIN jurisdictions
           ON jurisdictions.active=1
          AND jurisdictions.registry_kind='independent-government'
          AND jurisdictions.state=location_input.state
          AND jurisdictions.fips_county IS NOT NULL
          AND trim(jurisdictions.fips_county) <> ''
          AND (jurisdictions.fips_place IS NULL OR trim(jurisdictions.fips_place) = '')
          AND location_input.county_name IS NOT NULL
          AND location_input.county_base IS NOT NULL
          AND (
            lower(jurisdictions.government_type) LIKE '%county%'
            OR lower(jurisdictions.government_type) LIKE '%parish%'
            OR lower(jurisdictions.government_type) LIKE '%borough%'
            OR lower(jurisdictions.government_type) LIKE '%municipal%'
          )
          AND lower(trim(jurisdictions.name)) IN (
            lower(trim(location_input.county_name)),
            lower(trim(location_input.county_base)),
            lower(trim(location_input.county_base || ' county')),
            lower(trim(location_input.county_base || ' parish')),
            lower(trim(location_input.county_base || ' borough')),
            lower(trim(location_input.county_base || ' census area')),
            lower(trim(location_input.county_base || ' municipality')),
            lower(trim('county of ' || location_input.county_base))
          )`,
      )
      .bind(...bindings)
      .all<JurisdictionCandidateRow>();
    candidates.push(...(result.results ?? []));
  }

  const candidatesByProjectAndRelationship = new Map<string, Map<string, JurisdictionCandidateRow>>();
  for (const candidate of candidates) {
    const key = `${candidate.projectId}\u0000${candidate.relationship}`;
    const matches = candidatesByProjectAndRelationship.get(key) ?? new Map();
    matches.set(candidate.jurisdictionId, candidate);
    candidatesByProjectAndRelationship.set(key, matches);
  }

  const links: ExactJurisdictionLink[] = [];
  for (const matches of candidatesByProjectAndRelationship.values()) {
    // A state/name pair that resolves to more than one Census government is
    // deliberately left unlinked until a FIPS/Census identifier is supplied.
    if (matches.size !== 1) continue;
    const candidate = matches.values().next().value as JurisdictionCandidateRow;
    const sourceUrl = sourceUrlByProject.get(candidate.projectId);
    if (sourceUrl) links.push({ ...candidate, sourceUrl });
  }
  return links;
}

async function jurisdictionIdsForProjects(
  db: D1Database,
  projectIds: string[],
): Promise<Set<string>> {
  const jurisdictionIds = new Set<string>();
  for (const batch of chunks([...new Set(projectIds)], JURISDICTION_ID_BATCH_SIZE)) {
    if (!batch.length) continue;
    const result = await db
      .prepare(
        `SELECT DISTINCT jurisdiction_id AS jurisdictionId
         FROM project_jurisdictions
         WHERE project_id IN (${batch.map(() => "?").join(", ")})`,
      )
      .bind(...batch)
      .all<{ jurisdictionId: string }>();
    for (const row of result.results ?? []) jurisdictionIds.add(row.jurisdictionId);
  }
  return jurisdictionIds;
}

async function deleteAutomaticJurisdictionLinks(
  db: D1Database,
  projectIds: string[],
): Promise<void> {
  const methods = [...AUTO_JURISDICTION_MATCH_METHODS];
  const statements = chunks([...new Set(projectIds)], JURISDICTION_ID_BATCH_SIZE).map((batch) =>
    db
      .prepare(
        `DELETE FROM project_jurisdictions
         WHERE project_id IN (${batch.map(() => "?").join(", ")})
           AND match_method IN (${methods.map(() => "?").join(", ")})`,
      )
      .bind(...batch, ...methods),
  );
  await runBatches(db, statements);
}

function exactJurisdictionLinkStatement(
  db: D1Database,
  link: ExactJurisdictionLink,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_jurisdictions (
        project_id, jurisdiction_id, relationship, match_method, confidence,
        source_url, observed_at, verification_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, 'machine-exact', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(project_id, jurisdiction_id, relationship) DO UPDATE SET
        match_method=excluded.match_method,
        confidence=excluded.confidence,
        source_url=excluded.source_url,
        observed_at=CURRENT_TIMESTAMP,
        verification_status='machine-exact',
        updated_at=CURRENT_TIMESTAMP
      WHERE project_jurisdictions.match_method IN (
        'exact-city-state-place-name',
        'exact-county-state-government-name'
      )`,
    )
    .bind(
      link.projectId,
      link.jurisdictionId,
      link.relationship,
      link.matchMethod,
      link.sourceUrl,
    );
}

async function refreshJurisdictionMetrics(
  db: D1Database,
  jurisdictionIds: Set<string>,
): Promise<void> {
  const statements = chunks([...jurisdictionIds], JURISDICTION_ID_BATCH_SIZE).map((batch) => {
    const values = batch.map(() => "(?)").join(", ");
    return db
      .prepare(
        `WITH affected(jurisdiction_id) AS (VALUES ${values})
         INSERT INTO jurisdiction_metrics (
           jurisdiction_id, loaded_projects, planning_projects, design_projects,
           permitting_projects, bidding_projects, bid_opened_projects, awarded_projects,
           completed_projects, cancelled_projects, unclassified_projects,
           public_documents, indexed_documents, connected_source_classes,
           last_project_at, refreshed_at
         )
         SELECT
           affected.jurisdiction_id,
           COUNT(DISTINCT projects.id),
           COUNT(DISTINCT CASE WHEN projects.stage='planning' THEN projects.id END),
           COUNT(DISTINCT CASE WHEN projects.stage='design' THEN projects.id END),
           COUNT(DISTINCT CASE WHEN projects.stage='permitting' THEN projects.id END),
           COUNT(DISTINCT CASE WHEN projects.stage='bidding' THEN projects.id END),
           COUNT(DISTINCT CASE WHEN projects.stage='bid-opened' THEN projects.id END),
           COUNT(DISTINCT CASE WHEN projects.stage='awarded' THEN projects.id END),
           COUNT(DISTINCT CASE WHEN projects.stage='completed' THEN projects.id END),
           COUNT(DISTINCT CASE WHEN projects.stage='cancelled' THEN projects.id END),
           COUNT(DISTINCT CASE WHEN projects.stage='unclassified' THEN projects.id END),
           COUNT(DISTINCT CASE WHEN documents.access_mode='public' THEN documents.id END),
           COUNT(DISTINCT CASE WHEN document_extractions.indexed_at IS NOT NULL THEN documents.id END),
           (
             SELECT COUNT(DISTINCT coverage_cells.source_class)
             FROM coverage_cells
             WHERE coverage_cells.jurisdiction_id=affected.jurisdiction_id
               AND coverage_cells.coverage_state='connected'
           ),
           MAX(projects.updated_at),
           CURRENT_TIMESTAMP
         FROM affected
         LEFT JOIN project_jurisdictions
           ON project_jurisdictions.jurisdiction_id=affected.jurisdiction_id
         LEFT JOIN projects ON projects.id=project_jurisdictions.project_id
         LEFT JOIN documents ON documents.project_id=projects.id
         LEFT JOIN document_versions ON document_versions.document_id=documents.id
         LEFT JOIN document_extractions
           ON document_extractions.document_version_id=document_versions.id
         GROUP BY affected.jurisdiction_id
         ON CONFLICT(jurisdiction_id) DO UPDATE SET
           loaded_projects=excluded.loaded_projects,
           planning_projects=excluded.planning_projects,
           design_projects=excluded.design_projects,
           permitting_projects=excluded.permitting_projects,
           bidding_projects=excluded.bidding_projects,
           bid_opened_projects=excluded.bid_opened_projects,
           awarded_projects=excluded.awarded_projects,
           completed_projects=excluded.completed_projects,
           cancelled_projects=excluded.cancelled_projects,
           unclassified_projects=excluded.unclassified_projects,
           public_documents=excluded.public_documents,
           indexed_documents=excluded.indexed_documents,
           connected_source_classes=excluded.connected_source_classes,
           last_project_at=excluded.last_project_at,
           refreshed_at=CURRENT_TIMESTAMP`,
      )
      .bind(...batch);
  });
  await runBatches(db, statements);
}

async function synchronizeSourceCoverageHealth(
  db: D1Database,
  source: SourceRecord,
  forceRefresh = false,
): Promise<void> {
  if (source.sourceClass === "registry") return;
  // Source health and jurisdiction completeness are separate. A successful
  // project fetch proves that an adapter observed a record; it does not prove
  // that the adapter covers every applicable owner/source family in the
  // jurisdiction. Automatic ingestion therefore records partial evidence only.
  // A future reviewed-scope workflow may promote a cell to connected.
  const desiredState = source.status === "credential-required"
    ? "credential-required"
    : source.status === "degraded"
      ? "partial"
      : undefined;
  const refreshOnly = source.status === "live" && forceRefresh;
  if (!desiredState && !refreshOnly) return;

  const changed = desiredState
    ? await db
        .prepare(
          `SELECT count(*) AS count
           FROM coverage_evidence
           WHERE source_id=? AND evidence_state<>?`,
        )
        .bind(source.id, desiredState)
        .first<{ count: number | string }>()
    : null;
  const changedCells = Number(changed?.count ?? 0);
  if (!forceRefresh && changedCells === 0) return;

  if (desiredState && changedCells > 0) {
    await db
      .prepare(
      `UPDATE coverage_evidence
         SET evidence_state=?, last_assessed_at=CURRENT_TIMESTAMP,
             note=?
         WHERE source_id=? AND evidence_state<>?`,
      )
      .bind(
        desiredState,
        `Official ${source.name} adapter is currently ${source.status}; record observation alone is not counted as complete jurisdiction coverage.`,
        source.id,
        desiredState,
      )
      .run();
  }
  await db
    .prepare(
      `UPDATE coverage_cells
       SET coverage_state=COALESCE((
         SELECT CASE
           WHEN MAX(CASE WHEN evidence.evidence_state='connected'
                              AND evidence_sources.status='live'
                              AND evidence_sources.last_success_at IS NOT NULL
                              AND julianday(evidence_sources.last_success_at) >=
                                  julianday('now') -
                                  (MAX(evidence_sources.cadence_minutes * 3, 1440) / 1440.0)
                         THEN 1 ELSE 0 END)=1 THEN 'connected'
           WHEN MAX(CASE WHEN evidence.evidence_state='credential-required'
                         THEN 1 ELSE 0 END)=1 THEN 'credential-required'
           ELSE 'partial'
         END
         FROM coverage_evidence AS evidence
         JOIN sources AS evidence_sources ON evidence_sources.id=evidence.source_id
         WHERE evidence.jurisdiction_id=coverage_cells.jurisdiction_id
           AND evidence.source_class=coverage_cells.source_class
           AND evidence.lifecycle_stage=coverage_cells.lifecycle_stage
       ), 'not-connected'),
       source_id=NULL,
       last_assessed_at=CURRENT_TIMESTAMP,
       note='Aggregate state derived from per-source coverage evidence.'
       WHERE EXISTS (
         SELECT 1 FROM coverage_evidence AS changed_evidence
         WHERE changed_evidence.source_id=?
           AND changed_evidence.jurisdiction_id=coverage_cells.jurisdiction_id
           AND changed_evidence.source_class=coverage_cells.source_class
           AND changed_evidence.lifecycle_stage=coverage_cells.lifecycle_stage
       )`,
    )
    .bind(source.id)
    .run();
  await db
    .prepare(
      `UPDATE jurisdiction_metrics
       SET connected_source_classes=(
         SELECT COUNT(DISTINCT coverage_cells.source_class)
         FROM coverage_cells
         WHERE coverage_cells.jurisdiction_id=jurisdiction_metrics.jurisdiction_id
           AND coverage_cells.coverage_state='connected'
       ), refreshed_at=CURRENT_TIMESTAMP
       WHERE jurisdiction_id IN (
         SELECT jurisdiction_id FROM coverage_evidence WHERE source_id=?
       )`,
    )
    .bind(source.id)
    .run();
}

interface CoverageAggregateKey {
  jurisdictionId: string;
  sourceClass: SourceRecord["sourceClass"];
  lifecycleStage: ProjectRecord["stage"];
}

function coverageEvidenceStatement(
  db: D1Database,
  link: ExactJurisdictionLink,
  project: ProjectRecord,
  source: SourceRecord,
): D1PreparedStatement {
  const evidenceKey = `${link.jurisdictionId}:${source.sourceClass}:${project.stage}:${source.id}`;
  return db
    .prepare(
      `INSERT INTO coverage_evidence (
        id, jurisdiction_id, source_class, lifecycle_stage, source_id,
        evidence_state, last_assessed_at, note
      ) VALUES (?, ?, ?, ?, ?, 'partial', CURRENT_TIMESTAMP, ?)
      ON CONFLICT(jurisdiction_id, source_class, lifecycle_stage, source_id) DO UPDATE SET
        evidence_state=CASE
          WHEN coverage_evidence.evidence_state='connected' THEN 'connected'
          ELSE 'partial'
        END,
        last_assessed_at=CURRENT_TIMESTAMP,
        note=excluded.note`,
    )
    .bind(
      `coverage-evidence:${evidenceKey}`,
      link.jurisdictionId,
      source.sourceClass,
      project.stage,
      source.id,
      `Official ${source.name} record successfully ingested and exactly matched to this jurisdiction. This is occurrence evidence, not proof of complete jurisdiction coverage.`,
    );
}

function coverageCellStatement(
  db: D1Database,
  key: CoverageAggregateKey,
): D1PreparedStatement {
  const coverageKey = `${key.jurisdictionId}:${key.sourceClass}:${key.lifecycleStage}`;
  return db
    .prepare(
      `INSERT INTO coverage_cells (
        id, jurisdiction_id, source_class, lifecycle_stage, coverage_state,
        source_id, last_assessed_at, note
      )
      SELECT ?, ?, ?, ?, COALESCE((
        SELECT CASE
          WHEN MAX(CASE WHEN evidence.evidence_state='connected'
                             AND evidence_sources.status='live'
                             AND evidence_sources.last_success_at IS NOT NULL
                             AND julianday(evidence_sources.last_success_at) >=
                                 julianday('now') -
                                 (MAX(evidence_sources.cadence_minutes * 3, 1440) / 1440.0)
                        THEN 1 ELSE 0 END)=1 THEN 'connected'
          WHEN MAX(CASE WHEN evidence.evidence_state='credential-required'
                        THEN 1 ELSE 0 END)=1 THEN 'credential-required'
          ELSE 'partial'
        END
        FROM coverage_evidence AS evidence
        JOIN sources AS evidence_sources ON evidence_sources.id=evidence.source_id
        WHERE evidence.jurisdiction_id=?
          AND evidence.source_class=?
          AND evidence.lifecycle_stage=?
      ), 'not-connected'), NULL, CURRENT_TIMESTAMP,
      'Aggregate state derived from per-source coverage evidence.'
      ON CONFLICT(jurisdiction_id, source_class, lifecycle_stage) DO UPDATE SET
        coverage_state=excluded.coverage_state,
        source_id=NULL,
        last_assessed_at=CURRENT_TIMESTAMP,
        note=excluded.note`,
    )
    .bind(
      `coverage:${coverageKey}`,
      key.jurisdictionId,
      key.sourceClass,
      key.lifecycleStage,
      key.jurisdictionId,
      key.sourceClass,
      key.lifecycleStage,
    );
}

async function synchronizeProjectJurisdictions(
  db: D1Database,
  projects: ProjectRecord[],
  sources: SourceRecord[],
): Promise<void> {
  const projectIds = projects.map((project) => project.id);
  if (!projectIds.length) return;

  const affectedJurisdictionIds = await jurisdictionIdsForProjects(db, projectIds);
  const links = await findExactJurisdictionLinks(db, projects);
  await deleteAutomaticJurisdictionLinks(db, projectIds);
  await runBatches(db, links.map((link) => exactJurisdictionLinkStatement(db, link)));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const sourceById = new Map(
    sources
      .filter((source) => source.status === "live")
      .map((source) => [source.id, source]),
  );
  const evidenceStatements = new Map<string, D1PreparedStatement>();
  const coverageKeys = new Map<string, CoverageAggregateKey>();
  for (const link of links) {
    const project = projectById.get(link.projectId);
    const source = project ? sourceById.get(project.sourceId) : undefined;
    if (!project || !source || source.sourceClass === "registry") continue;
    const coverageKey = `${link.jurisdictionId}\u0000${source.sourceClass}\u0000${project.stage}`;
    const evidenceKey = `${coverageKey}\u0000${source.id}`;
    evidenceStatements.set(
      evidenceKey,
      coverageEvidenceStatement(db, link, project, source),
    );
    coverageKeys.set(coverageKey, {
      jurisdictionId: link.jurisdictionId,
      sourceClass: source.sourceClass,
      lifecycleStage: project.stage,
    });
  }
  await runBatches(db, [...evidenceStatements.values()]);
  await runBatches(
    db,
    [...coverageKeys.values()].map((key) => coverageCellStatement(db, key)),
  );
  for (const link of links) affectedJurisdictionIds.add(link.jurisdictionId);
  await refreshJurisdictionMetrics(db, affectedJurisdictionIds);
}

export async function runIngestion(
  env: IngestionEnv,
  mode: "incremental" | "bootstrap" = "incremental",
): Promise<IngestionResult> {
  const startedAt = new Date().toISOString();
  const leaseOwner = `ingestion:${mode}:${crypto.randomUUID()}`;
  const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
  const acquired = await acquireLease(env.DB, leaseOwner, startedAt, leaseExpiresAt);
  if (!acquired) {
    return {
      mode,
      status: "skipped",
      sources: 0,
      fetchedProjects: 0,
      projects: 0,
      documents: 0,
      participants: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      warnings: ["Another ingestion run currently owns the D1 lease."],
    };
  }

  const systemRunId = `${INGESTION_LOCK_SOURCE_ID}:${startedAt}:${leaseOwner}`;
  let systemRunStarted = false;
  let releaseCursor: IngestionCursorState | undefined;
  let primaryFailure = false;

  try {
    await env.DB
      .prepare(
        `INSERT INTO ingestion_runs (
          id, source_id, status, started_at, records_read, projects_created,
          projects_updated, documents_found, trigger, pages_read,
          snapshot_complete, metrics
        ) VALUES (?, ?, 'running', ?, 0, 0, 0, 0, ?, 0, 0, ?)`,
      )
      .bind(
        systemRunId,
        INGESTION_LOCK_SOURCE_ID,
        startedAt,
        mode,
        JSON.stringify({ statementBudget: MAX_D1_STATEMENTS_PER_RUN }),
      )
      .run();
    systemRunStarted = true;

    const [cursorRow, registryRow] = await Promise.all([
      env.DB
        .prepare("SELECT cursor FROM sources WHERE id = ?")
        .bind(INGESTION_LOCK_SOURCE_ID)
        .first<{ cursor: string | null }>(),
      env.DB
        .prepare("SELECT count(*) AS count FROM jurisdictions")
        .first<{ count: number | string }>(),
    ]);
    const cursorState = parseCursorState(cursorRow?.cursor ?? null);
    const registryRowsLoaded = Number(registryRow?.count ?? 0);
    const continuingLane =
      cursorState.activeLane !== undefined && cursorState.activeSourceIndex !== undefined;
    const ingestionLane = continuingLane
      ? cursorState.activeLane!
      : mode === "incremental" && cursorState.backfillRunsSinceRefresh >= 2
        ? "refresh"
        : "backfill";
    const sourceIndex = continuingLane
      ? cursorState.activeSourceIndex!
      : ingestionLane === "refresh"
        ? cursorState.refreshSourceIndex
        : cursorState.sourceIndex;
    const selectedSourceId = PROJECT_SOURCE_IDS[sourceIndex];
    const savedRefreshCursor = cursorState.refreshCursors[selectedSourceId];
    const scheduledRefreshPhase: RefreshPhase =
      cursorState.refreshPhases[selectedSourceId] === "continuation" && savedRefreshCursor
        ? "continuation"
        : "head";
    const selectedRefreshPhase: RefreshPhase | undefined =
      ingestionLane === "refresh"
        ? continuingLane
          ? cursorState.activeRefreshPhase ?? scheduledRefreshPhase
          : scheduledRefreshPhase
        : undefined;
    const selectedSourceCursor = ingestionLane === "refresh"
      ? continuingLane && cursorState.activeRefreshCursor
        ? cursorState.activeRefreshCursor
        : selectedRefreshPhase === "continuation" && savedRefreshCursor
          ? savedRefreshCursor
          : { offset: 0 }
      : cursorState.sourceCursors[selectedSourceId] ?? { offset: 0 };
    const feed = await getProjectFeed({
      mode: "ingest",
      lane: ingestionLane,
      samApiKey: env.SAM_API_KEY,
      sourceId: selectedSourceId,
      sourceCursors: {
        ...cursorState.sourceCursors,
        [selectedSourceId]: selectedSourceCursor,
      },
    });
    const fetchedProjects = feed.projects.length;
    const selectedPage = feed.sourcePages?.[selectedSourceId];
    const savedDeferredProject = cursorState.deferredProject;
    const deferredProject =
      savedDeferredProject?.sourceId === selectedSourceId
        ? savedDeferredProject
        : undefined;
    const processedProjectIds = new Set(cursorState.pageProcessedProjectIds);
    const deferredPageIndex = deferredProject
      ? feed.projects.findIndex((project) => project.id === deferredProject.id)
      : -1;
    const pendingProjects: Array<{
      project: ProjectRecord;
      documentOffset: number;
      pageIndex: number;
      advanceTo: number;
    }> = [
      ...(deferredProject
        ? [{
            project: deferredProject,
            documentOffset: cursorState.projectDocumentOffset,
            pageIndex: deferredPageIndex >= 0 ? deferredPageIndex : cursorState.pageProjectOffset,
            advanceTo: deferredPageIndex >= 0 ? deferredPageIndex + 1 : cursorState.pageProjectOffset,
          }]
        : []),
      ...feed.projects.flatMap((project, index) =>
        project.id === deferredProject?.id || processedProjectIds.has(project.id)
          ? []
          : [{
              project,
              documentOffset: 0,
              pageIndex: index,
              advanceTo: index + 1,
            }],
      ),
    ];

    // The normal path consumes 10 fixed statements plus two per source. Keep a
    // separate reserve for chunked exact-jurisdiction lookup, stale-link
    // cleanup, and metric refresh below the paid-plan 1,000-query ceiling.
    let remainingProjectStatements = Math.max(
      0,
      MAX_D1_STATEMENTS_PER_RUN -
        (10 + feed.sources.length * 2 + JURISDICTION_STATEMENT_RESERVE),
    );
    const projects: ProjectRecord[] = [];
    const nextProcessedProjectIds = new Set(processedProjectIds);
    let nextPageProjectOffset = cursorState.pageProjectOffset;
    let nextPageProjectId: string | undefined =
      deferredProject?.id ?? feed.projects.find((project) => !processedProjectIds.has(project.id))?.id;
    let nextDeferredProject = deferredProject;
    let nextProjectDocumentOffset = deferredProject ? cursorState.projectDocumentOffset : 0;
    let deferredDocuments = 0;
    for (const pending of pendingProjects) {
      const { project, documentOffset, pageIndex, advanceTo } = pending;
      const projectCountBefore = projects.length;
      const remainingProject = documentOffset
        ? { ...project, documents: project.documents.slice(documentOffset) }
        : project;
      const fullCost = projectStatementCost(remainingProject);
      if (fullCost <= remainingProjectStatements) {
        projects.push(remainingProject);
        remainingProjectStatements -= fullCost;
        nextProcessedProjectIds.add(project.id);
        nextPageProjectOffset = advanceTo;
        nextPageProjectId = feed.projects[nextPageProjectOffset]?.id;
        nextDeferredProject = undefined;
        nextProjectDocumentOffset = 0;
        continue;
      }

      // Only split an individually oversized record. Document chunks retain a
      // dedicated cursor, so attachment links are deferred instead of dropped.
      if (projects.length === 0) {
        const baseCost = 10 + project.participants.length * 2;
        const documentSlots = Math.max(
          0,
          Math.floor((remainingProjectStatements - baseCost) / 2),
        );
        if (baseCost <= remainingProjectStatements) {
          const documents = project.documents.slice(
            documentOffset,
            documentOffset + documentSlots,
          );
          const boundedProject = {
            ...project,
            documents,
          };
          projects.push(boundedProject);
          const consumedDocumentOffset = documentOffset + documents.length;
          deferredDocuments = Math.max(0, project.documents.length - consumedDocumentOffset);
          if (consumedDocumentOffset >= project.documents.length) {
            nextProcessedProjectIds.add(project.id);
            nextPageProjectOffset = advanceTo;
            nextPageProjectId = feed.projects[nextPageProjectOffset]?.id;
            nextDeferredProject = undefined;
            nextProjectDocumentOffset = 0;
          } else {
            nextPageProjectOffset = pageIndex;
            nextPageProjectId = project.id;
            nextDeferredProject = project;
            nextProjectDocumentOffset = consumedDocumentOffset;
          }
          remainingProjectStatements -= projectStatementCost(boundedProject);
        }
      }
      if (projects.length === projectCountBefore) {
        nextPageProjectOffset = pageIndex;
        nextPageProjectId = project.id;
        nextDeferredProject = project;
        nextProjectDocumentOffset = documentOffset;
      }
      break;
    }

    const processedFeedProjectCount = feed.projects.reduce(
      (count, project) => count + (nextProcessedProjectIds.has(project.id) ? 1 : 0),
      0,
    );
    nextPageProjectOffset = processedFeedProjectCount;
    nextPageProjectId = nextDeferredProject?.id ?? feed.projects.find(
      (project) => !nextProcessedProjectIds.has(project.id),
    )?.id;
    const pageProjectsComplete =
      !nextDeferredProject &&
      (fetchedProjects === 0 ||
        (processedFeedProjectCount >= fetchedProjects && nextProjectDocumentOffset === 0));
    const nextSourceCursors = { ...cursorState.sourceCursors };
    let nextSourceIndex = cursorState.sourceIndex;
    let nextRefreshSourceIndex = cursorState.refreshSourceIndex;
    let nextBackfillRunsSinceRefresh = cursorState.backfillRunsSinceRefresh;
    let nextRefreshCursors = { ...cursorState.refreshCursors };
    let nextRefreshPhases = { ...cursorState.refreshPhases };
    let nextActiveLane: IngestionCursorState["activeLane"];
    let nextActiveSourceIndex: number | undefined;
    let nextActiveRefreshPhase: RefreshPhase | undefined;
    let nextActiveRefreshCursor: SourceCursorRecord | undefined;
    if (selectedPage && pageProjectsComplete) {
      nextPageProjectOffset = 0;
      nextPageProjectId = undefined;
      nextDeferredProject = undefined;
      nextProjectDocumentOffset = 0;
      nextProcessedProjectIds.clear();
      if (ingestionLane === "backfill") {
        nextSourceCursors[selectedSourceId] = selectedPage.nextCursor;
        nextSourceIndex = (sourceIndex + 1) % PROJECT_SOURCE_IDS.length;
        nextBackfillRunsSinceRefresh += 1;
      } else {
        // Refreshes remain one bounded upstream page per scheduled run. Modern
        // adapters preserve a forward-only sort/id watermark; legacy adapters
        // preserve their source-native continuation. Both yield to the normal
        // backfill cadence and rotate fairly after this materialized page.
        const transition = completedRefreshPageTransition({
          sourceId: selectedSourceId,
          sourceIndex,
          sourceCount: PROJECT_SOURCE_IDS.length,
          phase: selectedRefreshPhase ?? "head",
          page: selectedPage,
          refreshCursors: nextRefreshCursors,
          refreshPhases: nextRefreshPhases,
        });
        nextRefreshSourceIndex = transition.refreshSourceIndex;
        nextRefreshCursors = transition.refreshCursors;
        nextRefreshPhases = transition.refreshPhases;
        nextBackfillRunsSinceRefresh = transition.backfillRunsSinceRefresh;
      }
    } else if (selectedPage) {
      // Freeze source-native scan windows and keysets while a page is only
      // partly persisted. Retrying must reconstruct the same upstream page.
      nextActiveLane = ingestionLane;
      nextActiveSourceIndex = sourceIndex;
      if (ingestionLane === "backfill") {
        nextSourceCursors[selectedSourceId] = selectedPage.currentCursor;
      } else {
        nextActiveRefreshPhase = selectedRefreshPhase ?? "head";
        nextActiveRefreshCursor = selectedPage.currentCursor;
      }
    } else if (!selectedPage && !nextDeferredProject) {
      // Never erase a source's refresh continuation after an upstream failure.
      // Rotate to the next refresh source; this source retries the same phase
      // on its next fair turn without blocking unrelated heads or backfills.
      nextPageProjectOffset = 0;
      nextPageProjectId = undefined;
      nextDeferredProject = undefined;
      nextProjectDocumentOffset = 0;
      nextProcessedProjectIds.clear();
      if (ingestionLane === "backfill") {
        nextSourceIndex = (sourceIndex + 1) % PROJECT_SOURCE_IDS.length;
        nextBackfillRunsSinceRefresh += 1;
      } else {
        const transition = failedRefreshPageTransition(
          sourceIndex,
          PROJECT_SOURCE_IDS.length,
        );
        nextRefreshSourceIndex = transition.refreshSourceIndex;
        nextBackfillRunsSinceRefresh = transition.backfillRunsSinceRefresh;
      }
    } else {
      // Connector failure cannot discard a staged project/document remainder.
      nextActiveLane = ingestionLane;
      nextActiveSourceIndex = sourceIndex;
      if (ingestionLane === "refresh") {
        nextActiveRefreshPhase = selectedRefreshPhase ?? "head";
        nextActiveRefreshCursor = selectedSourceCursor;
      }
    }
    const nextCursorState: IngestionCursorState = {
      pageProjectOffset: nextPageProjectOffset,
      pageProjectId: nextPageProjectId,
      pageProcessedProjectIds: [...nextProcessedProjectIds],
      deferredProject: nextDeferredProject,
      projectDocumentOffset: nextProjectDocumentOffset,
      sourceIndex: nextSourceIndex,
      refreshSourceIndex: nextRefreshSourceIndex,
      backfillRunsSinceRefresh: nextBackfillRunsSinceRefresh,
      activeLane: nextActiveLane,
      activeSourceIndex: nextActiveSourceIndex,
      activeRefreshPhase: nextActiveRefreshPhase,
      activeRefreshCursor: nextActiveRefreshCursor,
      refreshCursors: nextRefreshCursors,
      refreshPhases: nextRefreshPhases,
      sourceCursors: nextSourceCursors,
    };

    const fetchedBySource = new Map<string, number>();
    const processedBySource = new Map<string, number>();
    const persistedDocumentsBySource = new Map<string, number>();
    for (const project of feed.projects) {
      fetchedBySource.set(project.sourceId, (fetchedBySource.get(project.sourceId) ?? 0) + 1);
    }
    for (const project of projects) {
      processedBySource.set(
        project.sourceId,
        (processedBySource.get(project.sourceId) ?? 0) + 1,
      );
      persistedDocumentsBySource.set(
        project.sourceId,
        (persistedDocumentsBySource.get(project.sourceId) ?? 0) + project.documents.length,
      );
    }

    const persistedSources = feed.sources.map<SourceRecord>((source) => {
      if (source.id === "census-government-units") {
        return {
          ...source,
          loadedCount: registryRowsLoaded,
          snapshotComplete: registryRowsLoaded >= source.recordCount,
        };
      }
      const processed = processedBySource.get(source.id) ?? 0;
      return {
        ...source,
        loadedCount: processed,
        snapshotComplete:
          source.id === selectedSourceId
            ? Boolean(source.snapshotComplete) && pageProjectsComplete
            : Boolean(source.snapshotComplete),
      };
    });

    const warnings = [...feed.warnings];
    if (!pageProjectsComplete) {
      warnings.push(
        `D1 statement budget persisted ${projects.length.toLocaleString("en-US")} project records from ${selectedSourceId}; the next run re-fetches this page and resumes the remaining stable project identities after ${nextCursorState.pageProjectOffset.toLocaleString("en-US")} current-page records.`,
      );
    }
    if (deferredDocuments > 0) {
      warnings.push(
        `${deferredDocuments.toLocaleString("en-US")} document links remain queued for the current project; the next run resumes at document offset ${nextCursorState.projectDocumentOffset.toLocaleString("en-US")}.`,
      );
    }

    await env.DB
      .prepare(
        `INSERT INTO supplier_profiles (
          id, legal_name, website, address_line_1, city, state, postal_code,
          public_phone, public_email, products, source_url, verified_at,
          created_at, updated_at
        ) VALUES ('tudelu', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          legal_name=excluded.legal_name, website=excluded.website,
          address_line_1=excluded.address_line_1, city=excluded.city,
          state=excluded.state, postal_code=excluded.postal_code,
          public_phone=excluded.public_phone, public_email=excluded.public_email,
          products=excluded.products, source_url=excluded.source_url,
          verified_at=excluded.verified_at, updated_at=CURRENT_TIMESTAMP`,
      )
      .bind(
        TUDELU_PUBLIC_PROFILE.legalName,
        TUDELU_PUBLIC_PROFILE.website,
        TUDELU_PUBLIC_PROFILE.addressLine1,
        TUDELU_PUBLIC_PROFILE.city,
        TUDELU_PUBLIC_PROFILE.state,
        TUDELU_PUBLIC_PROFILE.postalCode,
        TUDELU_PUBLIC_PROFILE.phone,
        TUDELU_PUBLIC_PROFILE.publicEmail,
        JSON.stringify(TUDELU_PUBLIC_PROFILE.products),
        TUDELU_PUBLIC_PROFILE.sourceUrl,
        TUDELU_PUBLIC_PROFILE.verifiedAt,
      )
      .run();

    await runBatches(
      env.DB,
      persistedSources.map((source) =>
        sourceStatement(
          env.DB,
          source.id === "census-government-units"
            ? source
            : { ...source, snapshotComplete: false },
        ),
      ),
    );
    const selectedPersistedSource = persistedSources.find(
      (source) => source.id === selectedSourceId,
    );
    const selectedSourceHealth = selectedPersistedSource
      ? await env.DB
          .prepare("SELECT last_success_at AS lastSuccessAt FROM sources WHERE id=?")
          .bind(selectedSourceId)
          .first<{ lastSuccessAt: string | null }>()
      : null;
    if (selectedPersistedSource && selectedPersistedSource.status !== "live") {
      await synchronizeSourceCoverageHealth(env.DB, selectedPersistedSource);
    }

    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO portal_accounts (
            id, supplier_profile_id, source_id, portal_family, jurisdiction_name,
            registration_url, login_url, username_email, status,
            verification_status, note, created_at, updated_at
          ) VALUES (
            'portal:sam:tudelu', 'tudelu', 'sam-contract-opportunities', 'SAM.gov',
            'United States', 'https://sam.gov/content/entity-registration',
            'https://sam.gov/content/home', ?, 'needs-user-input', 'not-started',
            'Public company details are prefilled; owner-controlled fields and every final submission require confirmation.',
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
          ON CONFLICT(id) DO UPDATE SET
            username_email=excluded.username_email, status=excluded.status,
            note=excluded.note, updated_at=CURRENT_TIMESTAMP`,
        )
        .bind(TUDELU_PUBLIC_PROFILE.publicEmail),
      env.DB
        .prepare(
          `INSERT INTO portal_registration_tasks (
            id, portal_account_id, status, required_fields, blocking_reason,
            next_action, created_at, updated_at
          ) VALUES (
            'registration:sam:tudelu', 'portal:sam:tudelu', 'waiting-for-owner', ?,
            'Identity, tax, qualification, verification, and legal-attestation fields cannot be inferred from a public website.',
            'Collect the owner-confirmed registration packet once, then request action-time confirmation before submitting portal terms or registration.',
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
          ON CONFLICT(id) DO UPDATE SET
            required_fields=excluded.required_fields,
            blocking_reason=excluded.blocking_reason,
            next_action=excluded.next_action,
            updated_at=CURRENT_TIMESTAMP`,
        )
        .bind(JSON.stringify(REGISTRATION_FIELDS_REQUIRING_OWNER_CONFIRMATION)),
    ]);

    await runBatches(env.DB, projects.map((project) => projectStatement(env.DB, project)));
    await runBatches(
      env.DB,
      projects.map((project) => projectSourceStatement(env.DB, project)),
    );

    const documentQueries: D1PreparedStatement[] = [];
    const participantQueries: D1PreparedStatement[] = [];
    const searchQueries: D1PreparedStatement[] = [];
    let documentCount = 0;
    let participantCount = 0;

    for (const project of projects) {
      participantQueries.push(
        env.DB
          .prepare(
            `DELETE FROM project_contacts
              WHERE project_id=? AND source_id=? AND source_record_id=?
                AND relationship_status='observed'
                AND verification_status='source-reported'`,
          )
          .bind(project.id, project.sourceId, project.sourceRecordId),
      );
      searchQueries.push(
        env.DB.prepare("DELETE FROM project_fts WHERE project_id = ?").bind(project.id),
        env.DB
          .prepare(
            `INSERT INTO project_fts (
              project_id, title, summary, agency, owner, address, city, county, state, participants
            )
            SELECT
              ?, ?,
              trim(? || ' ' || COALESCE((
                SELECT group_concat(documents.name || ' ' || documents.document_type, ' ')
                FROM documents
                WHERE documents.project_id=?
              ), '')),
              ?, ?, ?, ?, ?, ?, ?`,
          )
          .bind(
            project.id,
            project.title,
            projectMetadataText({ ...project, documents: [] }),
            project.id,
            project.agency,
            project.participants.find((participant) => participant.role === "owner")?.name ?? "",
            project.address ?? "",
            project.city ?? "",
            project.county ?? "",
            project.state ?? "",
            project.participants.map((participant) => `${participant.role} ${participant.name}`).join(" "),
          ),
      );

      for (const document of project.documents) {
        documentQueries.push(...(await documentStatements(env.DB, project, document)));
        documentCount += 1;
      }

      for (const participant of project.participants) {
        const normalizedName = normalizedOrganizationName(participant.name);
        const organizationId = await stableId("org", normalizedName);
        participantQueries.push(
          env.DB
            .prepare(
              `INSERT INTO organizations (
                id, normalized_name, display_name, organization_type, created_at, updated_at
              ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
              ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, updated_at=CURRENT_TIMESTAMP`,
            )
            .bind(organizationId, normalizedName, participant.name, participant.role),
          env.DB
            .prepare(
              `INSERT INTO project_participants (
                project_id, organization_id, role, participation_status, source_id,
                first_seen_at, last_seen_at
              ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
              ON CONFLICT(project_id, organization_id, role) DO UPDATE SET
                participation_status=excluded.participation_status,
                source_id=excluded.source_id, last_seen_at=CURRENT_TIMESTAMP`,
            )
            .bind(project.id, organizationId, participant.role, "reported", project.sourceId),
        );

        const contact = await sourceParticipantContactRecord(project, participant);
        if (contact) {
          const contactOrganizationName = contact.organizationName;
          const contactOrganizationId = contactOrganizationName
            ? await stableId("org", normalizedOrganizationName(contactOrganizationName))
            : null;
          if (contactOrganizationName && contactOrganizationId) {
            participantQueries.push(
              env.DB
                .prepare(
                  `INSERT INTO organizations (
                    id, normalized_name, display_name, organization_type, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                  ON CONFLICT(id) DO UPDATE SET
                    display_name=excluded.display_name, updated_at=CURRENT_TIMESTAMP`,
                )
                .bind(
                  contactOrganizationId,
                  normalizedOrganizationName(contactOrganizationName),
                  contactOrganizationName,
                  participant.role,
                ),
            );
          }
          participantQueries.push(
            env.DB
              .prepare(
                `INSERT INTO contacts (
                  id, canonical_key, organization_id, contact_type, display_name,
                  email, normalized_email, phone, source_id, source_record_id,
                  source_url, provenance, confidence, verification_status,
                  email_verification_status, phone_verification_status,
                  first_seen_at, last_seen_at, created_at, updated_at
                ) VALUES (
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'source-reported', ?, ?,
                  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                ON CONFLICT(id) DO UPDATE SET
                  organization_id=COALESCE(excluded.organization_id, contacts.organization_id),
                  contact_type=excluded.contact_type,
                  display_name=excluded.display_name,
                  email=excluded.email,
                  normalized_email=excluded.normalized_email,
                  phone=excluded.phone,
                  source_url=COALESCE(excluded.source_url, contacts.source_url),
                  provenance=excluded.provenance,
                  confidence=excluded.confidence,
                  email_verification_status=excluded.email_verification_status,
                  phone_verification_status=excluded.phone_verification_status,
                  last_seen_at=CURRENT_TIMESTAMP,
                  updated_at=CURRENT_TIMESTAMP`,
              )
              .bind(
                contact.id,
                contact.canonicalKey,
                contactOrganizationId,
                contact.contactType,
                contact.displayName,
                contact.email ?? null,
                contact.normalizedEmail ?? null,
                contact.phone ?? null,
                project.sourceId,
                contact.sourceRecordId,
                contact.sourceUrl ?? null,
                contact.provenance,
                contact.confidence,
                contact.email ? "source-reported" : "unknown",
                contact.phone ? "source-reported" : "unknown",
              ),
            env.DB
              .prepare(
                `INSERT INTO project_contacts (
                  project_id, contact_id, organization_id, role, role_source_text,
                  relationship_status, is_primary, is_decision_maker, source_id,
                  source_record_id, source_url, provenance, confidence,
                  verification_status, first_seen_at, last_seen_at
                ) VALUES (
                  ?, ?, ?, ?, ?, 'observed', 0, 0, ?, ?, ?, ?, ?, 'source-reported',
                  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                ON CONFLICT(project_id, contact_id, role) DO UPDATE SET
                  organization_id=excluded.organization_id,
                  role_source_text=excluded.role_source_text,
                  relationship_status=excluded.relationship_status,
                  source_id=excluded.source_id,
                  source_record_id=excluded.source_record_id,
                  source_url=excluded.source_url,
                  provenance=excluded.provenance,
                  confidence=excluded.confidence,
                  verification_status=excluded.verification_status,
                  last_seen_at=CURRENT_TIMESTAMP`,
              )
              .bind(
                project.id,
                contact.id,
                contactOrganizationId,
                participant.role,
                participant.role,
                project.sourceId,
                project.sourceRecordId,
                contact.sourceUrl ?? null,
                contact.provenance,
                contact.confidence,
              ),
          );
        }
        participantCount += 1;
      }
    }

    await runBatches(env.DB, documentQueries);
    await runBatches(env.DB, participantQueries);
    await runBatches(env.DB, searchQueries);
    await synchronizeProjectJurisdictions(env.DB, projects, persistedSources);

    const successfullyPersistedSource = selectedPersistedSource?.status === "live"
      ? selectedPersistedSource
      : undefined;
    if (successfullyPersistedSource && selectedPage) {
      const persistedAt = new Date().toISOString();
      await env.DB
        .prepare(
          `UPDATE sources
             SET last_success_at=?,
                 snapshot_complete=CASE WHEN ?=1 THEN 1 ELSE snapshot_complete END,
                 last_complete_snapshot_at=CASE WHEN ?=1 THEN ? ELSE last_complete_snapshot_at END,
                 updated_at=CURRENT_TIMESTAMP
           WHERE id=?`,
        )
        .bind(
          persistedAt,
          successfullyPersistedSource.snapshotComplete ? 1 : 0,
          successfullyPersistedSource.snapshotComplete ? 1 : 0,
          persistedAt,
          selectedSourceId,
        )
        .run();
      await synchronizeSourceCoverageHealth(
        env.DB,
        successfullyPersistedSource,
        !selectedSourceHealth?.lastSuccessAt,
      );
    }

    const finishedAt = new Date().toISOString();
    const runQueries = persistedSources.map((source) => {
      const fetched = fetchedBySource.get(source.id) ?? 0;
      const processed = processedBySource.get(source.id) ?? 0;
      const partial = !source.snapshotComplete || processed < fetched;
      const status =
        source.status === "degraded"
          ? "failed"
          : source.status === "credential-required"
            ? "credential-required"
            : partial
              ? "partial"
              : "complete";
      return env.DB
        .prepare(
          `INSERT INTO ingestion_runs (
            id, source_id, status, started_at, finished_at, records_read,
            projects_created, projects_updated, documents_found, trigger, pages_read,
            snapshot_complete, metrics
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${source.id}:${startedAt}`,
          source.id,
          status,
          startedAt,
          finishedAt,
          processed,
          processed,
          persistedDocumentsBySource.get(source.id) ?? 0,
          mode,
          source.status === "live" ? 1 : 0,
          source.snapshotComplete ? 1 : 0,
          JSON.stringify({
            fetchedRecords: fetched,
            persistedRecords: processed,
            sourceReportedTotal: source.recordCount,
            registryRowsPresent:
              source.id === "census-government-units" ? registryRowsLoaded : undefined,
            persistenceBudgetLimited: processed < fetched,
            warnings,
          }),
        );
    });
    await runBatches(env.DB, runQueries);

    const partial =
      !pageProjectsComplete ||
      deferredDocuments > 0 ||
      persistedSources.some(
        (source) =>
          source.status === "degraded" ||
          source.status === "credential-required" ||
          !source.snapshotComplete,
      );
    await env.DB
      .prepare(
        `UPDATE ingestion_runs
         SET status=?, finished_at=?, records_read=?, projects_updated=?,
             documents_found=?, snapshot_complete=?, metrics=?
         WHERE id=?`,
      )
      .bind(
        partial ? "partial" : "complete",
        finishedAt,
        projects.length,
        projects.length,
        documentCount,
        partial ? 0 : 1,
        JSON.stringify({
          fetchedProjects,
          persistedProjects: projects.length,
          deferredDocuments,
          selectedSourceId,
          ingestionLane,
          sourcePage: selectedPage,
          nextPageProjectOffset: nextCursorState.pageProjectOffset,
          nextPageProjectId: nextCursorState.pageProjectId,
          nextProjectDocumentOffset: nextCursorState.projectDocumentOffset,
          nextBackfillSourceIndex: nextCursorState.sourceIndex,
          nextRefreshSourceIndex: nextCursorState.refreshSourceIndex,
          backfillRunsSinceRefresh: nextCursorState.backfillRunsSinceRefresh,
          nextSourceCursor:
            ingestionLane === "refresh"
              ? nextCursorState.activeRefreshCursor ??
                nextCursorState.refreshCursors[selectedSourceId]
              : nextCursorState.sourceCursors[selectedSourceId],
          nextRefreshPhase: nextCursorState.refreshPhases[selectedSourceId],
          statementBudget: MAX_D1_STATEMENTS_PER_RUN,
          warnings,
        }),
        systemRunId,
      )
      .run();

    // Publish the cursor only after every database write for this source page
    // succeeds. A thrown write leaves the cursor unchanged for an idempotent retry.
    releaseCursor = nextCursorState;

    return {
      mode,
      status: partial ? "partial" : "complete",
      sources: feed.sources.length,
      fetchedProjects,
      projects: projects.length,
      documents: documentCount,
      participants: participantCount,
      startedAt,
      finishedAt,
      warnings,
    };
  } catch (error) {
    primaryFailure = true;
    if (systemRunStarted) {
      const finishedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : "Unknown ingestion error";
      try {
        await env.DB
          .prepare(
            `UPDATE ingestion_runs
             SET status='failed', finished_at=?, error=?
             WHERE id=?`,
          )
          .bind(finishedAt, message.slice(0, 2_000), systemRunId)
          .run();
      } catch {
        // Preserve the original ingestion failure if failure logging also fails.
      }
    }
    throw error;
  } finally {
    try {
      await releaseLease(env.DB, leaseOwner, releaseCursor);
    } catch (releaseError) {
      // Do not report success when the durable cursor failed to publish. When
      // ingestion already failed, preserve that primary error and let the
      // expiring lease make the page retryable.
      if (!primaryFailure) {
        const message = releaseError instanceof Error
          ? releaseError.message
          : "Ingestion cursor publication failed";
        if (systemRunStarted) {
          try {
            await env.DB
              .prepare(
                `UPDATE ingestion_runs
                 SET status='failed', finished_at=?, error=?
                 WHERE id=?`,
              )
              .bind(new Date().toISOString(), message.slice(0, 2_000), systemRunId)
              .run();
          } catch {
            // Preserve the cursor-publication error if status repair also fails.
          }
        }
        throw releaseError;
      }
    }
  }
}
