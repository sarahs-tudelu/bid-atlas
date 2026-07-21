import type {
  ProjectDocument,
  ProjectParticipant,
  ProjectRecord,
  ProjectSearchOptions,
  ProjectStage,
} from "../app/lib/types";
import {
  ACTIVE_STATUS_TOKENS,
  CLOSED_STATUS_TOKENS,
  INACTIVE_STATUS_TOKENS,
  NEW_ACTIVITY_DAYS,
  PASSED_BID_GRACE_DAYS,
  STALE_ACTIVITY_DAYS,
} from "../app/lib/outreach-intelligence";
import { normalizeStateCode } from "../app/lib/national-coverage";
import { bidDueWindow, normalizeLocationQuery } from "../app/lib/search";
import {
  bidDateTimeZoneForSource,
  calendarDateInTimeZone,
  DEFAULT_BID_DATE_TIME_ZONE,
  sourceBidDateTimeZones,
} from "../app/lib/deadline-time";
import { getDb } from "./index";

const DEFAULT_SEARCH_PAGE_SIZE = 10;
const MAX_SEARCH_PAGE_SIZE = 50;
const SQL_BIND_CHUNK = 75;

type SqlBinding = string | number | null;

interface D1ResultLike<T> {
  results?: T[];
}

interface D1PreparedStatementLike {
  bind(...values: SqlBinding[]): D1PreparedStatementLike;
  all<T>(): Promise<D1ResultLike<T>>;
}

interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
}

interface ProjectIdRow {
  project_id: string;
}

interface ExistingProjectRow extends ProjectIdRow {
  stage: string;
  state: string | null;
}

interface CountRow {
  count: number | string;
}

interface InventoryRow {
  total_projects: number | string | null;
  planning_projects: number | string | null;
  design_projects: number | string | null;
  permitting_projects: number | string | null;
  bidding_projects: number | string | null;
  bid_opened_projects: number | string | null;
  awarded_projects: number | string | null;
  construction_projects: number | string | null;
  completed_projects: number | string | null;
  cancelled_projects: number | string | null;
  unclassified_projects: number | string | null;
  refreshed_at: string | null;
}

interface GroupedCountRow {
  key: string;
  count: number | string;
}

interface PersistedProjectRow {
  id: string;
  title: string;
  summary: string;
  stage: string;
  status: string;
  agency: string;
  address: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  postal_code: string | null;
  estimated_value: number | null;
  posted_at: string | null;
  bid_date: string | null;
  updated_at: string;
  source_id: string | null;
  source_record_id: string | null;
  project_source_url: string | null;
  confidence: string | null;
  source_name: string | null;
  registry_source_url: string | null;
  connector: string | null;
}

interface PersistedDocumentRow {
  project_id: string;
  name: string;
  document_type: string;
  source_url: string;
  access_mode: string;
  text_indexed: number;
}

interface PersistedParticipantRow {
  project_id: string;
  display_name: string;
  role: string;
}

interface PersistedProjectContactRow extends PersistedParticipantRow {
  participant_type: string | null;
  organization_name: string | null;
  email: string | null;
  phone: string | null;
  source_url: string | null;
}

export interface PersistedSearchSuccess {
  available: true;
  projects: ProjectRecord[];
  matchedProjectCount: number;
  eligibleMetadataProjects: number;
  eligibleDocumentTextProjects: number;
  documentIndexedCandidateIds: string[];
  documentMatchedCandidateIds: string[];
  resultLimitReached: boolean;
  offset: number;
  limit: number;
}

export interface PersistedSearchUnavailable {
  available: false;
  reason: "binding-unavailable" | "query-failed";
  error?: string;
}

export type PersistedSearchResult = PersistedSearchSuccess | PersistedSearchUnavailable;

export interface PersistedInventorySuccess {
  available: true;
  totalProjects: number;
  stageCounts: Record<ProjectStage, number>;
  stateCounts: Record<string, number>;
  sourceCounts: Record<string, number>;
  documentTextIndexedProjects: number;
  contractorOrganizations: number;
  jurisdictionRows: number;
  refreshedAt?: string;
  existingCandidateIds: string[];
  existingCandidates: Array<{
    id: string;
    stage: ProjectStage;
    state?: string;
  }>;
  existingContractorOrganizationKeys: string[];
}

export type PersistedInventoryResult =
  | PersistedInventorySuccess
  | PersistedSearchUnavailable;

export type PersistedProjectResult =
  | { available: true; project: ProjectRecord | null }
  | PersistedSearchUnavailable;

export interface PersistedSearchPage {
  offset?: number;
  limit?: number;
  /** Current live records whose persisted copies must not affect filters, counts, or pages. */
  excludeProjectIds?: readonly string[];
  /** Allow one persisted merge window bounded by the current excluded live universe. */
  allowLiveMergeWindow?: boolean;
}

function normalizedPage(page: PersistedSearchPage | undefined): { offset: number; limit: number } {
  const requestedOffset = Number(page?.offset ?? 0);
  const requestedLimit = Number(page?.limit ?? DEFAULT_SEARCH_PAGE_SIZE);
  const liveMergeAllowance = page?.allowLiveMergeWindow
    ? new Set(page.excludeProjectIds ?? []).size
    : 0;
  const maximumLimit = MAX_SEARCH_PAGE_SIZE + liveMergeAllowance;
  return {
    offset: Number.isFinite(requestedOffset)
      ? Math.max(0, Math.trunc(requestedOffset))
      : 0,
    limit: Number.isFinite(requestedLimit)
      ? Math.min(maximumLimit, Math.max(1, Math.trunc(requestedLimit)))
      : DEFAULT_SEARCH_PAGE_SIZE,
  };
}

function normalizeFtsTerm(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
}

function quoteFtsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

const SQL_TEXT_PUNCTUATION = [
  ...Array.from("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"),
  "–",
  "—",
  "‘",
  "’",
  "“",
  "”",
];

/** Mirror the live search's punctuation and whitespace normalization in SQLite. */
function normalizedSqlText(expression: string): string {
  let sql = `lower(${expression})`;
  for (const punctuation of SQL_TEXT_PUNCTUATION) {
    sql = `replace(${sql}, '${punctuation.replaceAll("'", "''")}', ' ')`;
  }
  for (const whitespaceCode of [9, 10, 13]) {
    sql = `replace(${sql}, char(${whitespaceCode}), ' ')`;
  }
  // SQLite has no built-in regex replacement. Repeated passes cover the
  // bounded public-record fields while preserving parameterized user input.
  for (let pass = 0; pass < 8; pass += 1) {
    sql = `replace(${sql}, '  ', ' ')`;
  }
  return `trim(${sql})`;
}

