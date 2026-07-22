import type {
  ProjectDocument,
  ProjectParticipant,
  ProjectRecord,
  SourcePageRecord,
} from "./types";
import type {
  PublicDotConnectorResult,
  PublicDotFeedOptions,
  PublicDotSourceTemplate,
} from "./public-dot-connectors";
import { sourceLocalDateTimeToIso } from "./deadline-time.ts";

export const OHIO_DOT_SOURCE_ID =
  "ohio-dot-filed-construction-projects" as const;

const OHIO_DOT_TIME_ZONE = "America/New_York" as const;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_CONCURRENCY = 3;
const VIEW_LIMIT = 20;
const INGEST_LIMIT = 50;

const OHIO_DOT_POINT_LAYER =
  "https://tims.dot.state.oh.us/ags/rest/services/Projects/All_Project_Points/MapServer/0/query";
const OHIO_DOT_LINE_LAYER =
  "https://tims.dot.state.oh.us/ags/rest/services/Projects/All_Projects_Linear/MapServer/0/query";
const OHIO_DOT_DOCUMENT_ROOT = "https://contracts.dot.state.oh.us";

const OFFICIAL_HOSTS = new Set([
  "tims.dot.state.oh.us",
  "contracts.dot.state.oh.us",
]);

const ARCGIS_FIELDS = [
  "PID_NBR",
  "PROJECT_NME",
  "COUNTY_NME",
  "COUNTY_NME_WORK_LOCATION",
  "DISTRICT_NBR",
  "PRIMARY_WORK_CATEGORY",
  "FMIS_PROJ_DESC",
  "CONTRACT_TYPE",
  "EST_TOTAL_CONSTR_COST",
  "PROJECT_MANAGER_NME",
  "PROJECT_ENGINEER_NME",
  "AREA_ENGINEER_NME",
  "ENV_PROJECT_MANAGER_NME",
  "DESIGN_AGENCY",
  "SPONSORING_AGENCY",
  "PROJECT_PLANS_URL",
  "PROJECT_ADDENDA_URL",
  "PROJECT_PROPOSAL_URL",
  "AWARD_MILESTONE_DT",
  "BEGIN_CONSTR_MILESTONE_DT",
  "SOURCE_LAST_UPDATED",
] as const;

type ArcGisAttributes = Record<string, unknown>;

interface ArcGisFeature {
  attributes?: ArcGisAttributes;
}

interface ArcGisResponse {
  error?: { message?: string };
  features?: ArcGisFeature[];
}

interface OhioDocumentRow {
  documentId: string;
  letDate: string;
  attributes: Record<string, string>;
}

interface ValidatedCandidate {
  attributes: ArcGisAttributes;
  letDate: string;
  planRows: OhioDocumentRow[];
}

interface Scheduler {
  run<T>(work: () => Promise<T>): Promise<T>;
}

class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    status: number,
    retryAfterMs?: number,
  ) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export const OHIO_DOT_SOURCE_TEMPLATE: PublicDotSourceTemplate = {
  id: OHIO_DOT_SOURCE_ID,
  name: "Ohio DOT Filed Construction Projects",
  owner: "Ohio Department of Transportation",
  level: "state",
  sourceClass: "procurement",
  stages: ["bidding"],
  access: "open",
  cadence: "Daily",
  url: OHIO_DOT_POINT_LAYER.replace(/\/query$/, ""),
  jurisdiction: "Ohio",
  note: "Official filed ODOT-let construction projects validated against public current plans, proposals, and addenda in ODOT's document repository.",
};

function createScheduler(limit = MAX_CONCURRENCY): Scheduler {
  let active = 0;
  const queue: Array<() => void> = [];
  const drain = () => {
    while (active < limit) {
      const start = queue.shift();
      if (!start) return;
      active += 1;
      start();
    }
  };
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          void Promise.resolve()
            .then(work)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              drain();
            });
        });
        drain();
      });
    },
  };
}

function assertOfficialUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !OFFICIAL_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Blocked non-official Ohio DOT URL: ${value}`);
  }
  return url;
}

function retryDelay(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function fetchText(
  urlValue: string,
  options: PublicDotFeedOptions,
  scheduler: Scheduler,
  accept: string,
): Promise<string> {
  const url = assertOfficialUrl(urlValue).toString();
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await scheduler.run(async () => {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
        try {
          let currentUrl = url;
          let response: Response | undefined;
          for (let redirect = 0; redirect <= 4; redirect += 1) {
            response = await fetchImpl(currentUrl, {
              signal: controller.signal,
              redirect: "manual",
              headers: { Accept: accept },
            });
            if (response.status < 300 || response.status >= 400) break;
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location || redirect === 4) {
              throw new Error("Ohio DOT returned an invalid redirect chain");
            }
            currentUrl = assertOfficialUrl(
              new URL(location, currentUrl).toString(),
            ).toString();
          }
          if (!response) throw new Error("Ohio DOT returned no response");
          if (response.url) assertOfficialUrl(response.url);
          if (!response.ok) {
            throw new HttpStatusError(
              `Ohio DOT source returned HTTP ${response.status}: ${url}`,
              response.status,
              retryDelay(response),
            );
          }
          return await response.text();
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof HttpStatusError
          ? error.status === 429 || error.status >= 500
          : error instanceof Error && error.name === "AbortError";
      if (!retryable || attempt === 1) throw error;
      const delay =
        error instanceof HttpStatusError && error.retryAfterMs !== undefined
          ? Math.min(error.retryAfterMs, 1_000)
          : 100;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function newYorkParts(now: Date): {
  date: string;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: OHIO_DOT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return {
    date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    hour: value("hour"),
    minute: value("minute"),
  };
}

function arcGisQueryUrl(layer: string, today: string): string {
  const url = assertOfficialUrl(layer);
  url.search = new URLSearchParams({
    f: "json",
    where:
      `PROJECT_STATUS = 'Filed' AND ODOT_LETTING = 'ODOT Let' ` +
      `AND AWARD_MILESTONE_DT >= DATE '${today}'`,
    outFields: ARCGIS_FIELDS.join(","),
    returnGeometry: "false",
    returnDistinctValues: "true",
    orderByFields: "AWARD_MILESTONE_DT ASC,PID_NBR ASC",
  }).toString();
  return url.toString();
}

async function fetchArcGisLayer(
  layer: string,
  today: string,
  options: PublicDotFeedOptions,
  scheduler: Scheduler,
): Promise<ArcGisAttributes[]> {
  const url = arcGisQueryUrl(layer, today);
  const raw = await fetchText(url, options, scheduler, "application/json");
  let payload: ArcGisResponse;
  try {
    payload = JSON.parse(raw) as ArcGisResponse;
  } catch {
    throw new Error(`Ohio DOT ArcGIS returned malformed JSON: ${url}`);
  }
  if (payload.error || !Array.isArray(payload.features)) {
    throw new Error(
      `Ohio DOT ArcGIS query failed: ${payload.error?.message ?? "missing features"}`,
    );
  }
  return payload.features.map((feature) => {
    if (!feature.attributes || typeof feature.attributes !== "object") {
      throw new Error("Ohio DOT ArcGIS feature is missing attributes");
    }
    return feature.attributes;
  });
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function mergeAttributes(
  first: ArcGisAttributes,
  second: ArcGisAttributes,
): ArcGisAttributes {
  const merged = { ...first };
  for (const [key, value] of Object.entries(second)) {
    if (merged[key] === undefined || merged[key] === null || merged[key] === "") {
      merged[key] = value;
    }
  }
  return merged;
}

function mergeCandidates(rows: readonly ArcGisAttributes[]): ArcGisAttributes[] {
  const byPid = new Map<string, ArcGisAttributes>();
  for (const row of rows) {
    const pid = text(row.PID_NBR);
    if (!pid || !/^\d+$/.test(pid)) continue;
    const existing = byPid.get(pid);
    byPid.set(pid, existing ? mergeAttributes(existing, row) : row);
  }
  return [...byPid.values()].sort((left, right) => {
    const awardDifference =
      (number(left.AWARD_MILESTONE_DT) ?? Number.MAX_SAFE_INTEGER) -
      (number(right.AWARD_MILESTONE_DT) ?? Number.MAX_SAFE_INTEGER);
    if (awardDifference !== 0) return awardDifference;
    return Number(text(left.PID_NBR)) - Number(text(right.PID_NBR));
  });
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function plainText(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"),
  );
  return match?.[2];
}

function parseLetDate(value: string | undefined): string | undefined {
  const match = value?.match(/^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/);
  if (!match) return undefined;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDocumentRows(html: string, url: string): OhioDocumentRow[] {
  const countMatch = html.match(
    /Document Search Results\s*\[\s*(\d+)\s+found\s*\]/i,
  );
  if (!countMatch) {
    throw new Error(`Unexpected Ohio DOT document-search HTML: ${url}`);
  }
  const expected = Number(countMatch[1]);
  const matches = [
    ...html.matchAll(
      /<input\b(?=[^>]*\bname\s*=\s*["']documentId["'])[^>]*>/gi,
    ),
  ];
  const rows: OhioDocumentRow[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const documentId = htmlAttribute(matches[index][0], "value");
    if (!documentId || !/^\d+$/.test(documentId)) continue;
    const start = matches[index].index ?? 0;
    const end = matches[index + 1]?.index ?? html.length;
    const block = html.slice(start, end);
    const attributes: Record<string, string> = {};
    for (const field of block.matchAll(
      /<span\b[^>]*class\s*=\s*["'][^"']*thumb-attribute-name[^"']*["'][^>]*>([\s\S]*?)<\/span>[\s\S]*?<span\b[^>]*class\s*=\s*["'][^"']*thumb-attribute-value[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi,
    )) {
      const label = plainText(field[1]).replace(/:\s*$/, "").toUpperCase();
      if (label) attributes[label] = plainText(field[2]);
    }
    const letDate = parseLetDate(attributes.LET_DATE);
    if (!letDate) continue;
    rows.push({ documentId, letDate, attributes });
  }
  if (rows.length !== expected) {
    throw new Error(
      `Ohio DOT document-search row mismatch (${rows.length}/${expected}): ${url}`,
    );
  }
  return rows;
}

function deadlineIsOpen(
  letDate: string,
  now: Date,
): boolean {
  const deadline = sourceLocalDateTimeToIso(
    `${letDate}T10:00:00.000`,
    OHIO_DOT_TIME_ZONE,
  );
  return Boolean(deadline && Date.parse(deadline) >= now.getTime());
}

function documentSearchUrl(pid: string, cabinetId: number): string {
  const url = new URL("/search.jsp", OHIO_DOT_DOCUMENT_ROOT);
  url.search = new URLSearchParams({
    cabinetId: String(cabinetId),
    PID_NUM: pid,
  }).toString();
  return url.toString();
}

function documentRangeSearchUrl(
  cabinetId: number,
  startDate: string,
): string {
  const [year, month, day] = startDate.split("-");
  const url = new URL("/search.jsp", OHIO_DOT_DOCUMENT_ROOT);
  url.search = new URLSearchParams({
    cabinetId: String(cabinetId),
    "DP.LET_DATE.DATE": `${month}/${day}/${year}-12/31/${Number(year) + 5}`,
    hitsPerPage: "1000",
  }).toString();
  return url.toString();
}

async function fetchDocumentCabinet(
  cabinetId: number,
  startDate: string,
  options: PublicDotFeedOptions,
  scheduler: Scheduler,
): Promise<OhioDocumentRow[]> {
  const url = documentRangeSearchUrl(cabinetId, startDate);
  const html = await fetchText(
    url,
    options,
    scheduler,
    "text/html,application/xhtml+xml",
  );
  return parseDocumentRows(html, url);
}

function documentRowsByPid(
  rows: readonly OhioDocumentRow[],
): Map<string, OhioDocumentRow[]> {
  const grouped = new Map<string, OhioDocumentRow[]>();
  for (const row of rows) {
    const pid = row.attributes.PID_NUM?.replace(/\D/g, "");
    if (!pid) continue;
    const existing = grouped.get(pid) ?? [];
    existing.push(row);
    grouped.set(pid, existing);
  }
  return grouped;
}

function directDocumentUrl(cabinetId: number, documentId: string): string {
  const url = new URL("/document/launchViewer.do", OHIO_DOT_DOCUMENT_ROOT);
  url.search = new URLSearchParams({
    cabinetId: String(cabinetId),
    documentId,
    forward: "documentSearch",
    from: "topNav",
  }).toString();
  return url.toString();
}

function officialDocument(
  pid: string,
  cabinetId: number,
  row: OhioDocumentRow,
): ProjectDocument {
  const projectNumber = row.attributes.PROJECT_NUM;
  const addendum = row.attributes.ADDENDA_NUM;
  const kind: ProjectDocument["kind"] =
    cabinetId === 1002
      ? "plans"
      : cabinetId === 1003
        ? "specifications"
        : "addendum";
  const name =
    kind === "plans"
      ? `ODOT PID ${pid} plans — ${row.letDate}`
      : kind === "specifications"
        ? `ODOT proposal ${projectNumber ?? pid} — ${row.letDate}`
        : `ODOT ${projectNumber ?? pid} addendum ${addendum ?? ""}`.trim();
  return {
    name,
    kind,
    url: directDocumentUrl(cabinetId, row.documentId),
    access: "public",
    indexStatus: "queued",
  };
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function participants(
  attributes: ArcGisAttributes,
  sourceUrl: string,
): ProjectParticipant[] {
  const output: ProjectParticipant[] = [
    {
      name: OHIO_DOT_SOURCE_TEMPLATE.owner,
      role: "agency",
      participantType: "organization",
      sourceUrl,
    },
  ];
  const people: Array<[unknown, ProjectParticipant["role"], string | undefined]> = [
    [attributes.PROJECT_MANAGER_NME, "agency", OHIO_DOT_SOURCE_TEMPLATE.owner],
    [attributes.PROJECT_ENGINEER_NME, "engineer", OHIO_DOT_SOURCE_TEMPLATE.owner],
    [attributes.AREA_ENGINEER_NME, "engineer", OHIO_DOT_SOURCE_TEMPLATE.owner],
    [attributes.ENV_PROJECT_MANAGER_NME, "engineer", OHIO_DOT_SOURCE_TEMPLATE.owner],
  ];
  const seen = new Set([OHIO_DOT_SOURCE_TEMPLATE.owner.toLowerCase()]);
  for (const [rawName, role, organization] of people) {
    const name = text(rawName);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    output.push({
      name,
      role,
      participantType: "person",
      organization,
      sourceUrl,
    });
  }
  const organizations: Array<[unknown, ProjectParticipant["role"]]> = [
    [attributes.DESIGN_AGENCY, "engineer"],
    [attributes.SPONSORING_AGENCY, "owner"],
  ];
  for (const [rawName, role] of organizations) {
    const name = text(rawName);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    output.push({
      name,
      role,
      participantType: "organization",
      sourceUrl,
    });
  }
  return output;
}

function sourceUpdatedAt(attributes: ArcGisAttributes): string | undefined {
  const milliseconds = number(attributes.SOURCE_LAST_UPDATED);
  if (milliseconds === undefined) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function buildProject(
  candidate: ValidatedCandidate,
  proposalRows: OhioDocumentRow[],
  addendaRows: OhioDocumentRow[],
  outputSourceId: string,
  now: Date,
): ProjectRecord {
  const attributes = candidate.attributes;
  const pid = text(attributes.PID_NBR) as string;
  const sourceUrl = documentSearchUrl(pid, 1003);
  const title = text(attributes.PROJECT_NME) ?? `ODOT PID ${pid}`;
  const planMeta = candidate.planRows[0]?.attributes;
  const summaryParts = uniqueValues([
    text(attributes.FMIS_PROJ_DESC),
    text(attributes.PRIMARY_WORK_CATEGORY),
    text(attributes.CONTRACT_TYPE),
    planMeta?.RT_SECTION,
    planMeta?.PROJECT_TYPE,
  ]);
  const summary =
    summaryParts.join("; ") || `Ohio DOT advertised construction project PID ${pid}.`;
  const bidDate = sourceLocalDateTimeToIso(
    `${candidate.letDate}T10:00:00.000`,
    OHIO_DOT_TIME_ZONE,
  );
  if (!bidDate) {
    throw new Error(`Unable to resolve Ohio DOT letting deadline: ${candidate.letDate}`);
  }
  const documents: ProjectDocument[] = [
    {
      name: "Official ODOT project document record",
      kind: "source-record",
      url: sourceUrl,
      access: "public",
      indexStatus: "metadata-only",
    },
    ...candidate.planRows.map((row) => officialDocument(pid, 1002, row)),
    ...proposalRows.map((row) => officialDocument(pid, 1003, row)),
    ...addendaRows.map((row) => officialDocument(pid, 1000, row)),
  ];
  const searchableFields = uniqueValues([
    pid,
    title,
    summary,
    text(attributes.COUNTY_NME),
    text(attributes.COUNTY_NME_WORK_LOCATION),
    text(attributes.DISTRICT_NBR),
    planMeta?.PROJECT_NUM,
    planMeta?.PROJECT_TYPE,
    planMeta?.RT_SECTION,
    ...participants(attributes, sourceUrl).map((participant) => participant.name),
  ]);
  return {
    id: `${outputSourceId}:${pid}`,
    sourceId: outputSourceId,
    sourceRecordId: pid,
    title,
    summary,
    stage: "bidding",
    status: "Advertised",
    agency: OHIO_DOT_SOURCE_TEMPLATE.owner,
    county:
      text(attributes.COUNTY_NME_WORK_LOCATION) ?? text(attributes.COUNTY_NME),
    state: OHIO_DOT_SOURCE_TEMPLATE.jurisdiction,
    value: number(attributes.EST_TOTAL_CONSTR_COST),
    postedAt: sourceUpdatedAt(attributes),
    bidDate,
    bidDateTimeZone: OHIO_DOT_TIME_ZONE,
    updatedAt: now.toISOString(),
    sourceName: OHIO_DOT_SOURCE_TEMPLATE.name,
    sourceUrl,
    provenance: "live-public-page",
    confidence: "official",
    documents,
    participants: participants(attributes, sourceUrl),
    searchableFields,
    documentTextIndexed: false,
  };
}

function pageRecord(
  offset: number,
  returned: readonly ProjectRecord[],
  total: number,
): SourcePageRecord {
  const nextOffset = offset + returned.length;
  const last = returned.at(-1);
  return {
    offset,
    recordsRead: returned.length,
    nextOffset,
    hasMore: nextOffset < total,
    currentCursor: { offset },
    nextCursor: {
      offset: nextOffset,
      lastRecordSortValue: last?.bidDate,
      lastRecordUniqueId: last?.sourceRecordId,
    },
  };
}

export async function fetchOhioDotSource(
  options: PublicDotFeedOptions = {},
): Promise<PublicDotConnectorResult> {
  const now = (options.now ?? (() => new Date()))();
  const localNow = newYorkParts(now);
  const scheduler = createScheduler();
  const outputSourceId = options.sourceId ?? OHIO_DOT_SOURCE_ID;
  const [pointRows, lineRows, allPlanRows, allProposalRows, allAddendaRows] = await Promise.all([
    fetchArcGisLayer(OHIO_DOT_POINT_LAYER, localNow.date, options, scheduler),
    fetchArcGisLayer(OHIO_DOT_LINE_LAYER, localNow.date, options, scheduler),
    fetchDocumentCabinet(1002, localNow.date, options, scheduler),
    fetchDocumentCabinet(1003, localNow.date, options, scheduler),
    fetchDocumentCabinet(1000, localNow.date, options, scheduler),
  ]);
  const candidates = mergeCandidates([...pointRows, ...lineRows]);
  const plansByPid = documentRowsByPid(allPlanRows);
  const proposalsByPid = documentRowsByPid(allProposalRows);
  const addendaByPid = documentRowsByPid(allAddendaRows);
  const built = candidates.flatMap((attributes): ProjectRecord[] => {
    const pid = text(attributes.PID_NBR) as string;
    const openPlans = (plansByPid.get(pid) ?? []).filter((row) =>
      deadlineIsOpen(row.letDate, now),
    );
    const proposalRowsForPid = proposalsByPid.get(pid) ?? [];
    const nextLetDate = [...new Set(openPlans.map((row) => row.letDate))]
      .filter((letDate) =>
        proposalRowsForPid.some((row) => row.letDate === letDate),
      )
      .sort()[0];
    if (!nextLetDate) return [];
    const candidate: ValidatedCandidate = {
      attributes,
      letDate: nextLetDate,
      planRows: openPlans.filter((row) => row.letDate === nextLetDate),
    };
    return [buildProject(
      candidate,
      proposalRowsForPid.filter((row) => row.letDate === nextLetDate),
      (addendaByPid.get(pid) ?? []).filter((row) => row.letDate === nextLetDate),
      outputSourceId,
      now,
    )];
  });
  const allProjects = built
    .sort(
      (left, right) =>
        (left.bidDate ?? "").localeCompare(right.bidDate ?? "") ||
        Number(left.sourceRecordId) - Number(right.sourceRecordId),
    );
  const offset = options.sourceCursors?.[outputSourceId]?.offset ?? 0;
  const limit = options.mode === "ingest" ? INGEST_LIMIT : VIEW_LIMIT;
  const projects = allProjects.slice(offset, offset + limit);
  const page = pageRecord(offset, projects, allProjects.length);
  return {
    projects,
    source: {
      ...OHIO_DOT_SOURCE_TEMPLATE,
      id: outputSourceId,
      status: "live",
      recordCount: allProjects.length,
      recordCountUnit: "projects",
      loadedCount: projects.length,
      snapshotComplete: !page.hasMore,
      lastChecked: now.toISOString(),
    },
    page,
  };
}
