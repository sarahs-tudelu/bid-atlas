import type {
  ProjectDocument,
  ProjectFeed,
  ProjectParticipant,
  ProjectRecord,
  ProjectSearchOptions,
  ProjectStage,
  SourceCursorRecord,
  SourcePageRecord,
  SourceRecord,
} from "./types";
import {
  buildCoverageSummary,
  CENSUS_REGISTRY_ROWS_2025,
} from "./national-coverage";
import {
  fetchSocrataCitySource,
  SOCRATA_CITY_SOURCE_IDS,
  SOCRATA_CITY_SOURCE_TEMPLATES,
} from "./socrata-city-connectors";
import {
  fetchStandardizedSource,
  STANDARDIZED_SOURCE_IDS,
  STANDARDIZED_SOURCE_TEMPLATES,
} from "./standardized-source-connectors";
import {
  fetchPublicDotSource,
  PUBLIC_DOT_SOURCE_IDS,
  PUBLIC_DOT_SOURCE_TEMPLATES,
} from "./public-dot-connectors";

export {
  lookupStandardizedProject,
  lookupStandardizedSourceProject,
} from "./standardized-source-connectors";
export {
  lookupPublicDotProject,
  lookupPublicDotSourceProject,
} from "./public-dot-connectors";
export { lookupSocrataCityProject } from "./socrata-city-connectors";

const REQUEST_TIMEOUT_MS = 8_000;

type ConnectorResult = {
  projects: ProjectRecord[];
  source: SourceRecord;
  page: SourcePageRecord;
};

export type FeedMode = "view" | "ingest";

export interface FeedOptions {
  mode?: FeedMode;
  lane?: "backfill" | "refresh";
  samApiKey?: string;
  sourceCursors?: Record<string, SourceCursorRecord>;
  sourceId?: string;
}

type SourceTemplate = Omit<SourceRecord, "status" | "recordCount" | "lastChecked">;

const permittingTemplate: SourceTemplate = {
  id: "federal-permitting-dashboard",
  name: "Federal Permitting Dashboard",
  owner: "Federal Permitting Improvement Steering Council",
  level: "federal",
  sourceClass: "permits",
  stages: ["planning", "permitting", "completed", "cancelled"],
  access: "open",
  cadence: "Every 6 hours",
  url: "https://data.permits.performance.gov/",
  jurisdiction: "United States",
  note: "Major and complex infrastructure projects with review and authorization milestones.",
};

const usaSpendingTemplate: SourceTemplate = {
  id: "usaspending-construction-awards",
  name: "USAspending construction awards",
  owner: "U.S. Department of the Treasury",
  level: "federal",
  sourceClass: "awards",
  stages: ["awarded"],
  access: "open",
  cadence: "Every 12 hours",
  url: "https://www.usaspending.gov/",
  jurisdiction: "United States",
  note: "Federal prime construction awards in NAICS sector 23, including awardee and value.",
};

const caltransTemplate: SourceTemplate = {
  id: "caltrans-contracting-opportunities",
  name: "Caltrans contracting opportunities",
  owner: "California Department of Transportation",
  level: "state",
  sourceClass: "procurement",
  stages: ["bidding"],
  access: "open",
  cadence: "Every 2 hours",
  url: "https://ccop.dot.ca.gov/allProjects",
  jurisdiction: "California",
  note: "Advertised and upcoming construction projects with bid dates and contract-document links.",
};

const samTemplate: SourceTemplate = {
  id: "sam-contract-opportunities",
  name: "SAM.gov contract opportunities",
  owner: "U.S. General Services Administration",
  level: "federal",
  sourceClass: "procurement",
  stages: ["planning", "bidding", "awarded", "cancelled"],
  access: "free-key",
  cadence: "Every hour",
  url: "https://sam.gov/content/opportunities",
  jurisdiction: "United States",
  note: "Federal sources sought, presolicitations, solicitations, attachments, notices, and awards.",
};

const censusRegistry: SourceRecord = {
  id: "census-government-units",
  name: "2025 Government Units Listing",
  owner: "U.S. Census Bureau",
  level: "registry",
  sourceClass: "registry",
  stages: [],
  status: "registry",
  access: "open",
  cadence: "Annual registry refresh",
  recordCount: CENSUS_REGISTRY_ROWS_2025,
  loadedCount: 0,
  snapshotComplete: false,
  lastChecked: new Date().toISOString(),
  url: "https://www.census.gov/data/datasets/2025/econ/gus/public-use-files.html",
  jurisdiction: "All U.S. governments",
  note: "The authoritative 91,438-local-government coverage universe. Loaded counts are reported from the D1 registry; snapshot completeness remains a separate audit state.",
};

export const SEATTLE_PERMIT_SOURCE_ID = "seattle-building-permits" as const;

export const SEATTLE_PERMIT_SOURCE_TEMPLATE: SourceTemplate = {
  id: SEATTLE_PERMIT_SOURCE_ID,
  name: "Seattle building permits",
  owner: "Seattle Department of Construction and Inspections",
  level: "local",
  sourceClass: "permits",
  stages: ["design", "permitting", "completed", "cancelled", "unclassified"],
  access: "open",
  cadence: "Daily",
  url: "https://data.seattle.gov/Permitting/Building-Permits/76t5-zqzr/about_data",
  jurisdiction: "Seattle, Washington",
  note: "Building applications and permits with descriptions, addresses, values, plan-review status, and contractor names.",
};

const seattlePermitTemplate = SEATTLE_PERMIT_SOURCE_TEMPLATE;

const cityTemplates: Record<string, SourceTemplate> = {
  seattle: {
    id: "legistar-seattle",
    name: "Seattle legislative projects",
    owner: "City of Seattle",
    level: "local",
    sourceClass: "planning",
    stages: ["planning", "design", "awarded"],
    access: "open",
    cadence: "Every 4 hours",
    url: "https://seattle.legistar.com/",
    jurisdiction: "Seattle, Washington",
    note: "New council and committee matters screened for construction, capital, land-use, and design signals.",
  },
  sanjose: {
    id: "legistar-sanjose",
    name: "San José legislative projects",
    owner: "City of San José",
    level: "local",
    sourceClass: "planning",
    stages: ["planning", "design", "awarded"],
    access: "open",
    cadence: "Every 4 hours",
    url: "https://sanjose.legistar.com/",
    jurisdiction: "San José, California",
    note: "New council and committee matters screened for construction, capital, land-use, and design signals.",
  },
};

export const PROJECT_SOURCE_IDS = [
  permittingTemplate.id,
  usaSpendingTemplate.id,
  caltransTemplate.id,
  seattlePermitTemplate.id,
  cityTemplates.seattle.id,
  cityTemplates.sanjose.id,
  samTemplate.id,
  ...SOCRATA_CITY_SOURCE_IDS,
  ...STANDARDIZED_SOURCE_IDS,
  ...PUBLIC_DOT_SOURCE_IDS,
] as const;

function sourceNow(
  template: SourceTemplate,
  status: SourceRecord["status"],
  count: number,
  note?: string,
  loadedCount = count,
  snapshotComplete = false,
): SourceRecord {
  return {
    ...template,
    status,
    recordCount: count,
    loadedCount,
    snapshotComplete,
    lastChecked: new Date().toISOString(),
    note: note ?? template.note,
  };
}