/** Compile user terms to an FTS5 expression containing only quoted literals. */
export function compileFtsQuery(
  keywords: readonly string[],
  match: ProjectSearchOptions["match"],
): string | null {
  const terms = Array.from(new Set(keywords.map(normalizeFtsTerm).filter(Boolean))).slice(0, 20);
  if (terms.length === 0) return null;
  if (match === "phrase") return quoteFtsPhrase(terms.join(" "));
  return terms.map(quoteFtsPhrase).join(match === "any" ? " OR " : " AND ");
}

const BID_READY_DOCUMENT_TYPES_SQL =
  "'plan', 'plans', 'drawing', 'drawings', 'spec', 'specification', 'specifications', 'addendum', 'cad'";

function officialSourceDocumentLinkSql(alias: string): string {
  return [
    alias + ".uploaded_by IS NULL",
    alias + ".ingestion_method = 'source-link'",
    alias + ".visibility <> 'private'",
    alias + ".access_mode IN ('public', 'free-account')",
    "lower(" + alias + ".source_url) LIKE 'https://%'",
    "EXISTS (" +
      "SELECT 1 FROM project_sources official_document_ps " +
      "JOIN sources official_document_s ON official_document_s.id = official_document_ps.source_id " +
      "WHERE official_document_ps.project_id = " + alias + ".project_id " +
      "AND official_document_ps.source_id = " + alias + ".source_id " +
      "AND official_document_s.source_class = 'procurement'" +
    ")",
  ].join(" AND ");
}

const SEARCHABLE_OFFICIAL_DOCUMENT_LINK_SQL =
  officialSourceDocumentLinkSql("d");