function normalizedSourceOffset(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function sourceCursorDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function sourceLiteral(value: string | number): string {
  return String(value).replace(/'/g, "''");
}

function sourceIdentity(value: unknown, sourceName: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new Error(`${sourceName}: source record is missing a stable identity.`);
  }
  const identity = String(value).trim();
  if (!identity) {
    throw new Error(`${sourceName}: source record is missing a stable identity.`);
  }
  return identity;
}

function claimSourceIdentity(
  sourceName: string,
  value: unknown,
  seen: Set<string>,
): string {
  const identity = sourceIdentity(value, sourceName);
  if (seen.has(identity)) {
    throw new Error(`${sourceName}: duplicate source identity ${identity} in one page.`);
  }
  seen.add(identity);
  return identity;
}

function uniqueSourceIdentities(
  sourceName: string,
  values: unknown[],
): string[] {
  const seen = new Set<string>();
  return values.map((value) => claimSourceIdentity(sourceName, value, seen));
}

function isPaginationToken(value: unknown): value is string | number {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function pageRecord(
  offset: number,
  recordsRead: number,
  total: number,
  currentCursor: SourceCursorRecord = { offset },
): SourcePageRecord {
  const nextOffset = offset + recordsRead;
  return {
    offset,
    recordsRead,
    nextOffset: nextOffset < total ? nextOffset : 0,
    hasMore: recordsRead > 0 && nextOffset < total,
    currentCursor,
    nextCursor: { offset: nextOffset < total ? nextOffset : 0 },
  };
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/html;q=0.9",
        "User-Agent": "BidAtlas/0.1 public-record-indexer",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function parseMoney(value?: string | number): number | undefined {
  if (typeof value === "number") return value;
  if (!value) return undefined;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isoDate(value?: string): string | undefined {
  if (!value) return undefined;
  // Public data portals often return an ISO-looking timestamp without a zone.
  // Treat that floating value deterministically instead of letting the host
  // workstation/worker timezone change the same upstream record.
  const normalized = /(?:z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value
    : /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T00:00:00.000Z`
      : `${value}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function trustedHttpsUrl(
  value: unknown,
  allowedHost: (hostname: string) => boolean,
): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || !allowedHost(hostname)) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function terminalPermitStage(status: string | undefined): ProjectStage | undefined {
  const value = (status ?? "").trim().toLowerCase();
  if (value === "cancelled") return "cancelled";
  if (value === "complete") return "completed";
  return undefined;
}

function participants(
  entries: Array<ProjectParticipant | undefined>,
): ProjectParticipant[] {
  return entries.filter((entry): entry is ProjectParticipant => Boolean(entry?.name));
}

async function fetchPermittingProjects(
  mode: FeedMode,
  requestedCursor: SourceCursorRecord = { offset: 0 },
  lane: "backfill" | "refresh" = "backfill",
): Promise<ConnectorResult> {
  const offset = normalizedSourceOffset(requestedCursor.offset);
  // Ingestion must traverse a stable canonical universe. Filtering records by
  // their current status would let an unvisited project disappear when it is
  // completed or cancelled during a long-running backfill.
  const baseWhere = mode === "ingest"
    ? "project_canonical=true"
    : "project_canonical=true AND project_field_project_status not in ('Complete','Cancelled')";
  const scopeLabel = mode === "ingest" ? "canonical" : "active";
  const countParams = new URLSearchParams({ "$select": "count(*) as count", "$where": baseWhere });
  const countRows = (await (
    await fetchWithTimeout(
      `https://data.permits.performance.gov/resource/mcm3-xbid.json?${countParams}`,
    )
  ).json()) as Array<{ count?: string }>;
  const sourceReportedTotal = Number(countRows[0]?.count ?? 0);
  const limit = mode === "ingest" ? 50 : 40;
  const refreshOrder = mode === "view" || lane === "refresh";
  const keysetWhere = !refreshOrder && requestedCursor.lastRecordUniqueId !== undefined
    ? `project_id > '${sourceLiteral(requestedCursor.lastRecordUniqueId)}'`
    : "";
  const where = [baseWhere, keysetWhere].filter(Boolean).map((value) => `(${value})`).join(" AND ");
  const params = new URLSearchParams({
    "$select": [
      "project_id",
      "project_title",
      "project_field_project_status",
      "project_sector",
      "project_sector_type",
      "project_field_location_state",
      "project_field_location_city",
      "project_field_location_county",
      "total_estimated_project_cost",
      "project_field_project_lead_agency",
      "project_field_project_sponsor_agency",
      "project_url",
    ].join(","),
    "$where": where,
    "$order": refreshOrder ? "project_id DESC" : "project_id ASC",
    "$limit": String(limit),
    "$offset": "0",
  });
  const endpoint = `https://data.permits.performance.gov/resource/mcm3-xbid.json?${params}`;
  const rows = (await (await fetchWithTimeout(endpoint)).json()) as Array<{
    project_id: string;
    project_title?: string;
    project_field_project_status?: string;
    project_sector?: string;
    project_sector_type?: string;
    project_field_location_state?: string;
    project_field_location_city?: string;
    project_field_location_county?: string;
    total_estimated_project_cost?: string;
    project_field_project_lead_agency?: string;
    project_field_project_sponsor_agency?: string;
    project_url?: { url?: string } | string;
  }>;

  const projectIds = uniqueSourceIdentities(
    permittingTemplate.name,
    rows.map((row) => row.project_id),
  );
  const projects = rows.map<ProjectRecord>((row, index) => {
    const projectId = projectIds[index];
    const sourceUrl =
      typeof row.project_url === "string"
        ? row.project_url
        : row.project_url?.url ?? permittingTemplate.url;
    const status = row.project_field_project_status ?? "In review";
    const stage =
      terminalPermitStage(status) ?? (/^\s*planned\s*$/i.test(status) ? "planning" : "permitting");
    return {
      id: `${permittingTemplate.id}:${projectId}`,
      sourceId: permittingTemplate.id,
      sourceRecordId: projectId,
      title: row.project_title ?? `Federal permitting project ${projectId}`,
      summary: [row.project_sector, row.project_sector_type].filter(Boolean).join(" · "),
      stage,
      status,
      agency: row.project_field_project_lead_agency ?? "Federal lead agency",
      city: row.project_field_location_city,
      county: row.project_field_location_county,
      state: row.project_field_location_state,
      value: parseMoney(row.total_estimated_project_cost),
      // This source exposes its data-extraction time, not a project activity
      // time. Keep the required field at the application's explicit unknown
      // sentinel so a routine dataset refresh cannot make every project "new."
      updatedAt: new Date(0).toISOString(),
      sourceName: permittingTemplate.name,
      sourceUrl,
      provenance: "live-api",
      confidence: "official",
      documents: [
        {
          name: "Permitting project record & milestones",
          kind: "permit",
          url: sourceUrl,
          access: "public",
        },
      ],
      participants: participants([
        row.project_field_project_sponsor_agency
          ? { name: row.project_field_project_sponsor_agency, role: "owner" }
          : undefined,
        row.project_field_project_lead_agency
          ? { name: row.project_field_project_lead_agency, role: "agency" }
          : undefined,
      ]),
    };
  });
  const lastProjectId = projectIds.at(-1);
  const hasMore = rows.length >= limit;
  const nextCursor: SourceCursorRecord =
    hasMore && lastProjectId
      ? {
          offset: offset + rows.length,
          lastRecordUniqueId: lastProjectId,
        }
      : { offset: 0 };
  const page: SourcePageRecord = {
    offset,
    recordsRead: rows.length,
    nextOffset: nextCursor.offset,
    hasMore: hasMore && nextCursor.offset > 0,
    currentCursor: requestedCursor,
    nextCursor,
  };
  return {
    projects,
    source: sourceNow(
      permittingTemplate,
      "live",
      sourceReportedTotal || projects.length,
      `${permittingTemplate.note} ${sourceReportedTotal || projects.length} ${scopeLabel} records reported; ${projects.length} loaded in this ${mode} run.`,
      projects.length,
      !page.hasMore,
    ),
    page,
  };
}

async function fetchUsaSpendingAwards(
  mode: FeedMode,
  requestedCursor: SourceCursorRecord = { offset: 0 },
): Promise<ConnectorResult> {
  const offset = normalizedSourceOffset(requestedCursor.offset);
  const limit = mode === "ingest" ? 50 : 30;
  const end = sourceCursorDate(requestedCursor.windowEnd) ?? new Date();
  const start = sourceCursorDate(requestedCursor.windowStart) ?? new Date(end);
  if (!requestedCursor.windowStart) start.setUTCMonth(start.getUTCMonth() - 9);
  const windowStart = start.toISOString().slice(0, 10);
  const windowEnd = end.toISOString().slice(0, 10);
  const hasRequestedUniqueId = isPaginationToken(requestedCursor.lastRecordUniqueId);
  const hasRequestedSortValue = isPaginationToken(requestedCursor.lastRecordSortValue);
  if (
    hasRequestedUniqueId !== hasRequestedSortValue ||
    (offset === 0 && hasRequestedUniqueId) ||
    (offset > 0 && !hasRequestedUniqueId)
  ) {
    throw new Error(
      `${usaSpendingTemplate.name}: continuation cursor must contain a positive page and both pagination tokens.`,
    );
  }
  const payload: Record<string, unknown> = {
    filters: {
      award_type_codes: ["A", "B", "C", "D"],
      time_period: [
        {
          start_date: windowStart,
          end_date: windowEnd,
        },
      ],
      naics_codes: { require: ["23"] },
      place_of_performance_scope: "domestic",
    },
    fields: [
      "Award ID",
      "Recipient Name",
      "Award Amount",
      "Description",
      "Start Date",
      "End Date",
      "Awarding Agency",
      "Awarding Sub Agency",
      "generated_internal_id",
    ],
    page: offset + 1,
    limit,
    sort: "Award ID",
    order: "desc",
    subawards: false,
  };
  if (hasRequestedUniqueId && hasRequestedSortValue) {
    payload.last_record_unique_id = requestedCursor.lastRecordUniqueId;
    payload.last_record_sort_value = requestedCursor.lastRecordSortValue;
  }
  const requestInit = (body: Record<string, unknown>): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const [data, countData] = await Promise.all([
    fetchWithTimeout(
      "https://api.usaspending.gov/api/v2/search/spending_by_award/",
      requestInit(payload),
    ).then((response) => response.json()) as Promise<{
      results?: Array<Record<string, string | number | null>>;
      page_metadata?: {
        page?: number;
        hasNext?: boolean;
        last_record_unique_id?: string | number;
        last_record_sort_value?: string | number;
      };
    }>,
    fetchWithTimeout(
      "https://api.usaspending.gov/api/v2/search/spending_by_award_count/",
      requestInit({ filters: payload.filters, subawards: false }),
    ).then((response) => response.json()) as Promise<{
      results?: { contracts?: number | string | null };
    }>,
  ]);
  const typedData = data as {
    results?: Array<Record<string, string | number | null>>;
    page_metadata?: {
      page?: number;
      hasNext?: boolean;
      last_record_unique_id?: string | number;
      last_record_sort_value?: string | number;
    };
  };
  if (!Array.isArray(typedData.results)) {
    throw new Error(`${usaSpendingTemplate.name}: response omitted the results array.`);
  }
  const pageMetadata = typedData.page_metadata;
  if (!pageMetadata || typeof pageMetadata.hasNext !== "boolean") {
    throw new Error(`${usaSpendingTemplate.name}: response omitted pagination metadata.`);
  }
  if (pageMetadata.page !== undefined && pageMetadata.page !== offset + 1) {
    throw new Error(`${usaSpendingTemplate.name}: response returned an unexpected page number.`);
  }
  const rawSourceReportedTotal = countData.results?.contracts;
  const sourceReportedTotal = Number(rawSourceReportedTotal);
  if (
    rawSourceReportedTotal === undefined ||
    rawSourceReportedTotal === null ||
    !Number.isInteger(sourceReportedTotal) ||
    sourceReportedTotal < 0
  ) {
    throw new Error(`${usaSpendingTemplate.name}: response omitted a valid contract count.`);
  }

  const resultRows = typedData.results;
  if (resultRows.length > limit) {
    throw new Error(`${usaSpendingTemplate.name}: response exceeded the requested page limit.`);
  }
  const internalIds = uniqueSourceIdentities(
    usaSpendingTemplate.name,
    resultRows.map((row) => row.generated_internal_id),
  );
  const awardIds = resultRows.map((row, index) =>
    sourceIdentity(row["Award ID"] ?? internalIds[index], usaSpendingTemplate.name),
  );
  const hasMore = pageMetadata.hasNext;
  const nextRecordUniqueId = pageMetadata.last_record_unique_id;
  const nextRecordSortValue = pageMetadata.last_record_sort_value;
  if (
    hasMore &&
    (resultRows.length === 0 ||
      resultRows.length < limit ||
      !isPaginationToken(nextRecordUniqueId) ||
      !isPaginationToken(nextRecordSortValue))
  ) {
    throw new Error(
      `${usaSpendingTemplate.name}: hasNext requires a full, non-empty page and both continuation tokens.`,
    );
  }
  // The count endpoint is an independently evaluated, mutable observation.
  // Page metadata and continuation tokens are authoritative for traversal, so
  // count drift cannot strand a durable cursor after awards enter or leave the
  // frozen date window.

  const projects = resultRows.map<ProjectRecord>((row, index) => {
    const awardId = awardIds[index];
    const internalId = internalIds[index];
    const sourceUrl = `https://www.usaspending.gov/award/${encodeURIComponent(internalId)}/`;
    const contractor =
      row["Recipient Name"] === null || row["Recipient Name"] === undefined
        ? undefined
        : String(row["Recipient Name"]).trim() || undefined;
    return {
      id: `${usaSpendingTemplate.id}:${internalId}`,
      sourceId: usaSpendingTemplate.id,
      sourceRecordId: internalId,
      title: String(row.Description ?? `Federal construction award ${awardId}`),
      summary: `Prime award ${awardId} · ${String(row["Awarding Sub Agency"] ?? "Federal construction")}`,
      stage: "awarded",
      status: "Award reported",
      agency: String(row["Awarding Agency"] ?? "Federal agency"),
      value: parseMoney(row["Award Amount"] ?? undefined),
      postedAt: isoDate(String(row["Start Date"] ?? "")),
      updatedAt: isoDate(String(row["Start Date"] ?? "")) ?? new Date(0).toISOString(),
      sourceName: usaSpendingTemplate.name,
      sourceUrl,
      provenance: "live-api",
      confidence: "official",
      documents: [
        {
          name: "Federal award record",
          kind: "award",
          url: sourceUrl,
          access: "public",
        },
      ],
      participants: contractor ? [{ name: contractor, role: "contractor" }] : [],
    };
  });
  const nextCursor: SourceCursorRecord = hasMore
    ? {
        offset: offset + 1,
        lastRecordUniqueId: nextRecordUniqueId,
        lastRecordSortValue: nextRecordSortValue,
        windowStart,
        windowEnd,
      }
    : { offset: 0 };
  const page: SourcePageRecord = {
    offset,
    recordsRead: resultRows.length,
    nextOffset: nextCursor.offset,
    hasMore,
    currentCursor: { ...requestedCursor, offset, windowStart, windowEnd },
    nextCursor,
  };
  return {
    projects,
    source: sourceNow(
      usaSpendingTemplate,
      "live",
      sourceReportedTotal,
      `${usaSpendingTemplate.note} ${sourceReportedTotal.toLocaleString("en-US")} matching awards reported for the nine-month window; ${projects.length} loaded in this ${mode} run.`,
      projects.length,
      !page.hasMore,
    ),
    page,
  };
}

function extractCell(row: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = row.match(
    new RegExp(`data-label=["']${escaped}["'][^>]*>([\\s\\S]*?)(?=<\\/td>|<td|<\\/tr>)`, "i"),
  );
  return stripHtml(match?.[1] ?? "");
}

async function fetchCaltransProjects(mode: FeedMode): Promise<ConnectorResult> {
  const html = await (await fetchWithTimeout(caltransTemplate.url)).text();
  const projects: ProjectRecord[] = [];
  const seenContractIds = new Set<string>();
  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    const idMatch = row.match(
      /data-label=["']Project ID["'][\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/i,
    );
    if (!idMatch) {
      if (/data-label=["']Project ID["']/i.test(row)) {
        throw new Error(`${caltransTemplate.name}: source record is missing a stable identity.`);
      }
      continue;
    }
    const contractId = claimSourceIdentity(
      caltransTemplate.name,
      stripHtml(idMatch[2]),
      seenContractIds,
    );
    const sourceUrl = idMatch[1].replace(/&amp;/g, "&");
    const status = extractCell(row, "Status") || "Advertised";
    if (!/advertised|upcoming/i.test(status)) continue;
    const bidDate = extractCell(row, "Bid Date");
    const postedAt = extractCell(row, "Advertise Date");
    const title = extractCell(row, "Project Title") || `Caltrans contract ${contractId}`;
    const county = extractCell(row, "County");
    const license = extractCell(row, "License");
    projects.push({
      id: `${caltransTemplate.id}:${contractId}`,
      sourceId: caltransTemplate.id,
      sourceRecordId: contractId,
      title,
      summary: [county ? `${county} County` : "California", license ? `License ${license}` : ""]
        .filter(Boolean)
        .join(" · "),
      stage: "bidding",
      status,
      agency: "California Department of Transportation",
      county: county || undefined,
      state: "CA",
      postedAt: isoDate(postedAt),
      bidDate: isoDate(bidDate),
      updatedAt: isoDate(postedAt || bidDate) ?? new Date(0).toISOString(),
      sourceName: caltransTemplate.name,
      sourceUrl,
      provenance: "live-public-page",
      confidence: "official",
      documents: [
        {
          name: "Advertisement & contract documents",
          kind: "plans",
          url: sourceUrl,
          access: "public",
          indexStatus: "metadata-only",
        },
      ],
      participants: [
        { name: "California Department of Transportation", role: "owner" },
      ],
    });
  }
  projects.sort((a, b) => (a.bidDate ?? "").localeCompare(b.bidDate ?? ""));
  const visible = mode === "ingest" ? projects : projects.slice(0, 40);
  const page = pageRecord(0, visible.length, projects.length);
  return {
    projects: visible,
    source: sourceNow(
      caltransTemplate,
      "live",
      projects.length,
      `${caltransTemplate.note} ${projects.length} current records detected; ${visible.length} loaded in this ${mode} run.`,
      visible.length,
      !page.hasMore,
    ),
    page,
  };
}

const SEATTLE_PERMIT_DATASET = "https://cos-data.seattle.gov/resource/76t5-zqzr.json";
const SEATTLE_PERMIT_ACTIVE_WHERE =
  "applieddate >= '2025-01-01T00:00:00.000' AND completeddate is null";
const SEATTLE_PERMIT_SELECT = [
  ":updated_at",
  "permitnum",
  "permitclassmapped",
  "permittypemapped",
  "permittypedesc",
  "description",
  "estprojectcost",
  "applieddate",
  "issueddate",
  "completeddate",
  "statuscurrent",
  "originaladdress1",
  "originalcity",
  "originalstate",
  "originalzip",
  "contractorcompanyname",
  "link",
  "zoning",
  "standardplan",
].join(",");

type SeattlePermitRow = {
  ":updated_at"?: string;
  permitnum: string;
  permitclassmapped?: string;
  permittypemapped?: string;
  permittypedesc?: string;
  description?: string;
  estprojectcost?: string;
  applieddate?: string;
  issueddate?: string;
  completeddate?: string;
  statuscurrent?: string;
  originaladdress1?: string;
  originalcity?: string;
  originalstate?: string;
  originalzip?: string;
  contractorcompanyname?: string;
  link?: string | { url?: string };
  zoning?: string;
  standardplan?: string;
};

function seattlePermitStage(row: SeattlePermitRow): ProjectStage {
  const status = (row.statuscurrent ?? "").trim().toLowerCase();
  if (["completed", "closed", "inspections completed", "approved to occupy"].includes(status)) {
    return "completed";
  }
  if (["expired", "withdrawn", "canceled", "cancelled", "denied"].includes(status)) {
    return "cancelled";
  }
  if (
    /additional info|correction|reviews in process|awaiting info|ready for intake|initiated|pending|plan review/.test(
      status,
    )
  ) {
    return "design";
  }
  if (
    /issued|ready for issuance|reviews completed|application completed|active|scheduled/.test(status) ||
    Boolean(row.issueddate)
  ) {
    return "permitting";
  }
  return "unclassified";
}

function mapSeattlePermit(row: SeattlePermitRow): ProjectRecord {
  const sourceUrl =
    typeof row.link === "string"
      ? row.link
      : row.link?.url ?? `${seattlePermitTemplate.url}?permit=${encodeURIComponent(row.permitnum)}`;
  const issued = Boolean(row.issueddate) || /issued/i.test(row.statuscurrent ?? "");
  const stage = seattlePermitStage(row);
  return {
    id: `${seattlePermitTemplate.id}:${row.permitnum}`,
    sourceId: seattlePermitTemplate.id,
    sourceRecordId: row.permitnum,
    title: row.description || `${row.permittypemapped ?? "Building"} permit ${row.permitnum}`,
    summary: [row.permitclassmapped, row.permittypedesc, row.originaladdress1]
      .filter(Boolean)
      .join(" - "),
    stage,
    status: row.statuscurrent ?? (issued ? "Issued" : "In plan review"),
    agency: "Seattle Department of Construction and Inspections",
    address: row.originaladdress1,
    city: row.originalcity ?? "Seattle",
    state: row.originalstate ?? "WA",
    postalCode: row.originalzip,
    value: parseMoney(row.estprojectcost),
    postedAt: isoDate(row.applieddate),
    updatedAt:
      isoDate(row.completeddate ?? row.issueddate ?? row.applieddate) ?? new Date(0).toISOString(),
    sourceName: seattlePermitTemplate.name,
    sourceUrl,
    provenance: "live-api",
    confidence: "official",
    documents: [
      {
        name: "Permit and plan-review record",
        kind: "permit",
        url: sourceUrl,
        access: "public",
        indexStatus: "metadata-only",
      },
    ],
    participants: participants([
      row.contractorcompanyname
        ? { name: row.contractorcompanyname, role: "contractor" }
        : undefined,
    ]),
    searchableFields: [
      row.description,
      row.permitclassmapped,
      row.permittypemapped,
      row.permittypedesc,
      row.originaladdress1,
      row.zoning,
      row.standardplan,
      row.contractorcompanyname,
    ].filter((value): value is string => Boolean(value)),
    documentTextIndexed: false,
  };
}

export async function lookupSeattlePermitProject(
  projectIdOrPermitNumber: string,
): Promise<ProjectRecord | undefined> {
  const requestedId = projectIdOrPermitNumber.trim();
  const projectPrefix = `${seattlePermitTemplate.id}:`;
  if (!requestedId || requestedId.length > 240) return undefined;
  if (requestedId.includes(":") && !requestedId.startsWith(projectPrefix)) return undefined;
  const permitNumber = requestedId.startsWith(projectPrefix)
    ? requestedId.slice(projectPrefix.length).trim()
    : requestedId;
  if (!permitNumber) return undefined;

  const params = new URLSearchParams({
    "$select": SEATTLE_PERMIT_SELECT,
    "$where": `permitnum = '${sourceLiteral(permitNumber)}'`,
    "$limit": "2",
  });
  const rows = (await (
    await fetchWithTimeout(`${SEATTLE_PERMIT_DATASET}?${params}`)
  ).json()) as SeattlePermitRow[];
  if (rows.length === 0) return undefined;
  const permitIds = uniqueSourceIdentities(
    seattlePermitTemplate.name,
    rows.map((row) => row.permitnum),
  );
  const exactIndex = permitIds.findIndex((permitId) => permitId === permitNumber);
  return exactIndex < 0
    ? undefined
    : mapSeattlePermit({ ...rows[exactIndex], permitnum: permitIds[exactIndex] });
}

async function fetchSeattlePermits(
  mode: FeedMode,
  requestedCursor: SourceCursorRecord = { offset: 0 },
  lane: "backfill" | "refresh" = "backfill",
): Promise<ConnectorResult> {
  const offset = normalizedSourceOffset(requestedCursor.offset);
  // Backfill scans every historical row by its non-null, unique permit number.
  // It never filters completed/terminal permits, so status transitions cannot
  // make an unvisited record disappear. The refresh lane intentionally reads
  // Socrata's row-update clock so newly filed permits and later lifecycle
  // changes share one durable forward-only refresh watermark.
  const ingesting = mode === "ingest";
  const refreshOrder = ingesting && lane === "refresh";
  const refreshAfter = refreshOrder && requestedCursor.refreshAfter === true;
  const cursorId = requestedCursor.lastRecordUniqueId;
  const cursorSort = requestedCursor.lastRecordSortValue;
  const hasCursorId =
    (typeof cursorId === "string" && cursorId.trim().length > 0) ||
    (typeof cursorId === "number" && Number.isFinite(cursorId));
  const hasCursorSort =
    (typeof cursorSort === "string" && cursorSort.trim().length > 0) ||
    (typeof cursorSort === "number" && Number.isFinite(cursorSort));
  if (
    (refreshAfter && (offset !== 0 || !hasCursorId || !hasCursorSort)) ||
    (!refreshAfter && refreshOrder && offset === 0 && (hasCursorId || hasCursorSort)) ||
    (!refreshAfter && refreshOrder && offset > 0 && (!hasCursorId || hasCursorSort)) ||
    (!refreshOrder && requestedCursor.refreshAfter === true)
  ) {
    throw new Error(`${seattlePermitTemplate.name}: inconsistent refresh cursor.`);
  }
  const baseWhere = ingesting ? "" : SEATTLE_PERMIT_ACTIVE_WHERE;
  const scopeLabel = ingesting ? "full-history" : "active";
  const countParams = new URLSearchParams({ "$select": "count(*) as count" });
  if (baseWhere) countParams.set("$where", baseWhere);
  const countRows = (await (
    await fetchWithTimeout(`${SEATTLE_PERMIT_DATASET}?${countParams}`)
  ).json()) as Array<{ count?: string }>;
  const sourceReportedTotal = Number(countRows[0]?.count ?? 0);

  const limit = mode === "ingest" ? 50 : 100;
  const keysetWhere = refreshAfter
    ? `(:updated_at > '${sourceLiteral(cursorSort!)}' OR (:updated_at = '${sourceLiteral(cursorSort!)}' AND permitnum > '${sourceLiteral(cursorId!)}'))`
    : ingesting && requestedCursor.lastRecordUniqueId !== undefined
    ? `permitnum ${refreshOrder ? "<" : ">"} '${sourceLiteral(requestedCursor.lastRecordUniqueId)}'`
    : !ingesting &&
        requestedCursor.lastRecordSortValue !== undefined &&
        requestedCursor.lastRecordUniqueId !== undefined
      ? `(applieddate < '${sourceLiteral(requestedCursor.lastRecordSortValue)}' OR (applieddate = '${sourceLiteral(requestedCursor.lastRecordSortValue)}' AND permitnum > '${sourceLiteral(requestedCursor.lastRecordUniqueId)}'))`
      : "";
  const where = [
    baseWhere,
    refreshOrder ? ":updated_at is not null" : "",
    keysetWhere,
  ].filter(Boolean).map((value) => `(${value})`).join(" AND ");
  const params = new URLSearchParams({
    "$select": SEATTLE_PERMIT_SELECT,
    "$order": ingesting
      ? refreshOrder
        ? refreshAfter
          ? ":updated_at ASC, permitnum ASC"
          : offset > 0
            ? "permitnum DESC"
            : ":updated_at DESC, permitnum ASC"
        : "permitnum ASC"
      : "applieddate DESC, permitnum ASC",
    "$limit": String(limit + 1),
    "$offset": "0",
  });
  if (where) params.set("$where", where);
  const fetchedRows = (await (
    await fetchWithTimeout(`${SEATTLE_PERMIT_DATASET}?${params}`)
  ).json()) as SeattlePermitRow[];

  const fetchedPermitIds = uniqueSourceIdentities(
    seattlePermitTemplate.name,
    fetchedRows.map((row) => row.permitnum),
  );
  for (let index = 1; index < fetchedRows.length; index += 1) {
    if (!refreshOrder || offset > 0 && !refreshAfter) continue;
    const previousSort = fetchedRows[index - 1][":updated_at"]?.trim();
    const currentSort = fetchedRows[index][":updated_at"]?.trim();
    if (!previousSort || !currentSort) {
      throw new Error(`${seattlePermitTemplate.name}: refresh row omitted :updated_at.`);
    }
    const comparison = currentSort.localeCompare(previousSort);
    const sortOutOfOrder = refreshAfter ? comparison < 0 : comparison > 0;
    if (
      sortOutOfOrder ||
      (comparison === 0 && fetchedPermitIds[index].localeCompare(fetchedPermitIds[index - 1]) <= 0)
    ) {
      throw new Error(`${seattlePermitTemplate.name}: refresh rows are not deterministically ordered.`);
    }
  }
  if (refreshAfter && fetchedRows[0]) {
    const firstSort = fetchedRows[0][":updated_at"]?.trim();
    if (!firstSort) throw new Error(`${seattlePermitTemplate.name}: refresh row omitted :updated_at.`);
    const comparison = firstSort.localeCompare(String(cursorSort));
    if (
      comparison < 0 ||
      (comparison === 0 && fetchedPermitIds[0].localeCompare(String(cursorId)) <= 0)
    ) {
      throw new Error(`${seattlePermitTemplate.name}: response did not advance the refresh watermark.`);
    }
  }
  const hasMore = fetchedRows.length > limit;
  const rows = fetchedRows.slice(0, limit);
  const permitIds = fetchedPermitIds.slice(0, limit);
  const projects = rows.map((row, index) =>
    mapSeattlePermit({ ...row, permitnum: permitIds[index] }),
  );

  const initialRefreshHead = refreshOrder && !refreshAfter && offset === 0;
  const boundaryRow = initialRefreshHead ? rows[0] : rows.at(-1);
  const boundaryPermitId = initialRefreshHead ? permitIds[0] : permitIds.at(-1);
  const lastRow = boundaryRow;
  if (!ingesting && hasMore && !lastRow?.applieddate) {
    throw new Error(
      `${seattlePermitTemplate.name}: full page omitted the applied-date key required to continue.`,
    );
  }
  const boundarySort = refreshOrder ? boundaryRow?.[":updated_at"]?.trim() : undefined;
  if (refreshOrder && boundaryRow && !boundarySort) {
    throw new Error(`${seattlePermitTemplate.name}: refresh row omitted :updated_at.`);
  }
  const nextCursor: SourceCursorRecord =
    refreshOrder && boundaryPermitId && boundarySort && (initialRefreshHead || refreshAfter)
      ? {
          offset: 0,
          refreshAfter: true,
          lastRecordUniqueId: boundaryPermitId,
          lastRecordSortValue: boundarySort,
        }
      : refreshAfter && !boundaryRow
        ? { ...requestedCursor, offset: 0, refreshAfter: true }
        : hasMore && boundaryPermitId
    ? ingesting
      ? {
          offset: offset + rows.length,
          lastRecordUniqueId: boundaryPermitId,
        }
      : lastRow?.applieddate
        ? {
            offset: offset + rows.length,
            lastRecordUniqueId: boundaryPermitId,
            lastRecordSortValue: lastRow.applieddate,
          }
        : { offset: 0 }
    : { offset: 0 };
  const page: SourcePageRecord = {
    offset,
    recordsRead: rows.length,
    nextOffset: nextCursor.offset,
    hasMore: initialRefreshHead ? false : hasMore,
    currentCursor: requestedCursor,
    nextCursor,
  };
  return {
    projects,
    source: sourceNow(
      seattlePermitTemplate,
      "live",
      sourceReportedTotal,
      `${seattlePermitTemplate.note} ${sourceReportedTotal.toLocaleString("en-US")} ${scopeLabel} records reported; ${projects.length.toLocaleString("en-US")} loaded in this ${mode} run.`,
      projects.length,
      lane === "backfill" && !page.hasMore,
    ),
    page,
  };
}

export interface SourceSearchResult {
  projects: ProjectRecord[];
  sourceReportedMatches: number;
  searchedSourceRecords: number;
  sourceId: string;
}

function socrataSearchLiteral(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function seattleSearchStageWhere(stage: ProjectSearchOptions["stage"]): string {
  const completed =
    "lower(statuscurrent) in ('completed','closed','inspections completed','approved to occupy')";
  const cancelled =
    "lower(statuscurrent) in ('expired','withdrawn','canceled','cancelled','denied')";
  const design = [
    "lower(statuscurrent) like 'additional info%'",
    "lower(statuscurrent) like '%correction%'",
    "lower(statuscurrent) like '%reviews in process%'",
    "lower(statuscurrent) like '%awaiting info%'",
    "lower(statuscurrent) like '%ready for intake%'",
    "lower(statuscurrent) like '%initiated%'",
    "lower(statuscurrent) like '%pending%'",
    "lower(statuscurrent) like '%plan review%'",
  ].join(" OR ");
  const permitting = [
    "issueddate is not null",
    "lower(statuscurrent) like '%issued%'",
    "lower(statuscurrent) like '%ready for issuance%'",
    "lower(statuscurrent) like '%reviews completed%'",
    "lower(statuscurrent) like '%application completed%'",
    "lower(statuscurrent) like '%active%'",
    "lower(statuscurrent) like '%scheduled%'",
  ].join(" OR ");
  const classified = `(${completed}) OR (${cancelled}) OR (${design}) OR (${permitting})`;
  if (stage === "completed") return completed;
  if (stage === "cancelled") return `(${cancelled})`;
  if (stage === "design") return `(${design})`;
  if (stage === "permitting") return `(${permitting})`;
  if (stage === "unclassified") return `statuscurrent is null OR NOT (${classified})`;
  if (stage && stage !== "all") return "1 = 0";
  return "1 = 1";
}

export async function searchSeattlePermitSource(
  options: ProjectSearchOptions,
  limit = 200,
): Promise<SourceSearchResult> {
  const stageWhere = seattleSearchStageWhere(options.stage);
  const sourceTotalParams = new URLSearchParams({
    "$select": "count(*) as count",
    "$where": stageWhere,
  });
  const terms = options.keywords
    .map(socrataSearchLiteral)
    .filter(Boolean)
    .slice(0, 20);
  const effectiveTerms =
    options.match === "phrase" && terms.length > 0 ? [terms.join(" ")] : terms;
  const searchableFields = [
    "description",
    "permittypedesc",
    "permitclassmapped",
    "permittypemapped",
    "contractorcompanyname",
    "zoning",
    "standardplan",
  ];
  const termGroups = effectiveTerms.map(
    (term) =>
      `(${searchableFields.map((field) => `lower(${field}) like '%${term}%'`).join(" OR ")})`,
  );
  const keywordClause = termGroups.join(options.match === "any" ? " OR " : " AND ");
  const location = socrataSearchLiteral(options.location ?? "");
  const locationClause = location
    ? `(${["originaladdress1", "originalcity", "originalstate", "originalzip"]
        .map((field) => `lower(${field}) like '%${location}%'`)
        .join(" OR ")})`
    : "";
  const where = [stageWhere, keywordClause, locationClause]
    .filter(Boolean)
    .map((clause) => `(${clause})`)
    .join(" AND ");

  const countParams = new URLSearchParams({ "$select": "count(*) as count", "$where": where });
  const dataParams = new URLSearchParams({
    "$select": SEATTLE_PERMIT_SELECT,
    "$where": where,
    "$order": "applieddate DESC, permitnum ASC",
    "$limit": String(Math.min(Math.max(limit, 1), 1_000)),
  });
  const [sourceCountRows, matchCountRows, rows] = await Promise.all([
    fetchWithTimeout(`${SEATTLE_PERMIT_DATASET}?${sourceTotalParams}`).then(
      (response) => response.json() as Promise<Array<{ count?: string }>>,
    ),
    fetchWithTimeout(`${SEATTLE_PERMIT_DATASET}?${countParams}`).then(
      (response) => response.json() as Promise<Array<{ count?: string }>>,
    ),
    fetchWithTimeout(`${SEATTLE_PERMIT_DATASET}?${dataParams}`).then(
      (response) => response.json() as Promise<SeattlePermitRow[]>,
    ),
  ]);
  const permitIds = uniqueSourceIdentities(
    seattlePermitTemplate.name,
    rows.map((row) => row.permitnum),
  );

  return {
    projects: rows.map((row, index) =>
      mapSeattlePermit({ ...row, permitnum: permitIds[index] }),
    ),
    sourceReportedMatches: Number(matchCountRows[0]?.count ?? 0),
    searchedSourceRecords: Number(sourceCountRows[0]?.count ?? 0),
    sourceId: seattlePermitTemplate.id,
  };
}

const SEATTLE_PERMIT_SEARCH_UNIVERSE: ProjectSearchOptions = {
  keywords: [],
  match: "all",
  stage: "all",
  state: "WA",
  freshness: "all",
};

export function fetchSeattlePermitSearchUniverse(
  limit = 1_000,
): Promise<SourceSearchResult> {
  return searchSeattlePermitSource(SEATTLE_PERMIT_SEARCH_UNIVERSE, limit);
}

const planningTerms =
  /construction|capital improvement|capital project|development agreement|design|facility|facilities|building|bridge|station|street|sidewalk|sewer|water main|infrastructure|land use|rezon|site plan|public works|transit|housing project|airport|park renovation|contract award/i;

function inferPlanningStage(title: string): ProjectStage {
  if (/contract award|award(?:ing)?\s+(?:of\s+)?(?:a\s+)?contract|authorize\w*\s+.*contract/i.test(title)) {
    return "awarded";
  }
  return /design|architect|engineering|schematic|drawings/i.test(title) ? "design" : "planning";
}

async function fetchLegistarCity(
  client: "seattle" | "sanjose",
  mode: FeedMode,
  requestedCursor: SourceCursorRecord = { offset: 0 },
): Promise<ConnectorResult> {
  const template = cityTemplates[client];
  const offset = normalizedSourceOffset(requestedCursor.offset);
  const matchedRecordsBeforePage = normalizedSourceOffset(requestedCursor.matchedRecords);
  const now = new Date();
  const defaultWindowStart = `${now.getUTCFullYear()}-01-01T00:00:00.000`;
  const windowStart = (sourceCursorDate(requestedCursor.windowStart) ?? new Date(defaultWindowStart))
    .toISOString()
    .replace(/Z$/, "");
  const windowEnd = (sourceCursorDate(requestedCursor.windowEnd) ?? now)
    .toISOString()
    .replace(/Z$/, "");
  const limit = mode === "ingest" ? 50 : 100;
  const params = new URLSearchParams({
    "$filter": `MatterIntroDate ge datetime'${windowStart}' and MatterIntroDate le datetime'${windowEnd}'`,
    "$orderby": "MatterIntroDate desc,MatterId asc",
    "$top": String(limit),
    "$skip": String(offset),
  });
  const endpoint = `https://webapi.legistar.com/v1/${client}/Matters?${params}`;
  const rows = (await (await fetchWithTimeout(endpoint)).json()) as Array<{
    MatterId: number;
    MatterGuid?: string;
    MatterFile?: string;
    MatterTitle?: string;
    MatterStatusName?: string;
    MatterIntroDate?: string;
    MatterLastModifiedUtc?: string;
    MatterRequester?: string;
    MatterBodyName?: string;
  }>;
  const matterIds = uniqueSourceIdentities(
    template.name,
    rows.map((row) => row.MatterId),
  );
  const city = client === "seattle" ? "Seattle" : "San José";
  const state = client === "seattle" ? "WA" : "CA";
  const matchingRows = rows
    .map((row, index) => ({ row, matterId: matterIds[index] }))
    .filter(({ row }) => planningTerms.test(row.MatterTitle ?? ""));
  const projects = matchingRows
    .slice(0, mode === "ingest" ? limit : 12)
    .map<ProjectRecord>(({ row, matterId }) => {
      const title = row.MatterTitle ?? `${city} matter ${row.MatterFile ?? row.MatterId}`;
      const sourceUrl = `https://${client}.legistar.com/LegislationDetail.aspx?ID=${row.MatterId}&GUID=${encodeURIComponent(row.MatterGuid ?? "")}`;
      return {
        id: `${template.id}:${matterId}`,
        sourceId: template.id,
        sourceRecordId: matterId,
        title,
        summary: [row.MatterFile, row.MatterBodyName].filter(Boolean).join(" · "),
        stage: inferPlanningStage(title),
        status: row.MatterStatusName ?? "Introduced",
        agency: row.MatterRequester ?? row.MatterBodyName ?? `City of ${city}`,
        city,
        state,
        postedAt: isoDate(row.MatterIntroDate),
        updatedAt: isoDate(row.MatterLastModifiedUtc) ?? new Date().toISOString(),
        sourceName: template.name,
        sourceUrl,
        provenance: "live-api",
        confidence: "inferred",
        documents: [
          {
            name: "Legislative file & attachments",
            kind: "agenda",
            url: sourceUrl,
            access: "public",
          },
        ],
        participants: participants([
          row.MatterRequester ? { name: row.MatterRequester, role: "agency" } : undefined,
        ]),
      };
    });
  const matchedRecords = matchedRecordsBeforePage + matchingRows.length;
  const hasMore = rows.length >= limit;
  const page: SourcePageRecord = {
    offset,
    recordsRead: rows.length,
    nextOffset: hasMore ? offset + rows.length : 0,
    hasMore,
    currentCursor: {
      ...requestedCursor,
      offset,
      matchedRecords: matchedRecordsBeforePage,
      windowStart,
      windowEnd,
    },
    nextCursor:
      hasMore
        ? { offset: offset + rows.length, matchedRecords, windowStart, windowEnd }
        : { offset: 0 },
  };
  return {
    projects,
    source: sourceNow(
      template,
      "live",
      matchedRecords,
      `${template.note} Read ${rows.length.toLocaleString("en-US")} public matters from source offset ${offset.toLocaleString("en-US")}; ${matchingRows.length.toLocaleString("en-US")} matched on this page and ${matchedRecords.toLocaleString("en-US")} matched across scanned pages.`,
      projects.length,
      !page.hasMore,
    ),
    page,
  };
}

function mmddyyyy(date: Date): string {
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

type SamOpportunityRow = Record<string, unknown>;
type ValidatedSamSearchResponse = {
  rows: SamOpportunityRow[];
  total: number;
  noticeIds: string[];
};

// Keep interactive reuse well inside the source's advertised hourly cadence.
// Cached responses retain the upstream check time instead of pretending that
// every render performed a fresh SAM.gov request.
const SAM_VIEW_CACHE_TTL_MS = 15 * 60 * 1_000;
const SAM_VIEW_CACHE_MAX_ENTRIES = 100;
const samViewCache = new Map<string, {
  expiresAt: number;
  checkedAt: string;
  value: ValidatedSamSearchResponse;
}>();

function samText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return text && text.toLowerCase() !== "null" ? text : undefined;
}

function publicContactEmail(value: unknown): string | undefined {
  const email = samText(value)?.toLowerCase();
  return email && email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
    ? email
    : undefined;
}

function publicContactPhone(value: unknown): string | undefined {
  const phone = samText(value)?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
  if (!phone || phone.length > 80) return undefined;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? phone : undefined;
}

function samHttpsUrl(
  value: unknown,
  allowedHost: (hostname: string) => boolean,
): string | undefined {
  const trusted = trustedHttpsUrl(value, allowedHost);
  if (!trusted) return undefined;
  const url = new URL(trusted);
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === "api_key" || key.toLowerCase() === "apikey") {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

function samDeadline(value: unknown): string | undefined {
  const deadline = samText(value);
  if (!deadline) return undefined;
  // SAM does not publish a source timezone field. Keep deadline buckets honest:
  // only normalize values carrying an explicit UTC/offset designator.
  if (!/(?:z|[+-]\d{2}:?\d{2})$/i.test(deadline)) return undefined;
  return isoDate(deadline);
}

function samOpportunityTypeStage(typeValue: unknown): ProjectStage {
  const type = samText(typeValue)?.toLowerCase() ?? "";
  if (type.includes("award")) return "awarded";
  if (/presolicitation|sources sought|intent to bundle|justification|special notice/.test(type)) {
    return "planning";
  }
  return "bidding";
}

function mapSamOpportunity(
  row: SamOpportunityRow,
  noticeId: string,
  mode: FeedMode,
): ProjectRecord {
  const record = (row.data ?? {}) as Record<string, unknown>;
  const award = (row.award ?? record.award ?? {}) as Record<string, unknown>;
  const awardee = (award.awardee ?? {}) as Record<string, unknown>;
  const placeOfPerformance = (row.placeOfPerformance ?? record.placeOfPerformance ?? {}) as Record<
    string,
    unknown
  >;
  const cityRecord = (placeOfPerformance.city ?? {}) as Record<string, unknown>;
  const stateRecord = (placeOfPerformance.state ?? {}) as Record<string, unknown>;
  const activeValue = row.active;
  const normalizedActive =
    typeof activeValue === "boolean"
      ? activeValue
      : /^(yes|y|true|active)$/i.test(String(activeValue ?? "").trim())
        ? true
        : /^(no|n|false|inactive|closed)$/i.test(String(activeValue ?? "").trim())
          ? false
          : undefined;
  const noticeStage = samOpportunityTypeStage(row.type);
  // The project schema has no separate archived-publication stage yet. Keep
  // inactive pre-award records out of actionable search, while the status and
  // summary explicitly avoid claiming the physical project was cancelled.
  const stage: ProjectStage =
    normalizedActive === false && noticeStage !== "awarded" ? "cancelled" : noticeStage;
  const sourceUrl = `https://sam.gov/opp/${encodeURIComponent(noticeId)}/view`;
  const samHost = (hostname: string) => hostname === "sam.gov" || hostname.endsWith(".sam.gov");
  const resourceCount = (Array.isArray(row.resourceLinks) ? row.resourceLinks : []).filter(
    (value) => Boolean(samHttpsUrl(value, samHost)),
  ).length;
  const descriptionAvailable = Boolean(samHttpsUrl(row.description, samHost));
  const additionalInfoUrl = samHttpsUrl(
    row.additionalInfoLink,
    (hostname) => hostname.endsWith(".gov") || hostname.endsWith(".mil"),
  );
  const agency =
    samText(row.fullParentPathName) ?? samText(row.organizationName) ?? "Federal agency";
  const pointOfContact = [
    ...(Array.isArray(record.pointOfContact) ? record.pointOfContact : []),
    ...(Array.isArray(row.pointOfContact) ? row.pointOfContact : []),
  ].filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"));
  const contactParticipants = pointOfContact.flatMap<ProjectParticipant>((contact) => {
    const name = samText(contact.fullName ?? contact.fullname);
    const email = publicContactEmail(contact.email);
    const phone = publicContactPhone(contact.phone);
    if (!name && !email && !phone) return [];
    return [{
      name: name ?? email ?? phone!,
      role: "agency",
      participantType: "person",
      organization: agency,
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      sourceUrl,
    }];
  });
  const type = samText(row.type) ?? "Published notice";
  const solicitationNumber = samText(row.solicitationNumber);
  const inactiveNote = normalizedActive === false && noticeStage !== "awarded"
    ? "SAM publication inactive/archived; physical-project cancellation is not established"
    : undefined;
  const documents = [
    {
      name: "SAM.gov notice",
      kind: (noticeStage === "awarded" ? "award" : "source-record") as ProjectDocument["kind"],
      url: sourceUrl,
      access: "public" as const,
      indexStatus: "metadata-only" as const,
    },
    ...(descriptionAvailable
      ? [{
          name: "SAM.gov notice description",
          // A notice description can contain scope, but is not itself proof
          // that the agency published contract specifications.
          kind: "source-record" as const,
          url: `/api/sam/opportunities/${encodeURIComponent(noticeId)}/description`,
          access: "free-account" as const,
          indexStatus: "account-gated" as const,
        }]
      : []),
    ...Array.from({ length: Math.min(resourceCount, mode === "ingest" ? 25 : 12) }, (_, index) => ({
      name: `SAM.gov source-provided attachment ${index + 1}`,
      kind: "source-record" as const,
      url: `/api/sam/opportunities/${encodeURIComponent(noticeId)}/resources/${index}`,
      access: "free-account" as const,
      indexStatus: "account-gated" as const,
    })),
    ...(additionalInfoUrl
      ? [{
          name: "SAM.gov additional information portal",
          kind: "source-record" as const,
          url: additionalInfoUrl,
          access: "free-account" as const,
          indexStatus: "account-gated" as const,
        }]
      : []),
  ];
  return {
    id: `${samTemplate.id}:${noticeId}`,
    sourceId: samTemplate.id,
    sourceRecordId: noticeId,
    title: samText(row.title) ?? `SAM.gov opportunity ${noticeId}`,
    summary: [
      solicitationNumber,
      type,
      samText(row.typeOfSetAsideDescription ?? row.setAside),
      samText(row.naicsCode),
      inactiveNote,
    ].filter(Boolean).join(" · ") || "Federal contract opportunity",
    stage,
    status:
      normalizedActive === true
        ? `Active · ${type}`
        : normalizedActive === false
          ? `Inactive/archived · ${type}`
          : type,
    agency,
    address: samText(placeOfPerformance.streetAddress),
    city:
      typeof placeOfPerformance.city === "string"
        ? samText(placeOfPerformance.city)
        : samText(cityRecord.name),
    state:
      typeof placeOfPerformance.state === "string"
        ? samText(placeOfPerformance.state)
        : samText(stateRecord.code ?? stateRecord.name),
    postalCode: samText(placeOfPerformance.zip ?? placeOfPerformance.zipcode),
    value: parseMoney(award.amount as string | number | undefined),
    postedAt: isoDate(samText(row.postedDate)),
    bidDate: samDeadline(row.responseDeadLine ?? row.reponseDeadLine),
    updatedAt: isoDate(samText(row.postedDate)) ?? new Date(0).toISOString(),
    sourceName: samTemplate.name,
    sourceUrl,
    provenance: "live-api",
    confidence: "official",
    documents,
    participants: participants([
      ...contactParticipants,
      awardee.name
        ? {
            name: String(awardee.name),
            role: "contractor",
            participantType: "organization",
            organization: String(awardee.name),
            sourceUrl,
          }
        : undefined,
    ]),
    searchableFields: [
      solicitationNumber,
      type,
      samText(row.baseType),
      samText(row.typeOfSetAsideDescription ?? row.setAside),
      samText(row.typeOfSetAside ?? row.setAsideCode),
      samText(row.naicsCode),
      samText(row.classificationCode),
      samText(row.fullParentPathCode),
      samText(row.archiveType),
      samText(row.responseDeadLine ?? row.reponseDeadLine),
      ...pointOfContact.flatMap((contact) => [
        samText(contact.type),
        samText(contact.title),
        samText(contact.fullName ?? contact.fullname),
        publicContactEmail(contact.email),
        publicContactPhone(contact.phone),
      ]),
    ].filter((value): value is string => Boolean(value)),
    documentTextIndexed: false,
  };
}

function validateSamSearchResponse(
  value: unknown,
  limit: number,
): ValidatedSamSearchResponse {
  const data = value as {
    opportunitiesData?: SamOpportunityRow[];
    totalRecords?: number | string | null;
  };
  const total = Number(data?.totalRecords);
  if (
    data?.totalRecords === undefined ||
    data.totalRecords === null ||
    !Number.isInteger(total) ||
    total < 0
  ) {
    throw new Error(`${samTemplate.name}: response omitted a valid totalRecords value.`);
  }
  if (!Array.isArray(data.opportunitiesData)) {
    throw new Error(`${samTemplate.name}: response omitted the opportunitiesData array.`);
  }
  if (data.opportunitiesData.length > limit) {
    throw new Error(`${samTemplate.name}: response exceeded the requested page limit.`);
  }
  return {
    rows: data.opportunitiesData,
    total,
    noticeIds: uniqueSourceIdentities(
      samTemplate.name,
      data.opportunitiesData.map((row) => row.noticeId),
    ),
  };
}

async function samViewCacheKey(
  apiKey: string,
  windowStart: string,
  windowEnd: string,
  offset: number,
  limit: number,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${apiKey}\u0000${windowStart}\u0000${windowEnd}\u0000${offset}\u0000${limit}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function fetchSamSearchResponse(
  endpoint: string,
  apiKey: string,
  mode: FeedMode,
  windowStart: string,
  windowEnd: string,
  offset: number,
  limit: number,
): Promise<{ value: ValidatedSamSearchResponse; checkedAt: string }> {
  if (mode !== "view") {
    return {
      value: validateSamSearchResponse(
        await (await fetchWithTimeout(endpoint)).json(),
        limit,
      ),
      checkedAt: new Date().toISOString(),
    };
  }
  const now = Date.now();
  for (const [key, entry] of samViewCache) {
    if (entry.expiresAt <= now) samViewCache.delete(key);
  }
  const cacheKey = await samViewCacheKey(apiKey, windowStart, windowEnd, offset, limit);
  const cached = samViewCache.get(cacheKey);
  if (cached?.expiresAt && cached.expiresAt > now) {
    return { value: cached.value, checkedAt: cached.checkedAt };
  }
  const value = validateSamSearchResponse(
    await (await fetchWithTimeout(endpoint)).json(),
    limit,
  );
  if (samViewCache.size >= SAM_VIEW_CACHE_MAX_ENTRIES) {
    const oldestKey = samViewCache.keys().next().value as string | undefined;
    if (oldestKey) samViewCache.delete(oldestKey);
  }
  const checkedAt = new Date(now).toISOString();
  samViewCache.set(cacheKey, {
    expiresAt: now + SAM_VIEW_CACHE_TTL_MS,
    checkedAt,
    value,
  });
  return { value, checkedAt };
}

async function fetchSamOpportunities(
  mode: FeedMode,
  apiKeyOverride?: string,
  requestedCursor: SourceCursorRecord = { offset: 0 },
): Promise<ConnectorResult> {
  const offset = normalizedSourceOffset(requestedCursor.offset);
  const apiKey = apiKeyOverride ?? process.env.SAM_API_KEY;
  if (!apiKey) {
    return {
      projects: [],
      source: sourceNow(
        samTemplate,
        "credential-required",
        0,
        "Connector is ready. Add a free SAM.gov public API key to ingest solicitations and attachment links.",
      ),
      page: {
        offset,
        recordsRead: 0,
        nextOffset: offset,
        hasMore: false,
        currentCursor: requestedCursor,
        nextCursor: requestedCursor,
      },
    };
  }
  const end = sourceCursorDate(requestedCursor.windowEnd) ?? new Date();
  const start = sourceCursorDate(requestedCursor.windowStart) ?? new Date(end);
  if (!requestedCursor.windowStart) start.setUTCDate(start.getUTCDate() - 365);
  const windowStart = start.toISOString().slice(0, 10);
  const windowEnd = end.toISOString().slice(0, 10);
  const limit = mode === "ingest" ? 10 : 250;
  const params = new URLSearchParams({
    api_key: apiKey,
    postedFrom: mmddyyyy(new Date(windowStart)),
    postedTo: mmddyyyy(new Date(windowEnd)),
    ncode: "23",
    limit: String(limit),
    offset: String(offset),
  });
  ["p", "o", "k", "r", "a", "s", "i", "u"].forEach((type) =>
    params.append("ptype", type),
  );
  const endpoint = `https://api.sam.gov/opportunities/v2/search?${params}`;
  const samSearch = await fetchSamSearchResponse(
    endpoint,
    apiKey,
    mode,
    windowStart,
    windowEnd,
    offset,
    limit,
  );
  const response = samSearch.value;
  const sourceReportedTotal = response.total;
  const opportunityRows = response.rows;
  const noticeIds = response.noticeIds;
  // totalRecords changes as opportunities are updated or archived. Continue
  // only from a full page and treat a short (including empty) page as terminal;
  // this keeps traversal safe without comparing a later count to an old page.

  const projects = opportunityRows.map<ProjectRecord>((row, index) =>
    mapSamOpportunity(row, noticeIds[index], mode),
  );
  const hasMore = opportunityRows.length === limit;
  const page: SourcePageRecord = {
    offset,
    recordsRead: opportunityRows.length,
    nextOffset: hasMore ? offset + 1 : 0,
    hasMore,
    currentCursor: { ...requestedCursor, offset, windowStart, windowEnd },
    nextCursor: hasMore
      ? { offset: offset + 1, windowStart, windowEnd }
      : { offset: 0 },
  };
  const source = sourceNow(
    samTemplate,
    "live",
    sourceReportedTotal,
    `${samTemplate.note} ${sourceReportedTotal.toLocaleString("en-US")} matching notices reported; ${projects.length.toLocaleString("en-US")} loaded in this ${mode} run.`,
    projects.length,
    !page.hasMore,
  );
  source.lastChecked = samSearch.checkedAt;
  return {
    projects,
    source,
    page,
  };
}

function normalizedSamNoticeId(projectIdOrNoticeId: string): string | undefined {
  const value = projectIdOrNoticeId.trim();
  const prefix = `${samTemplate.id}:`;
  if (value.includes(":") && !value.startsWith(prefix)) return undefined;
  const noticeId = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return /^[A-Za-z0-9-]{8,100}$/.test(noticeId) ? noticeId : undefined;
}

async function fetchExactSamOpportunityRow(
  projectIdOrNoticeId: string,
  apiKey: string,
): Promise<{ row: SamOpportunityRow; noticeId: string } | null> {
  const noticeId = normalizedSamNoticeId(projectIdOrNoticeId);
  if (!noticeId) return null;
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 365);
  const params = new URLSearchParams({
    api_key: apiKey,
    postedFrom: mmddyyyy(start),
    postedTo: mmddyyyy(end),
    noticeid: noticeId,
    limit: "2",
    offset: "0",
  });
  const response = validateSamSearchResponse(
    await (
      await fetchWithTimeout(`https://api.sam.gov/opportunities/v2/search?${params}`)
    ).json(),
    2,
  );
  const exact = response.rows.filter(
    (row) => samText(row.noticeId) === noticeId,
  );
  if (exact.length === 0) return null;
  if (exact.length !== 1) {
    throw new Error(`${samTemplate.name}: exact notice lookup was ambiguous.`);
  }
  return { row: exact[0], noticeId };
}

export async function lookupSamOpportunityProject(
  projectIdOrNoticeId: string,
  apiKey: string,
): Promise<ProjectRecord | null> {
  const exact = await fetchExactSamOpportunityRow(projectIdOrNoticeId, apiKey);
  return exact ? mapSamOpportunity(exact.row, exact.noticeId, "view") : null;
}

export async function resolveSamOpportunityResourceUrl(
  projectIdOrNoticeId: string,
  resourceIndex: number,
  apiKey: string,
): Promise<string | null> {
  if (!Number.isSafeInteger(resourceIndex) || resourceIndex < 0 || resourceIndex > 99) {
    return null;
  }
  const exact = await fetchExactSamOpportunityRow(projectIdOrNoticeId, apiKey);
  if (!exact) return null;
  const links = Array.isArray(exact.row.resourceLinks) ? exact.row.resourceLinks : [];
  const samHost = (hostname: string) => hostname === "sam.gov" || hostname.endsWith(".sam.gov");
  const safeLinks = links.flatMap((value) => samHttpsUrl(value, samHost) ?? []);
  return safeLinks[resourceIndex] ?? null;
}

export async function resolveSamOpportunityDescriptionUrl(
  projectIdOrNoticeId: string,
  apiKey: string,
): Promise<string | null> {
  const exact = await fetchExactSamOpportunityRow(projectIdOrNoticeId, apiKey);
  if (!exact) return null;
  const samHost = (hostname: string) => hostname === "sam.gov" || hostname.endsWith(".sam.gov");
  return samHttpsUrl(exact.row.description, samHost) ?? null;
}

async function buildProjectFeed(options: FeedOptions = {}): Promise<ProjectFeed> {
  const mode = options.mode ?? "view";
  const lane = options.lane ?? "backfill";
  const cursorFor = (sourceId: string): SourceCursorRecord =>
    options.sourceCursors?.[sourceId] ?? { offset: 0 };
  const connectors: Array<{ template: SourceTemplate; run: () => Promise<ConnectorResult> }> = [
    {
      template: permittingTemplate,
      run: () => fetchPermittingProjects(mode, cursorFor(permittingTemplate.id), lane),
    },
    {
      template: usaSpendingTemplate,
      run: () => fetchUsaSpendingAwards(mode, cursorFor(usaSpendingTemplate.id)),
    },
    { template: caltransTemplate, run: () => fetchCaltransProjects(mode) },
    {
      template: seattlePermitTemplate,
      run: () => fetchSeattlePermits(mode, cursorFor(seattlePermitTemplate.id), lane),
    },
    {
      template: cityTemplates.seattle,
      run: () =>
        fetchLegistarCity("seattle", mode, cursorFor(cityTemplates.seattle.id)),
    },
    {
      template: cityTemplates.sanjose,
      run: () =>
        fetchLegistarCity("sanjose", mode, cursorFor(cityTemplates.sanjose.id)),
    },
    {
      template: samTemplate,
      run: () =>
        fetchSamOpportunities(mode, options.samApiKey, cursorFor(samTemplate.id)),
    },
    ...SOCRATA_CITY_SOURCE_IDS.map((sourceId) => ({
      template: SOCRATA_CITY_SOURCE_TEMPLATES[sourceId],
      run: () =>
        fetchSocrataCitySource(sourceId, {
          mode,
          lane,
          sourceId,
          sourceCursors: options.sourceCursors,
        }),
    })),
    ...STANDARDIZED_SOURCE_IDS.map((sourceId) => ({
      template: STANDARDIZED_SOURCE_TEMPLATES[sourceId],
      run: () =>
        fetchStandardizedSource(sourceId, {
          mode,
          lane,
          sourceId,
          sourceCursors: options.sourceCursors,
        }),
    })),
    ...PUBLIC_DOT_SOURCE_IDS.map((sourceId) => ({
      template: PUBLIC_DOT_SOURCE_TEMPLATES[sourceId],
      run: () =>
        fetchPublicDotSource(sourceId, {
          mode,
          lane,
          sourceId,
          sourceCursors: options.sourceCursors,
        }),
    })),
  ].filter((connector) => !options.sourceId || connector.template.id === options.sourceId);
  const settled = await Promise.allSettled(connectors.map((connector) => connector.run()));
  const projects: ProjectRecord[] = [];
  const sources: SourceRecord[] = [censusRegistry];
  const sourcePages: Record<string, SourcePageRecord> = {};
  const warnings: string[] = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      projects.push(...result.value.projects);
      sources.push(result.value.source);
      sourcePages[result.value.source.id] = result.value.page;
      return;
    }
    const template = connectors[index].template;
    const message = result.reason instanceof Error ? result.reason.message : "Unknown connector error";
    warnings.push(`${template.name}: ${message}`);
    sources.push(
      sourceNow(template, "degraded", 0, `${template.note} Last check failed; the next scheduled run will retry.`),
    );
  });

  const stageRank: Record<ProjectStage, number> = {
    bidding: 0,
    "bid-opened": 1,
    design: 2,
    planning: 3,
    permitting: 4,
    awarded: 5,
    construction: 6,
    completed: 7,
    cancelled: 8,
    unclassified: 9,
  };
  if (mode === "view") {
    projects.sort((a, b) => {
      const stageDifference = stageRank[a.stage] - stageRank[b.stage];
      if (stageDifference !== 0) return stageDifference;
      const leftDate = a.bidDate ?? a.postedAt ?? a.updatedAt ?? "";
      const rightDate = b.bidDate ?? b.postedAt ?? b.updatedAt ?? "";
      return rightDate.localeCompare(leftDate) || a.id.localeCompare(b.id);
    });
  }

  const generatedAt = new Date().toISOString();
  return {
    generatedAt,
    projects,
    sources,
    sourcePages,
    warnings,
    coverage: buildCoverageSummary(projects, sources, generatedAt),
  };
}

const ANONYMOUS_VIEW_FEED_TTL_MS = 5 * 60 * 1_000;
const ANONYMOUS_VIEW_FEED_FAILURE_TTL_MS = 60 * 1_000;
const ANONYMOUS_VIEW_FEED_CACHE_KEY = Symbol.for(
  "bidatlas.anonymous-view-feed-cache.v1",
);
type AnonymousViewFeedCache = {
  expiresAt: number;
  promise: Promise<ProjectFeed>;
};
const anonymousViewFeedGlobal = globalThis as typeof globalThis & {
  [key: symbol]: unknown;
};
let anonymousViewFeedCache = anonymousViewFeedGlobal[
  ANONYMOUS_VIEW_FEED_CACHE_KEY
] as AnonymousViewFeedCache | undefined;
/**
 * Share one bounded anonymous view snapshot across concurrent pages. Search,
 * dashboard, and Bid Desk often render together; issuing every upstream
 * connector again for each page can trigger rate limits and produce different
 * totals for adjacent pages. Ingestion, source-specific runs, cursor runs, and
 * credentialed SAM views always bypass this short-lived cache.
 */
export function getProjectFeed(options: FeedOptions = {}): Promise<ProjectFeed> {
  const cacheable =
    (options.mode ?? "view") === "view" &&
    (options.lane ?? "backfill") === "backfill" &&
    !options.sourceId &&
    !options.samApiKey &&
    !options.sourceCursors;
  if (!cacheable) return buildProjectFeed(options);

  const sharedCache = anonymousViewFeedGlobal[
    ANONYMOUS_VIEW_FEED_CACHE_KEY
  ] as AnonymousViewFeedCache | undefined;
  if (sharedCache) anonymousViewFeedCache = sharedCache;
  const now = Date.now();
  if (anonymousViewFeedCache && anonymousViewFeedCache.expiresAt > now) {
    return anonymousViewFeedCache.promise;
  }
  const promise = buildProjectFeed(options);
  const snapshot: AnonymousViewFeedCache = {
    expiresAt: Number.POSITIVE_INFINITY,
    promise,
  };
  anonymousViewFeedCache = snapshot;
  anonymousViewFeedGlobal[ANONYMOUS_VIEW_FEED_CACHE_KEY] = snapshot;
  void promise.then(
    () => {
      if (anonymousViewFeedGlobal[ANONYMOUS_VIEW_FEED_CACHE_KEY] === snapshot) {
        snapshot.expiresAt = Date.now() + ANONYMOUS_VIEW_FEED_TTL_MS;
      }
    },
    () => {
      if (anonymousViewFeedGlobal[ANONYMOUS_VIEW_FEED_CACHE_KEY] === snapshot) {
        snapshot.expiresAt = Date.now() + ANONYMOUS_VIEW_FEED_FAILURE_TTL_MS;
      }
    },
  );
  return promise;
}