export function projectFilterSql(
  options: ProjectSearchOptions,
  referenceTime = new Date(),
): {
  sql: string;
  bindings: SqlBinding[];
} {
  const clauses: string[] = [];
  const bindings: SqlBinding[] = [];
  if (options.readiness === "bid-ready") {
    const todayWindow = bidDueWindow(
      "today",
      referenceTime,
      DEFAULT_BID_DATE_TIME_ZONE,
    );
    if (!todayWindow) throw new Error("Unable to resolve bid-ready date window.");
    const readinessSourceZones = sourceBidDateTimeZones();
    const readinessDateOnlyClauses = readinessSourceZones.map(
      () => `(
        EXISTS (
          SELECT 1 FROM project_sources bid_ready_deadline_ps
           WHERE bid_ready_deadline_ps.project_id = p.id
             AND bid_ready_deadline_ps.source_id = ?
        )
        AND date(p.bid_date) >= date(?)
      )`,
    );
    const readinessSourceExclusion = readinessSourceZones.length > 0
      ? `NOT EXISTS (
          SELECT 1 FROM project_sources bid_ready_deadline_default_ps
           WHERE bid_ready_deadline_default_ps.project_id = p.id
             AND bid_ready_deadline_default_ps.source_id IN (${readinessSourceZones.map(() => "?").join(", ")})
        )`
      : "1 = 1";
    clauses.push(
      "(" +
        "p.stage = 'bidding' " +
        "AND trim(coalesce(p.title, '')) <> '' " +
        "AND trim(coalesce(p.summary, '')) <> '' " +
        "AND trim(coalesce(p.agency, '')) <> '' " +
        "AND (trim(coalesce(p.address, '')) <> '' " +
          "OR trim(coalesce(p.city, '')) <> '' " +
          "OR trim(coalesce(p.county, '')) <> '' " +
          "OR trim(coalesce(p.state, '')) <> '') " +
        "AND datetime(p.bid_date) IS NOT NULL " +
        "AND (" +
          "(time(p.bid_date) = '00:00:00' AND (" +
            (readinessDateOnlyClauses.length > 0
              ? readinessDateOnlyClauses.join(" OR ") + " OR "
              : "") +
            "(" + readinessSourceExclusion + " AND date(p.bid_date) >= date(?))" +
          ")) " +
          "OR " +
          "(time(p.bid_date) <> '00:00:00' AND datetime(p.bid_date) >= datetime(?))" +
        ") " +
        "AND EXISTS (" +
          "SELECT 1 FROM project_sources bid_ready_ps " +
          "JOIN sources bid_ready_s ON bid_ready_s.id = bid_ready_ps.source_id " +
          "WHERE bid_ready_ps.project_id = p.id " +
            "AND lower(coalesce(bid_ready_ps.confidence, '')) = 'official' " +
            "AND lower(bid_ready_ps.source_url) LIKE 'https://%' " +
            "AND bid_ready_s.source_class = 'procurement'" +
        ") " +
        "AND EXISTS (" +
          "SELECT 1 FROM documents bid_ready_d " +
          "WHERE bid_ready_d.project_id = p.id " +
            "AND lower(replace(replace(bid_ready_d.document_type, '_', '-'), ' ', '-')) " +
              "IN (" + BID_READY_DOCUMENT_TYPES_SQL + ") " +
            "AND (" + officialSourceDocumentLinkSql("bid_ready_d") + ")" +
        ")" +
      ")",
    );
    for (const [sourceId, timeZone] of readinessSourceZones) {
      bindings.push(sourceId, calendarDateInTimeZone(referenceTime, timeZone));
    }
    bindings.push(...readinessSourceZones.map(([sourceId]) => sourceId));
    bindings.push(
      calendarDateInTimeZone(referenceTime, DEFAULT_BID_DATE_TIME_ZONE),
      referenceTime.toISOString(),
    );
  }
  if (!options.includeArchived) {
    // Archive only canonical terminal lifecycle stages. Bid dates, bid opening,
    // awards, and construction remain searchable until a source reports an
    // actual completed or cancelled stage.
    clauses.push("p.stage NOT IN ('completed', 'cancelled')");
  }
  if (options.stage && options.stage !== "all") {
    clauses.push("p.stage = ?");
    bindings.push(options.stage);
  }
  if (options.state && options.state.toLowerCase() !== "all") {
    const requestedState = normalizeStateCode(options.state);
    if (requestedState) {
      clauses.push("upper(coalesce(p.state, '')) = ?");
      bindings.push(requestedState);
    } else {
      clauses.push("0 = 1");
    }
  }
  const defaultDueWindow = bidDueWindow(
    options.due,
    referenceTime,
    DEFAULT_BID_DATE_TIME_ZONE,
  );
  if (defaultDueWindow) {
    const sourceSpecificClauses: string[] = [];
    const sourceZones = sourceBidDateTimeZones();
    for (const [sourceId, timeZone] of sourceZones) {
      const sourceWindow = bidDueWindow(options.due, referenceTime, timeZone);
      if (!sourceWindow) continue;
      const sourceStartDay = calendarDateInTimeZone(new Date(sourceWindow.start), timeZone);
      const sourceEndDay = calendarDateInTimeZone(new Date(sourceWindow.end), timeZone);
      sourceSpecificClauses.push(`(
        EXISTS (
          SELECT 1 FROM project_sources deadline_ps
           WHERE deadline_ps.project_id = p.id AND deadline_ps.source_id = ?
        )
        AND (
          (time(p.bid_date) = '00:00:00'
            AND date(p.bid_date) >= date(?)
            AND date(p.bid_date) < date(?))
          OR
          (time(p.bid_date) <> '00:00:00'
            AND datetime(p.bid_date) >= datetime(?)
            AND datetime(p.bid_date) < datetime(?))
        )
      )`);
      bindings.push(
        sourceId,
        sourceStartDay,
        sourceEndDay,
        sourceWindow.start,
        sourceWindow.end,
      );
    }
    const sourceExclusion = sourceZones.length > 0
      ? `NOT EXISTS (
          SELECT 1 FROM project_sources deadline_default_ps
           WHERE deadline_default_ps.project_id = p.id
             AND deadline_default_ps.source_id IN (${sourceZones.map(() => "?").join(", ")})
        )`
      : "1 = 1";
    bindings.push(...sourceZones.map(([sourceId]) => sourceId));
    const defaultStartDay = calendarDateInTimeZone(
      new Date(defaultDueWindow.start),
      DEFAULT_BID_DATE_TIME_ZONE,
    );
    const defaultEndDay = calendarDateInTimeZone(
      new Date(defaultDueWindow.end),
      DEFAULT_BID_DATE_TIME_ZONE,
    );
    bindings.push(
      defaultStartDay,
      defaultEndDay,
      defaultDueWindow.start,
      defaultDueWindow.end,
    );
    clauses.push(`datetime(p.bid_date) IS NOT NULL AND (
      ${sourceSpecificClauses.length > 0 ? `${sourceSpecificClauses.join(" OR ")} OR` : ""}
      (
        ${sourceExclusion}
        AND (
          (time(p.bid_date) = '00:00:00'
            AND date(p.bid_date) >= date(?)
            AND date(p.bid_date) < date(?))
          OR
          (time(p.bid_date) <> '00:00:00'
            AND datetime(p.bid_date) >= datetime(?)
            AND datetime(p.bid_date) < datetime(?))
        )
      )
    )`);
  }
  if (options.freshness && options.freshness !== "all") {
    const normalizedStatusSql = normalizedSqlText("coalesce(p.status, '')");
    const statusTokenSql = (tokens: readonly string[]) =>
      `(${tokens
        .map((token) => `instr(' ' || ${normalizedStatusSql} || ' ', ' ${token} ') > 0`)
        .join(" OR ")})`;
    const inactive = `(p.stage = 'cancelled' OR ${statusTokenSql(INACTIVE_STATUS_TOKENS)})`;
    const activePostBidStage = `(p.stage IN ('bid-opened', 'awarded'))`;
    const closedSignal = `(p.stage = 'completed' OR (NOT ${activePostBidStage} AND ${statusTokenSql(CLOSED_STATUS_TOKENS)}))`;
    const activeSignal = `(p.stage IN ('planning', 'design', 'permitting', 'bidding', 'bid-opened', 'awarded', 'construction') OR ${statusTokenSql(ACTIVE_STATUS_TOKENS)})`;
    const postedActivity = `(CASE WHEN datetime(p.posted_at) > datetime('1970-01-02T00:00:00.000Z') THEN datetime(p.posted_at) END)`;
    const updatedActivity = `(CASE WHEN datetime(p.updated_at) > datetime('1970-01-02T00:00:00.000Z') THEN datetime(p.updated_at) END)`;
    const latestActivity = `(CASE
      WHEN ${postedActivity} IS NULL THEN ${updatedActivity}
      WHEN ${updatedActivity} IS NULL THEN ${postedActivity}
      WHEN ${postedActivity} > ${updatedActivity} THEN ${postedActivity}
      ELSE ${updatedActivity}
    END)`;
    const now = Date.now();
    const sqlDate = (timestamp: number) => new Date(timestamp).toISOString().replace(/'/g, "''");
    const newSince = sqlDate(now - NEW_ACTIVITY_DAYS * 86_400_000);
    const allowedFuture = sqlDate(now + 2 * 86_400_000);
    const staleBefore = sqlDate(now - STALE_ACTIVITY_DAYS * 86_400_000);
    const passedBidBefore = sqlDate(now - PASSED_BID_GRACE_DAYS * 86_400_000);
    const referenceDate = sqlDate(now);
    const terminalGuard = `(NOT ${inactive} AND NOT ${closedSignal})`;
    const passedBidSignal = `(p.stage = 'bidding' AND datetime(p.bid_date) IS NOT NULL AND datetime(p.bid_date) < datetime('${passedBidBefore}'))`;
    const futureBidSignal = `(datetime(p.bid_date) IS NOT NULL AND datetime(p.bid_date) >= datetime('${referenceDate}'))`;
    const newSignal = `(${terminalGuard} AND ${activeSignal} AND NOT ${passedBidSignal} AND ${latestActivity} IS NOT NULL AND ${latestActivity} >= datetime('${newSince}') AND ${latestActivity} <= datetime('${allowedFuture}'))`;
    const staleSignal = `(${terminalGuard} AND ${activeSignal} AND (${passedBidSignal} OR (NOT ${newSignal} AND NOT ${futureBidSignal} AND ${latestActivity} IS NOT NULL AND ${latestActivity} < datetime('${staleBefore}'))))`;
    const currentSignal = `(${terminalGuard} AND ${activeSignal} AND (${futureBidSignal} OR ${latestActivity} IS NOT NULL) AND NOT ${newSignal} AND NOT ${staleSignal})`;
    const unclassifiedSignal = `(${terminalGuard} AND NOT ${newSignal} AND NOT ${staleSignal} AND NOT ${currentSignal})`;

    if (options.freshness === "inactive") clauses.push(inactive);
    else if (options.freshness === "closed") clauses.push(`(NOT ${inactive} AND ${closedSignal})`);
    else if (options.freshness === "closed-or-inactive") clauses.push(`(${inactive} OR ${closedSignal})`);
    else if (options.freshness === "actionable") clauses.push(`(${newSignal} OR ${currentSignal})`);
    else if (options.freshness === "new") clauses.push(newSignal);
    else if (options.freshness === "stale") clauses.push(staleSignal);
    else if (options.freshness === "current") clauses.push(currentSignal);
    else clauses.push(unclassifiedSignal);
  }
  const location = normalizeLocationQuery(options.location ?? "").slice(0, 160).trim();
  if (location) {
    const normalizedLocationSql = normalizedSqlText(
      "coalesce(p.address, '') || ' ' || coalesce(p.city, '') || ' ' || coalesce(p.county, '') || ' ' || coalesce(p.state, '') || ' ' || coalesce(p.postal_code, '')",
    );
    const locationTokens = location.split(" ").filter(Boolean).slice(0, 20);
    clauses.push(
      locationTokens
        .map(() => `instr(' ' || ${normalizedLocationSql} || ' ', ' ' || ? || ' ') > 0`)
        .join(" AND "),
    );
    bindings.push(...locationTokens);
  }
  return { sql: clauses.length > 0 ? clauses.join(" AND ") : "1 = 1", bindings };
}

function projectSearchOrderSql(): string {
  return [
    `CASE p.stage
      WHEN 'bidding' THEN 0
      WHEN 'bid-opened' THEN 1
      WHEN 'design' THEN 2
      WHEN 'planning' THEN 3
      WHEN 'permitting' THEN 4
      WHEN 'awarded' THEN 5
      WHEN 'construction' THEN 6
      WHEN 'completed' THEN 7
      WHEN 'cancelled' THEN 8
      ELSE 9
    END`,
    "CASE WHEN p.stage = 'bidding' AND datetime(p.bid_date) IS NOT NULL THEN 0 WHEN p.stage = 'bidding' THEN 1 ELSE 0 END",
    "CASE WHEN p.stage = 'bidding' THEN datetime(p.bid_date) END ASC",
    "p.updated_at DESC",
    "p.id",
  ].join(", ");
}

function placeholders(length: number): string {
  return Array.from({ length }, () => "?").join(", ");
}

function chunks<T>(values: readonly T[], size = SQL_BIND_CHUNK): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

const NAVIGABLE_PROJECT_SQL = `
  p.stage IN ('planning', 'design', 'permitting', 'bidding', 'bid-opened', 'awarded', 'construction', 'completed', 'cancelled', 'unclassified')
  AND EXISTS (
    SELECT 1 FROM project_sources navigable_ps WHERE navigable_ps.project_id = p.id
  )
`;

const PUBLIC_DOCUMENT_RIGHTS_SQL = `
  d.visibility = 'public'
  AND d.access_mode = 'public'
  AND trim(coalesce(d.license_code, '')) <> ''
  AND d.redistribution_allowed = 1
`;

function groupedCounts(rows: readonly GroupedCountRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = String(row.key ?? "").trim();
    if (key) counts[key] = countValue({ count: row.count });
  }
  return counts;
}

function groupedStateCounts(rows: readonly GroupedCountRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const code = normalizeStateCode(String(row.key ?? ""));
    if (code) counts[code] = (counts[code] ?? 0) + countValue({ count: row.count });
  }
  return counts;
}

function countValue(row: CountRow | undefined): number {
  const value = Number(row?.count ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

async function all<T>(
  db: D1DatabaseLike,
  sql: string,
  bindings: readonly SqlBinding[] = [],
): Promise<T[]> {
  const result = await db.prepare(sql).bind(...bindings).all<T>();
  return result.results ?? [];
}

async function getD1Binding(): Promise<D1DatabaseLike | null> {
  try {
    const database = await getDb();
    return database.$client as unknown as D1DatabaseLike;
  } catch {
    // Node-based builds and route tests intentionally do not provide Worker bindings.
    return null;
  }
}

async function existingNavigableProjects(
  db: D1DatabaseLike,
  candidateIds: readonly string[],
): Promise<ExistingProjectRow[]> {
  const found = new Map<string, ExistingProjectRow>();
  for (const group of chunks(Array.from(new Set(candidateIds.filter(Boolean))))) {
    if (group.length === 0) continue;
    const rows = await all<ExistingProjectRow>(
      db,
      `SELECT p.id AS project_id, p.stage, p.state
         FROM projects p
        WHERE ${NAVIGABLE_PROJECT_SQL}
          AND p.id IN (${placeholders(group.length)})`,
      group,
    );
    for (const row of rows) found.set(row.project_id, row);
  }
  return Array.from(found.values());
}

async function existingContractorOrganizationKeys(
  db: D1DatabaseLike,
  candidateKeys: readonly string[],
): Promise<string[]> {
  const found = new Set<string>();
  for (const group of chunks(Array.from(new Set(candidateKeys.filter(Boolean))))) {
    if (group.length === 0) continue;
    const rows = await all<{ key: string }>(
      db,
      `SELECT DISTINCT organizations.normalized_name AS key
         FROM organizations
         JOIN project_participants
           ON project_participants.organization_id=organizations.id
         JOIN projects p ON p.id=project_participants.project_id
        WHERE project_participants.role IN ('contractor', 'bidder')
          AND ${NAVIGABLE_PROJECT_SQL}
          AND organizations.normalized_name IN (${placeholders(group.length)})`,
      group,
    );
    for (const row of rows) found.add(row.key);
  }
  return Array.from(found);
}

async function indexedDocumentCandidateIds(
  db: D1DatabaseLike,
  candidateIds: readonly string[],
): Promise<string[]> {
  const found = new Set<string>();
  for (const group of chunks(Array.from(new Set(candidateIds.filter(Boolean))))) {
    if (group.length === 0) continue;
    const rows = await all<ProjectIdRow>(
      db,
      `SELECT DISTINCT d.project_id
         FROM document_chunk_fts
         JOIN document_versions dv ON dv.id = document_chunk_fts.document_version_id
         JOIN documents d ON d.id = dv.document_id
        WHERE ${PUBLIC_DOCUMENT_RIGHTS_SQL}
          AND d.project_id IN (${placeholders(group.length)})`,
      group,
    );
    for (const row of rows) found.add(row.project_id);
  }
  return Array.from(found);
}

async function matchingDocumentCandidateIds(
  db: D1DatabaseLike,
  candidateIds: readonly string[],
  ftsQuery: string | null,
): Promise<string[]> {
  if (!ftsQuery) return [];
  const found = new Set<string>();
  for (const group of chunks(Array.from(new Set(candidateIds.filter(Boolean))))) {
    if (group.length === 0) continue;
    const rows = await all<ProjectIdRow>(
      db,
      `SELECT DISTINCT d.project_id
         FROM document_chunk_fts
         JOIN document_versions dv ON dv.id = document_chunk_fts.document_version_id
         JOIN documents d ON d.id = dv.document_id
        WHERE document_chunk_fts MATCH ?
          AND ${PUBLIC_DOCUMENT_RIGHTS_SQL}
          AND d.project_id IN (${placeholders(group.length)})`,
      [ftsQuery, ...group],
    );
    for (const row of rows) found.add(row.project_id);
  }
  return Array.from(found);
}

function projectDocumentKind(value: string): ProjectDocument["kind"] {
  const normalized = value.toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "agenda") return "agenda";
  if (normalized === "permit") return "permit";
  if (normalized === "plan" || normalized === "plans" || normalized === "drawing") return "plans";
  if (normalized === "spec" || normalized === "specification" || normalized === "specifications") {
    return "specifications";
  }
  if (normalized === "addendum") return "addendum";
  if (normalized === "bid-tab" || normalized === "bid-tabulation") return "bid-tab";
  if (normalized === "award" || normalized === "contract-award") return "award";
  return "source-record";
}

function participantRole(value: string): ProjectParticipant["role"] | null {
  const normalized = value.toLowerCase();
  if (
    normalized === "owner" ||
    normalized === "agency" ||
    normalized === "architect" ||
    normalized === "engineer" ||
    normalized === "bidder" ||
    normalized === "plan-holder" ||
    normalized === "contractor"
  ) {
    return normalized;
  }
  return null;
}

function participantType(value: string | null): ProjectParticipant["participantType"] {
  return value === "person" || value === "organization" ? value : undefined;
}

function participantValue(value: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function participantMergeKey(participant: ProjectParticipant): string {
  return `${participant.role}:${participant.name
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim()}`;
}

function mergeParticipant(
  participantsByProject: Map<string, ProjectParticipant[]>,
  projectId: string,
  incoming: ProjectParticipant,
): void {
  const list = participantsByProject.get(projectId) ?? [];
  const key = participantMergeKey(incoming);
  const existingIndex = list.findIndex((participant) => participantMergeKey(participant) === key);
  if (existingIndex < 0) {
    list.push(incoming);
    participantsByProject.set(projectId, list);
    return;
  }

  const existing = list[existingIndex];
  const type = incoming.participantType === "person"
    ? "person"
    : existing.participantType ?? incoming.participantType;
  const organization = incoming.participantType === "person"
    ? incoming.organization
    : incoming.organization ?? existing.organization;
  list[existingIndex] = {
    name: incoming.participantType === "person" ? incoming.name : existing.name,
    role: existing.role,
    ...(type ? { participantType: type } : {}),
    ...(organization ? { organization } : {}),
    ...(incoming.email ?? existing.email ? { email: incoming.email ?? existing.email } : {}),
    ...(incoming.phone ?? existing.phone ? { phone: incoming.phone ?? existing.phone } : {}),
    ...(incoming.sourceUrl ?? existing.sourceUrl
      ? { sourceUrl: incoming.sourceUrl ?? existing.sourceUrl }
      : {}),
  };
  participantsByProject.set(projectId, list);
}

function projectStage(value: string): ProjectStage | null {
  if (
    value === "planning" ||
    value === "design" ||
    value === "permitting" ||
    value === "bidding" ||
    value === "bid-opened" ||
    value === "awarded" ||
    value === "construction" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "unclassified"
  ) {
    return value;
  }
  return null;
}

function sourceProvenance(connector: string | null): ProjectRecord["provenance"] {
  return /api|socrata|arcgis|legistar|sam|usaspending/i.test(connector ?? "")
    ? "live-api"
    : "live-public-page";
}

async function hydrateProjects(
  db: D1DatabaseLike,
  orderedIds: readonly string[],
  documentMatchIds: ReadonlySet<string>,
): Promise<ProjectRecord[]> {
  if (orderedIds.length === 0) return [];
  const projectRows: PersistedProjectRow[] = [];
  const documentRows: PersistedDocumentRow[] = [];
  const participantRows: PersistedParticipantRow[] = [];
  const projectContactRows: PersistedProjectContactRow[] = [];

  for (const group of chunks(orderedIds)) {
    const binds = group as SqlBinding[];
    const ids = placeholders(group.length);
    const [projects, documents, participants, projectContacts] = await Promise.all([
      all<PersistedProjectRow>(
        db,
        `SELECT p.id, p.title, p.summary, p.stage, p.status, p.agency,
                p.address, p.city, p.county, p.state, p.postal_code,
                p.estimated_value, p.posted_at, p.bid_date, p.updated_at,
                ps.source_id, ps.source_record_id, ps.source_url AS project_source_url,
                ps.confidence, s.name AS source_name, s.source_url AS registry_source_url,
                s.connector
           FROM projects p
           LEFT JOIN project_sources ps ON ps.id = (
             SELECT ps2.id FROM project_sources ps2
              WHERE ps2.project_id = p.id
              ORDER BY ps2.last_seen_at DESC, ps2.id ASC LIMIT 1
           )
           LEFT JOIN sources s ON s.id = ps.source_id
          WHERE p.id IN (${ids})`,
        binds,
      ),
      all<PersistedDocumentRow>(
        db,
        `SELECT d.project_id, d.name, d.document_type, d.source_url, d.access_mode,
                CASE WHEN EXISTS (
                  SELECT 1 FROM document_versions dv
                  JOIN document_extractions de ON de.document_version_id = dv.id
                  WHERE dv.document_id = d.id
                    AND de.status = 'complete'
                    AND de.indexed_at IS NOT NULL
                ) THEN 1 ELSE 0 END AS text_indexed
           FROM documents d
          WHERE d.project_id IN (${ids})
            AND (
              ${PUBLIC_DOCUMENT_RIGHTS_SQL}
              OR ${SEARCHABLE_OFFICIAL_DOCUMENT_LINK_SQL}
            )
          ORDER BY d.project_id, d.published_at DESC, d.name`,
        binds,
      ),
      all<PersistedParticipantRow>(
        db,
        `SELECT pp.project_id, o.display_name, pp.role
           FROM project_participants pp
           JOIN organizations o ON o.id = pp.organization_id
          WHERE pp.project_id IN (${ids})
          ORDER BY pp.project_id, pp.role, o.display_name`,
        binds,
      ),
      all<PersistedProjectContactRow>(
        db,
        `SELECT pc.project_id,
                COALESCE(
                  CASE WHEN json_valid(pc.provenance) THEN
                    CAST(json_extract(pc.provenance, '$.displayName') AS TEXT)
                  END,
                  c.display_name
                ) AS display_name,
                pc.role,
                COALESCE(
                  CASE WHEN json_valid(pc.provenance) THEN
                    CAST(json_extract(pc.provenance, '$.participantType') AS TEXT)
                  END,
                  c.contact_type
                ) AS participant_type,
                COALESCE(
                  CASE WHEN json_valid(pc.provenance) THEN
                    CAST(json_extract(pc.provenance, '$.organization') AS TEXT)
                  END,
                  o.display_name
                ) AS organization_name,
                CASE WHEN json_valid(pc.provenance) THEN
                  CAST(json_extract(pc.provenance, '$.email') AS TEXT)
                END AS email,
                CASE WHEN json_valid(pc.provenance) THEN
                  CAST(json_extract(pc.provenance, '$.phone') AS TEXT)
                END AS phone,
                COALESCE(
                  pc.source_url,
                  CASE WHEN json_valid(pc.provenance) THEN
                    CAST(json_extract(pc.provenance, '$.sourceUrl') AS TEXT)
                  END
                ) AS source_url
           FROM project_contacts pc
           JOIN contacts c ON c.id = pc.contact_id
           LEFT JOIN organizations o ON o.id = COALESCE(pc.organization_id, c.organization_id)
          WHERE pc.project_id IN (${ids})
            AND pc.relationship_status = 'observed'
            AND pc.verification_status = 'source-reported'
            AND CASE WHEN json_valid(pc.provenance) THEN
                  CAST(json_extract(pc.provenance, '$.acquisitionMethod') AS TEXT)
                END = 'configured-connector'
          ORDER BY pc.project_id, pc.role, display_name`,
        binds,
      ),
    ]);
    projectRows.push(...projects);
    documentRows.push(...documents);
    participantRows.push(...participants);
    projectContactRows.push(...projectContacts);
  }

  const documentsByProject = new Map<string, ProjectDocument[]>();
  const textIndexedProjects = new Set<string>(documentMatchIds);
  for (const row of documentRows) {
    const accountGated = /account|login|credential/i.test(row.access_mode);
    const document: ProjectDocument = {
      name: row.name,
      kind: projectDocumentKind(row.document_type),
      url: row.source_url,
      access: accountGated ? "free-account" : "public",
      indexStatus: row.text_indexed
        ? "text-indexed"
        : accountGated
          ? "account-gated"
          : "metadata-only",
    };
    if (row.text_indexed) textIndexedProjects.add(row.project_id);
    const list = documentsByProject.get(row.project_id) ?? [];
    list.push(document);
    documentsByProject.set(row.project_id, list);
  }

  const participantsByProject = new Map<string, ProjectParticipant[]>();
  for (const row of participantRows) {
    const role = participantRole(row.role);
    if (!role) continue;
    mergeParticipant(participantsByProject, row.project_id, {
      name: row.display_name,
      role,
      participantType: "organization",
      organization: row.display_name,
    });
  }
  for (const row of projectContactRows) {
    const role = participantRole(row.role);
    const name = participantValue(row.display_name);
    if (!role || !name) continue;
    const type = participantType(row.participant_type);
    const organization = participantValue(row.organization_name);
    const email = participantValue(row.email);
    const phone = participantValue(row.phone);
    const sourceUrl = participantValue(row.source_url);
    mergeParticipant(participantsByProject, row.project_id, {
      name,
      role,
      ...(type ? { participantType: type } : {}),
      ...(organization ? { organization } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
    });
  }

  const byId = new Map<string, ProjectRecord>();
  for (const row of projectRows) {
    const stage = projectStage(row.stage);
    if (!stage) continue;
    const sourceUrl = row.project_source_url ?? row.registry_source_url;
    if (!row.source_id || !row.source_record_id || !sourceUrl) continue;
    const bidDateTimeZone = bidDateTimeZoneForSource(row.source_id);
    byId.set(row.id, {
      id: row.id,
      sourceId: row.source_id,
      sourceRecordId: row.source_record_id,
      title: row.title,
      summary: row.summary,
      stage,
      status: row.status,
      agency: row.agency,
      address: row.address ?? undefined,
      city: row.city ?? undefined,
      county: row.county ?? undefined,
      state: row.state ?? undefined,
      postalCode: row.postal_code ?? undefined,
      value: row.estimated_value ?? undefined,
      postedAt: row.posted_at ?? undefined,
      bidDate: row.bid_date ?? undefined,
      ...(row.bid_date && bidDateTimeZone
        ? { bidDateTimeZone }
        : {}),
      updatedAt: row.updated_at,
      sourceName: row.source_name ?? row.agency,
      sourceUrl,
      provenance: sourceProvenance(row.connector),
      confidence: row.confidence === "official" ? "official" : "inferred",
      documents: documentsByProject.get(row.id) ?? [],
      participants: participantsByProject.get(row.id) ?? [],
      documentTextIndexed: textIndexedProjects.has(row.id),
    });
  }
  return orderedIds.flatMap((id) => {
    const project = byId.get(id);
    return project ? [project] : [];
  });
}

export async function searchPersistedProjects(
  options: ProjectSearchOptions,
  candidateIds: readonly string[] = [],
  page?: PersistedSearchPage,
  providedDb?: D1DatabaseLike,
): Promise<PersistedSearchResult> {
  const db = providedDb ?? await getD1Binding();
  if (!db) return { available: false, reason: "binding-unavailable" };

  try {
    const { offset, limit } = normalizedPage(page);
    const baseFilter = projectFilterSql(options);
    const excludedProjectIds = Array.from(
      new Set((page?.excludeProjectIds ?? []).map((id) => id.trim()).filter(Boolean)),
    );
    const filter = excludedProjectIds.length
      ? {
          sql: `(${baseFilter.sql}) AND p.id NOT IN (
            SELECT CAST(value AS TEXT) FROM json_each(?)
          )`,
          bindings: [...baseFilter.bindings, JSON.stringify(excludedProjectIds)],
        }
      : baseFilter;
    const ftsQuery = compileFtsQuery(options.keywords, options.match);
    const metadataCountPromise = all<CountRow>(
      db,
      `SELECT count(DISTINCT project_fts.project_id) AS count
         FROM project_fts JOIN projects p ON p.id = project_fts.project_id
        WHERE ${filter.sql} AND ${NAVIGABLE_PROJECT_SQL}`,
      filter.bindings,
    );
    const documentCountPromise = all<CountRow>(
      db,
      `SELECT count(DISTINCT d.project_id) AS count
         FROM document_chunk_fts
         JOIN document_versions dv ON dv.id = document_chunk_fts.document_version_id
         JOIN documents d ON d.id = dv.document_id
         JOIN projects p ON p.id = d.project_id
        WHERE ${PUBLIC_DOCUMENT_RIGHTS_SQL}
          AND ${filter.sql} AND ${NAVIGABLE_PROJECT_SQL}`,
      filter.bindings,
    );

    let orderedIds: string[];
    let documentIds: string[] = [];
    let matchedProjectCount: number;

    if (ftsQuery) {
      const [projectRows, matchedRows] = await Promise.all([
        all<ProjectIdRow>(
          db,
          `WITH match_rows AS (
             SELECT project_fts.project_id, 0 AS source_rank
               FROM project_fts JOIN projects p ON p.id = project_fts.project_id
              WHERE project_fts MATCH ? AND ${filter.sql} AND ${NAVIGABLE_PROJECT_SQL}
             UNION ALL
             SELECT d.project_id, 1 AS source_rank
               FROM document_chunk_fts
               JOIN document_versions dv ON dv.id = document_chunk_fts.document_version_id
               JOIN documents d ON d.id = dv.document_id
               JOIN projects p ON p.id = d.project_id
              WHERE document_chunk_fts MATCH ?
                AND ${PUBLIC_DOCUMENT_RIGHTS_SQL}
                AND ${filter.sql} AND ${NAVIGABLE_PROJECT_SQL}
           ), ranked AS (
             SELECT project_id, min(source_rank) AS source_rank
               FROM match_rows
              GROUP BY project_id
           )
           SELECT ranked.project_id
             FROM ranked JOIN projects p ON p.id = ranked.project_id
            ORDER BY ${projectSearchOrderSql()}
            LIMIT ? OFFSET ?`,
          [ftsQuery, ...filter.bindings, ftsQuery, ...filter.bindings, limit, offset],
        ),
        all<CountRow>(
          db,
          `SELECT count(*) AS count FROM (
             SELECT project_fts.project_id
               FROM project_fts JOIN projects p ON p.id = project_fts.project_id
              WHERE project_fts MATCH ? AND ${filter.sql} AND ${NAVIGABLE_PROJECT_SQL}
             UNION
             SELECT d.project_id
               FROM document_chunk_fts
               JOIN document_versions dv ON dv.id = document_chunk_fts.document_version_id
               JOIN documents d ON d.id = dv.document_id
               JOIN projects p ON p.id = d.project_id
              WHERE document_chunk_fts MATCH ?
                AND ${PUBLIC_DOCUMENT_RIGHTS_SQL}
                AND ${filter.sql} AND ${NAVIGABLE_PROJECT_SQL}
           )`,
          [ftsQuery, ...filter.bindings, ftsQuery, ...filter.bindings],
        ),
      ]);
      orderedIds = projectRows.map((row) => row.project_id);
      matchedProjectCount = countValue(matchedRows[0]);
      if (orderedIds.length > 0) {
        const rows = await all<ProjectIdRow>(
          db,
          `SELECT DISTINCT d.project_id
             FROM document_chunk_fts
             JOIN document_versions dv ON dv.id = document_chunk_fts.document_version_id
             JOIN documents d ON d.id = dv.document_id
            WHERE document_chunk_fts MATCH ?
              AND ${PUBLIC_DOCUMENT_RIGHTS_SQL}
              AND d.project_id IN (${placeholders(orderedIds.length)})`,
          [ftsQuery, ...orderedIds],
        );
        documentIds = rows.map((row) => row.project_id);
      }
    } else {
      const [projectRows, matchedRows] = await Promise.all([
        all<ProjectIdRow>(
          db,
          `SELECT p.id AS project_id FROM projects p
            WHERE ${filter.sql} AND ${NAVIGABLE_PROJECT_SQL}
            ORDER BY ${projectSearchOrderSql()}
            LIMIT ? OFFSET ?`,
          [...filter.bindings, limit, offset],
        ),
        all<CountRow>(
          db,
          `SELECT count(*) AS count
             FROM projects p
            WHERE ${filter.sql} AND ${NAVIGABLE_PROJECT_SQL}`,
          filter.bindings,
        ),
      ]);
      orderedIds = projectRows.map((row) => row.project_id);
      matchedProjectCount = countValue(matchedRows[0]);
    }

    const [
      metadataCountRows,
      documentCountRows,
      documentIndexedCandidateIds,
      documentMatchedCandidateIds,
      projects,
    ] = await Promise.all([
      metadataCountPromise,
      documentCountPromise,
      indexedDocumentCandidateIds(db, candidateIds),
      matchingDocumentCandidateIds(db, candidateIds, ftsQuery),
      hydrateProjects(db, orderedIds, new Set(documentIds)),
    ]);

    return {
      available: true,
      projects,
      matchedProjectCount,
      eligibleMetadataProjects: countValue(metadataCountRows[0]),
      eligibleDocumentTextProjects: countValue(documentCountRows[0]),
      documentIndexedCandidateIds,
      documentMatchedCandidateIds,
      resultLimitReached: false,
      offset,
      limit,
    };
  } catch (error) {
    return {
      available: false,
      reason: "query-failed",
      error: error instanceof Error ? error.message : "Unknown D1 search error",
    };
  }
}

export async function getPersistedInventorySnapshot(
  liveCandidateIds: readonly string[] = [],
  liveContractorOrganizationKeys: readonly string[] = [],
): Promise<PersistedInventoryResult> {
  const db = await getD1Binding();
  if (!db) return { available: false, reason: "binding-unavailable" };

  try {
    const [
      inventoryRows,
      stateRows,
      sourceRows,
      indexedDocumentRows,
      contractorRows,
      jurisdictionRows,
      existingCandidates,
      existingContractorKeys,
    ] = await Promise.all([
      all<InventoryRow>(
        db,
        `SELECT count(*) AS total_projects,
                coalesce(sum(CASE WHEN p.stage='planning' THEN 1 ELSE 0 END), 0) AS planning_projects,
                coalesce(sum(CASE WHEN p.stage='design' THEN 1 ELSE 0 END), 0) AS design_projects,
                coalesce(sum(CASE WHEN p.stage='permitting' THEN 1 ELSE 0 END), 0) AS permitting_projects,
                coalesce(sum(CASE WHEN p.stage='bidding' THEN 1 ELSE 0 END), 0) AS bidding_projects,
                coalesce(sum(CASE WHEN p.stage='bid-opened' THEN 1 ELSE 0 END), 0) AS bid_opened_projects,
                coalesce(sum(CASE WHEN p.stage='awarded' THEN 1 ELSE 0 END), 0) AS awarded_projects,
                coalesce(sum(CASE WHEN p.stage='construction' THEN 1 ELSE 0 END), 0) AS construction_projects,
                coalesce(sum(CASE WHEN p.stage='completed' THEN 1 ELSE 0 END), 0) AS completed_projects,
                coalesce(sum(CASE WHEN p.stage='cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_projects,
                coalesce(sum(CASE WHEN p.stage='unclassified' THEN 1 ELSE 0 END), 0) AS unclassified_projects,
                max(p.last_seen_at) AS refreshed_at
           FROM projects p
          WHERE ${NAVIGABLE_PROJECT_SQL}`,
      ),
      all<GroupedCountRow>(
        db,
        `SELECT trim(p.state) AS key, count(*) AS count
           FROM projects p
          WHERE ${NAVIGABLE_PROJECT_SQL}
            AND trim(coalesce(p.state, '')) <> ''
          GROUP BY lower(trim(p.state))`,
      ),
      all<GroupedCountRow>(
        db,
        `SELECT ps.source_id AS key, count(DISTINCT ps.project_id) AS count
           FROM project_sources ps
           JOIN projects p ON p.id = ps.project_id
          WHERE ${NAVIGABLE_PROJECT_SQL}
          GROUP BY ps.source_id`,
      ),
      all<CountRow>(
        db,
        `SELECT count(DISTINCT d.project_id) AS count
           FROM document_chunk_fts dfts
           JOIN document_versions dv ON dv.id = dfts.document_version_id
           JOIN documents d ON d.id = dv.document_id
           JOIN projects p ON p.id = d.project_id
          WHERE ${PUBLIC_DOCUMENT_RIGHTS_SQL}
            AND ${NAVIGABLE_PROJECT_SQL}`,
      ),
      all<CountRow>(
        db,
        `SELECT count(DISTINCT pp.organization_id) AS count
           FROM project_participants pp
           JOIN projects p ON p.id = pp.project_id
          WHERE ${NAVIGABLE_PROJECT_SQL}
            AND pp.role IN ('contractor', 'bidder')`,
      ),
      all<CountRow>(db, "SELECT count(*) AS count FROM jurisdictions WHERE active=1"),
      existingNavigableProjects(db, liveCandidateIds),
      existingContractorOrganizationKeys(db, liveContractorOrganizationKeys),
    ]);
    const row = inventoryRows[0];
    const value = (entry: number | string | null | undefined): number =>
      countValue({ count: entry ?? 0 });

    const normalizedExistingCandidates = existingCandidates.flatMap((candidate) => {
      const stage = projectStage(candidate.stage);
      return stage
        ? [{
            id: candidate.project_id,
            stage,
            ...(candidate.state?.trim() ? { state: candidate.state.trim() } : {}),
          }]
        : [];
    });

    return {
      available: true,
      totalProjects: value(row?.total_projects),
      stageCounts: {
        planning: value(row?.planning_projects),
        design: value(row?.design_projects),
        permitting: value(row?.permitting_projects),
        bidding: value(row?.bidding_projects),
        "bid-opened": value(row?.bid_opened_projects),
        awarded: value(row?.awarded_projects),
        construction: value(row?.construction_projects),
        completed: value(row?.completed_projects),
        cancelled: value(row?.cancelled_projects),
        unclassified: value(row?.unclassified_projects),
      },
      stateCounts: groupedStateCounts(stateRows),
      sourceCounts: groupedCounts(sourceRows),
      documentTextIndexedProjects: countValue(indexedDocumentRows[0]),
      contractorOrganizations: countValue(contractorRows[0]),
      jurisdictionRows: countValue(jurisdictionRows[0]),
      refreshedAt: row?.refreshed_at ?? undefined,
      existingCandidateIds: normalizedExistingCandidates.map((candidate) => candidate.id),
      existingCandidates: normalizedExistingCandidates,
      existingContractorOrganizationKeys: existingContractorKeys,
    };
  } catch (error) {
    return {
      available: false,
      reason: "query-failed",
      error: error instanceof Error ? error.message : "Unknown D1 inventory error",
    };
  }
}

export async function getPersistedProjectById(id: string): Promise<PersistedProjectResult> {
  const normalizedId = id.trim().slice(0, 300);
  if (!normalizedId) return { available: true, project: null };
  const db = await getD1Binding();
  if (!db) return { available: false, reason: "binding-unavailable" };

  try {
    const hydrated = await hydrateProjects(db, [normalizedId], new Set());
    return { available: true, project: hydrated[0] ?? null };
  } catch (error) {
    return {
      available: false,
      reason: "query-failed",
      error: error instanceof Error ? error.message : "Unknown D1 project lookup error",
    };
  }
}
