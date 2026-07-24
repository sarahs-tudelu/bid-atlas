import { unzlibSync } from "fflate";

import type {
  ProjectDocument,
  ProjectParticipant,
  ProjectRecord,
  ProjectStage,
  SourcePageRecord,
  SourceRecord,
} from "./types";
import type {
  PublicDotConnectorResult,
  PublicDotFeedOptions,
  PublicDotSourceTemplate,
} from "./public-dot-connectors";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_PDF_STREAM_BYTES = 12 * 1024 * 1024;
const VIEW_LIMIT = 20;
const INGEST_LIMIT = 50;

const MASSDOT_STATUS_URL =
  "https://hwy.massdot.state.ma.us/webapps/const/statusReport.asp";
const MASSDOT_BID_EXPRESS_URL = "https://www.bidx.com/ma/main";
const DELDOT_BIDS_URL = "https://mmp.delaware.gov/Bids/";
const DELDOT_OPEN_BIDS_URL =
  "https://mmp.delaware.gov/Bids/GetBids?status=Open";
const MARYLAND_SHA_SCHEDULE_URL =
  "https://roads.maryland.gov/mdotsha/Pages/PrintFriendlyRpt.aspx";
const MARYLAND_BIDX_URL = "https://www.bidx.com/md/main";
const SCDOT_LETTINGS_URL =
  "https://info2.scdot.org/currentletting/Pages/default.aspx";
const SCDOT_BIDX_URL = "https://www.bidx.com/sc/main";
const GDOT_SCHEDULE_URL =
  "https://www.dot.ga.gov/PartnerSmart/Business/Documents/Contractor/2026LettingSchedule.pdf";
const GDOT_BIDX_URL = "https://www.bidx.com/ga/main";
const DDOT_SOLICITATIONS_URL =
  "https://dtap.ddot.dc.gov/Project/Solicitation";
const DDOT_OPEN_SOLICITATIONS_URL =
  "https://dtap.ddot.dc.gov/Project/SolicitationOpenLocationsRead?page=1&pageSize=100";

export const EAST_COAST_DOT_SOURCE_IDS = [
  "massachusetts-dot-advertised-projects",
  "delaware-dot-open-solicitations",
  "maryland-sha-contract-advertising-schedule",
  "south-carolina-dot-construction-lettings",
  "georgia-dot-construction-letting-calendar",
  "district-dot-open-solicitations",
] as const;

export type EastCoastDotSourceId =
  (typeof EAST_COAST_DOT_SOURCE_IDS)[number];

export const EAST_COAST_DOT_SOURCE_TEMPLATES: Record<
  EastCoastDotSourceId,
  PublicDotSourceTemplate
> = {
  "massachusetts-dot-advertised-projects": {
    id: "massachusetts-dot-advertised-projects",
    name: "MassDOT Advertised Projects",
    owner: "Massachusetts Department of Transportation",
    level: "state",
    sourceClass: "procurement",
    stages: ["bidding"],
    access: "open",
    cadence: "Daily",
    url: MASSDOT_STATUS_URL,
    jurisdiction: "Massachusetts",
    stateCode: "MA",
    coverageField: "dotBidding",
    note: "Official advertised construction schedule with project numbers, locations, scopes, values, advertisement dates, bid openings, and plan-availability flags. Plans and specifications require a free Bid Express account and applicable MassDOT qualification.",
  },
  "delaware-dot-open-solicitations": {
    id: "delaware-dot-open-solicitations",
    name: "DelDOT Open Solicitations",
    owner: "Delaware Department of Transportation",
    level: "state",
    sourceClass: "procurement",
    stages: ["bidding"],
    access: "open",
    cadence: "Daily",
    url: DELDOT_BIDS_URL,
    jurisdiction: "Delaware",
    stateCode: "DE",
    coverageField: "dotBidding",
    note: "Official Delaware open-bid directory filtered to DelDOT, joined to public proposals, plans, referenced documents, addenda, and solicitation contacts.",
  },
  "maryland-sha-contract-advertising-schedule": {
    id: "maryland-sha-contract-advertising-schedule",
    name: "Maryland SHA Contract Advertising Schedule",
    owner: "Maryland State Highway Administration",
    level: "state",
    sourceClass: "procurement",
    stages: ["planning", "bidding"],
    access: "open",
    cadence: "Daily",
    url: MARYLAND_SHA_SCHEDULE_URL,
    jurisdiction: "Maryland",
    stateCode: "MD",
    coverageField: "dotBidding",
    note: "Official project-level contract advertising schedule with advertisement, bid, notice-to-proceed, work-type, route, and cost-class fields. Bid packages are available through a free Bid Express account.",
  },
  "south-carolina-dot-construction-lettings": {
    id: "south-carolina-dot-construction-lettings",
    name: "SCDOT Construction Lettings",
    owner: "South Carolina Department of Transportation",
    level: "state",
    sourceClass: "procurement",
    stages: ["planning", "bidding"],
    access: "open",
    cadence: "Daily",
    url: SCDOT_LETTINGS_URL,
    jurisdiction: "South Carolina",
    stateCode: "SC",
    coverageField: "dotBidding",
    note: "Official current and advance letting notices parsed into project records with file numbers, counties, PCNs, descriptions, and letting dates. Plans and proposal packages require SCDOT Extranet or a free Bid Express account.",
  },
  "georgia-dot-construction-letting-calendar": {
    id: "georgia-dot-construction-letting-calendar",
    name: "GDOT Construction Letting Calendar",
    owner: "Georgia Department of Transportation",
    level: "state",
    sourceClass: "procurement",
    stages: ["planning", "bidding"],
    access: "open",
    cadence: "Daily",
    url: GDOT_SCHEDULE_URL,
    jurisdiction: "Georgia",
    stateCode: "GA",
    coverageField: "dotBidding",
    note: "Official 2026 construction letting calendar with advertisement and letting dates. This is calendar-level coverage because GDOT's project proposal dashboard and Bid Express packages require an account.",
  },
  "district-dot-open-solicitations": {
    id: "district-dot-open-solicitations",
    name: "DDOT Open Solicitations",
    owner: "District Department of Transportation",
    level: "state",
    sourceClass: "procurement",
    stages: ["bidding"],
    access: "open",
    cadence: "Daily",
    url: DDOT_SOLICITATIONS_URL,
    jurisdiction: "District of Columbia",
    stateCode: "DC",
    coverageField: "dotBidding",
    note: "Official public DTAP solicitation records currently designated OPEN by DDOT. DTAP does not publish response deadlines in this dataset and retains some older records with an OPEN designation.",
  },
};

interface EastCoastSourceDefinition {
  template: PublicDotSourceTemplate;
  allowedHosts: readonly string[];
  timeZone: ProjectRecord["bidDateTimeZone"];
}

const SOURCE_DEFINITIONS: Record<
  EastCoastDotSourceId,
  EastCoastSourceDefinition
> = {
  "massachusetts-dot-advertised-projects": {
    template:
      EAST_COAST_DOT_SOURCE_TEMPLATES[
        "massachusetts-dot-advertised-projects"
      ],
    allowedHosts: [
      "hwy.massdot.state.ma.us",
      "mass.gov",
      "www.mass.gov",
      "bidx.com",
      "www.bidx.com",
    ],
    timeZone: "America/New_York",
  },
  "delaware-dot-open-solicitations": {
    template:
      EAST_COAST_DOT_SOURCE_TEMPLATES["delaware-dot-open-solicitations"],
    allowedHosts: [
      "mmp.delaware.gov",
      "gssdocs.deldot.delaware.gov",
      "bidcondocs.delaware.gov",
    ],
    timeZone: "America/New_York",
  },
  "maryland-sha-contract-advertising-schedule": {
    template:
      EAST_COAST_DOT_SOURCE_TEMPLATES[
        "maryland-sha-contract-advertising-schedule"
      ],
    allowedHosts: [
      "roads.maryland.gov",
      "bidx.com",
      "www.bidx.com",
    ],
    timeZone: "America/New_York",
  },
  "south-carolina-dot-construction-lettings": {
    template:
      EAST_COAST_DOT_SOURCE_TEMPLATES[
        "south-carolina-dot-construction-lettings"
      ],
    allowedHosts: [
      "info2.scdot.org",
      "scdot.org",
      "www.scdot.org",
      "bidx.com",
      "www.bidx.com",
    ],
    timeZone: "America/New_York",
  },
  "georgia-dot-construction-letting-calendar": {
    template:
      EAST_COAST_DOT_SOURCE_TEMPLATES[
        "georgia-dot-construction-letting-calendar"
      ],
    allowedHosts: [
      "dot.ga.gov",
      "www.dot.ga.gov",
      "bidx.com",
      "www.bidx.com",
    ],
    timeZone: "America/New_York",
  },
  "district-dot-open-solicitations": {
    template:
      EAST_COAST_DOT_SOURCE_TEMPLATES["district-dot-open-solicitations"],
    allowedHosts: ["dtap.ddot.dc.gov", "ocp.dc.gov", "www.ocp.dc.gov"],
    timeZone: "America/New_York",
  },
};

interface Candidate {
  recordId: string;
  title: string;
  summary: string;
  status: string;
  sourceUrl: string;
  stage?: ProjectStage;
  bidDate?: string;
  postedAt?: string;
  city?: string;
  county?: string;
  value?: number;
  documents?: ProjectDocument[];
  participants?: ProjectParticipant[];
  searchTerms?: string[];
  provenance?: ProjectRecord["provenance"];
}

interface DelawareBidRow {
  Id?: number;
  Title?: string;
  ContractNumber?: string;
  OpenDate?: string;
  DeadlineDate?: string;
  DeadlineTime?: string;
  AgencyCode?: string;
  ContactEmail?: string;
  BidUnspscCodesString?: string;
}

interface DdotSolicitation {
  RequestId?: number;
  RequestIdEncoded?: string;
  SolicitationNumber?: string;
  SolicitationNumberEncoded?: string;
  BidStatus?: string;
  SOWTitle?: string;
  ProjectPhase?: string;
  IsAvailableToPublic?: boolean;
  DesignationType?: string;
  ProjectName?: string;
  ProjectDescription?: string;
  ProjectScope?: string;
  Location?: string;
  SourceUrl?: string;
  RequestForInfoEmail?: string;
  RequestForCFPInfoEmail?: string;
  LastUpdatedDate?: string;
  Amount?: number;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    );
}

function plainText(value: string): string {
  return decodeHtml(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function hostAllowed(
  hostname: string,
  allowedHosts: readonly string[],
): boolean {
  const normalized = hostname.toLowerCase();
  return allowedHosts.some(
    (host) => normalized === host || normalized.endsWith(`.${host}`),
  );
}

function officialUrl(
  rawUrl: string,
  baseUrl: string,
  allowedHosts: readonly string[],
): string | undefined {
  try {
    const url = new URL(decodeHtml(rawUrl.trim()), baseUrl);
    if (
      url.protocol !== "https:" ||
      !hostAllowed(url.hostname, allowedHosts)
    ) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function responseByteLimit(options: PublicDotFeedOptions): number {
  const requested = options.maxBinaryBytes ?? MAX_RESPONSE_BYTES;
  return Math.max(1, Math.min(MAX_RESPONSE_BYTES, requested));
}

async function fetchOfficialResponse(
  initialUrl: string,
  definition: EastCoastSourceDefinition,
  options: PublicDotFeedOptions,
  init: RequestInit = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let currentUrl = initialUrl;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const safeUrl = officialUrl(
      currentUrl,
      definition.template.url,
      definition.allowedHosts,
    );
    if (!safeUrl) throw new Error(`Refused non-official URL: ${currentUrl}`);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetchImpl(safeUrl, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`HTTP ${response.status} without a redirect location`);
      }
      currentUrl = new URL(location, safeUrl).toString();
      continue;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${safeUrl}`);
    }
    if (
      response.url &&
      !officialUrl(response.url, safeUrl, definition.allowedHosts)
    ) {
      throw new Error(`Upstream redirected outside official hosts`);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > responseByteLimit(options)
    ) {
      throw new Error(`Official response exceeded the guarded byte limit`);
    }
    return response;
  }
  throw new Error(`Too many redirects from ${initialUrl}`);
}

async function fetchBytes(
  url: string,
  definition: EastCoastSourceDefinition,
  options: PublicDotFeedOptions,
  init: RequestInit = {},
): Promise<Uint8Array> {
  const response = await fetchOfficialResponse(url, definition, options, init);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > responseByteLimit(options)) {
    throw new Error(`Official response exceeded the guarded byte limit`);
  }
  return bytes;
}

async function fetchText(
  url: string,
  definition: EastCoastSourceDefinition,
  options: PublicDotFeedOptions,
  init: RequestInit = {},
): Promise<string> {
  return new TextDecoder().decode(
    await fetchBytes(url, definition, options, init),
  );
}

async function fetchJson<T>(
  url: string,
  definition: EastCoastSourceDefinition,
  options: PublicDotFeedOptions,
  init: RequestInit = {},
): Promise<T> {
  const text = await fetchText(url, definition, options, init);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Official endpoint returned invalid JSON`);
  }
}

function dateOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = value
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!us) return undefined;
  return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
}

function calendarDateInNewYork(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

function endOfDay(value: string | undefined): string | undefined {
  const normalized = dateOnly(value);
  return normalized ? `${normalized}T23:59:00` : undefined;
}

function massDeadline(value: string): string | undefined {
  const match = value.match(
    /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i,
  );
  if (!match) return endOfDay(value);
  let hour = Number(match[4]);
  if (match[6].toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (match[6].toUpperCase() === "AM" && hour === 12) hour = 0;
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(
    2,
    "0",
  )}T${String(hour).padStart(2, "0")}:${match[5]}:00`;
}

function isCurrent(
  bidDate: string | undefined,
  now: Date,
): bidDate is string {
  return Boolean(
    bidDate &&
      bidDate.slice(0, 10) >= calendarDateInNewYork(now),
  );
}

function numericValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function uniqueDocuments(
  documents: readonly ProjectDocument[],
): ProjectDocument[] {
  const seen = new Set<string>();
  return documents.filter((document) => {
    const key = `${document.kind}:${document.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceRecordDocument(sourceUrl: string): ProjectDocument {
  return {
    name: "Official project record",
    kind: "source-record",
    url: sourceUrl,
    access: "public",
    indexStatus: "metadata-only",
  };
}

function hasPlans(candidate: Candidate): boolean {
  return Boolean(
    candidate.documents?.some((document) => document.kind === "plans"),
  );
}

function sortCandidates(candidates: Candidate[]): Candidate[] {
  return candidates.sort(
    (left, right) =>
      Number(hasPlans(right)) - Number(hasPlans(left)) ||
      (left.bidDate ?? "9999").localeCompare(right.bidDate ?? "9999") ||
      left.recordId.localeCompare(right.recordId),
  );
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const output = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await mapper(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

function buildProject(
  sourceKey: EastCoastDotSourceId,
  outputSourceId: string,
  candidate: Candidate,
  now: Date,
): ProjectRecord {
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const template = definition.template;
  const project: ProjectRecord = {
    id: `${outputSourceId}:${candidate.recordId}`,
    sourceId: outputSourceId,
    sourceRecordId: candidate.recordId,
    title: candidate.title,
    summary: candidate.summary,
    stage: candidate.stage ?? "bidding",
    status: candidate.status,
    agency: template.owner,
    city: candidate.city,
    county: candidate.county,
    state: template.stateCode ?? template.jurisdiction,
    value: candidate.value,
    postedAt: candidate.postedAt,
    bidDate: candidate.bidDate,
    bidDateTimeZone: candidate.bidDate
      ? definition.timeZone
      : undefined,
    updatedAt: now.toISOString(),
    sourceName: template.name,
    sourceUrl: candidate.sourceUrl,
    provenance: candidate.provenance ?? "live-public-page",
    confidence: "official",
    documents: uniqueDocuments([
      sourceRecordDocument(candidate.sourceUrl),
      ...(candidate.documents ?? []),
    ]),
    participants:
      candidate.participants ??
      [
        {
          name: template.owner,
          role: "agency",
          participantType: "organization",
          organization: template.owner,
          sourceUrl: candidate.sourceUrl,
        },
      ],
    searchableFields: [
      candidate.recordId,
      candidate.title,
      candidate.summary,
      candidate.city ?? "",
      candidate.county ?? "",
      template.owner,
      template.jurisdiction,
      ...(candidate.searchTerms ?? []),
    ].filter(Boolean),
    documentTextIndexed: false,
  };
  return project;
}

function cursorOffset(
  sourceKey: EastCoastDotSourceId,
  outputSourceId: string,
  options: PublicDotFeedOptions,
): number {
  return (
    options.sourceCursors?.[outputSourceId]?.offset ??
    options.sourceCursors?.[sourceKey]?.offset ??
    0
  );
}

function feedLimit(options: PublicDotFeedOptions): number {
  return options.mode === "ingest" ? INGEST_LIMIT : VIEW_LIMIT;
}

function makePage(
  offset: number,
  recordsRead: number,
  total: number,
): SourcePageRecord {
  const nextOffset = offset + recordsRead;
  return {
    offset,
    recordsRead,
    nextOffset,
    hasMore: nextOffset < total,
    currentCursor: { offset },
    nextCursor: { offset: nextOffset },
  };
}

function makeResult(
  sourceKey: EastCoastDotSourceId,
  outputSourceId: string,
  candidates: Candidate[],
  now: Date,
  options: PublicDotFeedOptions,
): PublicDotConnectorResult {
  const template = SOURCE_DEFINITIONS[sourceKey].template;
  const offset = cursorOffset(sourceKey, outputSourceId, options);
  const selected = sortCandidates(candidates).slice(
    offset,
    offset + feedLimit(options),
  );
  const projects = selected.map((candidate) =>
    buildProject(sourceKey, outputSourceId, candidate, now),
  );
  const page = makePage(offset, selected.length, candidates.length);
  return {
    projects,
    source: {
      ...template,
      id: outputSourceId,
      status: "live",
      recordCount: candidates.length,
      recordCountUnit: "projects",
      loadedCount: projects.length,
      snapshotComplete: !page.hasMore,
      lastChecked: now.toISOString(),
    },
    page,
  };
}

const MASS_LABELS = [
  "Location",
  "Description",
  "District",
  "Ad Date",
  "Section Response",
  "Project Value",
  "CDs, Plans & Specs Available",
  "Federal Aid No.",
  "Project Number",
  "Project Type",
  "No. of Addendums",
] as const;

function labelledMassValue(
  text: string,
  label: (typeof MASS_LABELS)[number],
): string | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lookahead = MASS_LABELS.filter((candidate) => candidate !== label)
    .map((candidate) =>
      candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("|");
  return text
    .match(
      new RegExp(
        `${escapedLabel}:?\\s*(.*?)(?=\\s(?:${lookahead}):|$)`,
        "i",
      ),
    )?.[1]
    ?.trim();
}

export function parseMassDotStatus(
  html: string,
  now: Date,
): Candidate[] {
  const starts = [
    ...html.matchAll(
      /<div[^>]*class=["'][^"']*\bsm_hilite\b[^"']*["'][^>]*>\s*Bid Opening:\s*([^<]+)<\/div>/gi,
    ),
  ];
  const candidates: Candidate[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index];
    const blockStart = (match.index ?? 0) + match[0].length;
    const blockEnd = starts[index + 1]?.index ?? html.length;
    const blockText = plainText(html.slice(blockStart, blockEnd));
    const recordId = labelledMassValue(blockText, "Project Number");
    const description = labelledMassValue(blockText, "Description");
    const bidDate = massDeadline(match[1]);
    if (!recordId || !description || !isCurrent(bidDate, now)) continue;
    const location = labelledMassValue(blockText, "Location");
    const projectType = labelledMassValue(blockText, "Project Type");
    const federalAid = labelledMassValue(blockText, "Federal Aid No.");
    const district = labelledMassValue(blockText, "District");
    const plansAvailable =
      /^yes\b/i.test(
        labelledMassValue(
          blockText,
          "CDs, Plans & Specs Available",
        ) ?? "",
      );
    const documents: ProjectDocument[] = [];
    if (plansAvailable) {
      documents.push({
        name: "MassDOT plans and specifications in Bid Express",
        kind: "plans",
        url: MASSDOT_BID_EXPRESS_URL,
        access: "free-account",
        indexStatus: "account-gated",
      });
    }
    candidates.push({
      recordId,
      title: `${recordId}: ${description}`,
      summary: [
        description,
        location ? `Location: ${location}.` : "",
        projectType ? `Project type: ${projectType}.` : "",
        federalAid ? `Federal aid: ${federalAid}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      status: "Advertised",
      sourceUrl: MASSDOT_STATUS_URL,
      bidDate,
      postedAt: endOfDay(labelledMassValue(blockText, "Ad Date")),
      city: location,
      value: numericValue(
        labelledMassValue(blockText, "Project Value"),
      ),
      documents,
      searchTerms: [
        district ? `District ${district}` : "",
        projectType ?? "",
        federalAid ?? "",
      ].filter(Boolean),
    });
  }
  return candidates;
}

async function fetchMassDot(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey = "massachusetts-dot-advertised-projects" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const html = await fetchText(MASSDOT_STATUS_URL, definition, options);
  return makeResult(
    sourceKey,
    outputSourceId,
    parseMassDotStatus(html, now),
    now,
    options,
  );
}

function documentKind(name: string): ProjectDocument["kind"] {
  if (/\b(?:plans?|drawings?|sheets?|survey|geotech)\b/i.test(name)) {
    return "plans";
  }
  if (/\b(?:addend|amend|revision)\b/i.test(name)) return "addendum";
  if (
    /\b(?:proposal|rfp|specification|reference|required|appendix|schedule)\b/i.test(
      name,
    )
  ) {
    return "specifications";
  }
  return "source-record";
}

function parseDelawareDocuments(
  html: string,
  definition: EastCoastSourceDefinition,
): ProjectDocument[] {
  const documents: ProjectDocument[] = [];
  for (const match of html.matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const name = plainText(match[2]);
    if (!name || /load more/i.test(name)) continue;
    const url = officialUrl(
      match[1],
      DELDOT_BIDS_URL,
      definition.allowedHosts,
    );
    if (!url) continue;
    documents.push({
      name,
      kind: documentKind(name),
      url,
      access: "public",
      indexStatus: "metadata-only",
    });
  }
  return uniqueDocuments(documents);
}

async function fetchDelawareDocuments(
  bidId: number,
  definition: EastCoastSourceDefinition,
  options: PublicDotFeedOptions,
): Promise<ProjectDocument[]> {
  let currentCount = 0;
  let finalHtml = "";
  for (let page = 0; page < 6; page += 1) {
    const url = `${DELDOT_BIDS_URL}GetBidDocumentList?id=${bidId}&currentCount=${currentCount}`;
    finalHtml = await fetchText(url, definition, options, {
      headers: { "x-requested-with": "XMLHttpRequest" },
    });
    const next = finalHtml.match(
      /ReloadBidDetailBidDocumentsList\((\d+)\)/i,
    );
    if (!next) break;
    const nextCount = Number(next[1]);
    if (!Number.isFinite(nextCount) || nextCount <= currentCount) break;
    currentCount = nextCount;
  }
  return parseDelawareDocuments(finalHtml, definition);
}

async function fetchDelDot(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey = "delaware-dot-open-solicitations" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const payload = await fetchJson<{
    rows?: DelawareBidRow[];
  }>(DELDOT_OPEN_BIDS_URL, definition, options, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
    },
    body: JSON.stringify({
      page: 1,
      rows: 1_000,
      sidx: "DeadlineDate",
      sord: "asc",
      _search: false,
    }),
  });
  const rows = (payload.rows ?? []).filter((row) => {
    const bidDate = endOfDay(row.DeadlineDate);
    return (
      row.AgencyCode?.toUpperCase() === "DOT" &&
      typeof row.Id === "number" &&
      Boolean(row.ContractNumber) &&
      isCurrent(bidDate, now)
    );
  });
  let documentFailures = 0;
  const candidates = await mapWithConcurrency(
    rows.slice(0, 100),
    4,
    async (row): Promise<Candidate> => {
      let documents: ProjectDocument[] = [];
      try {
        documents = await fetchDelawareDocuments(
          row.Id!,
          definition,
          options,
        );
      } catch {
        documentFailures += 1;
      }
      const sourceUrl = `${DELDOT_BIDS_URL}GetBidDetail?id=${row.Id}`;
      const email = row.ContactEmail?.trim();
      const participants: ProjectParticipant[] = [
        {
          name: email || "DelDOT procurement",
          role: "agency",
          participantType: email ? "person" : "organization",
          organization: definition.template.owner,
          email: email || undefined,
          sourceUrl,
        },
      ];
      return {
        recordId: row.ContractNumber!,
        title: `${row.ContractNumber}: ${(
          row.Title ?? "DelDOT solicitation"
        ).replace(/\s+/g, " ").trim()}`,
        summary: `${(
          row.Title ?? "DelDOT solicitation"
        ).replace(/\s+/g, " ").trim()}. Official Delaware open solicitation ${row.ContractNumber}.`,
        status: "Open",
        sourceUrl,
        bidDate: endOfDay(row.DeadlineDate),
        postedAt: endOfDay(row.OpenDate),
        documents,
        participants,
        provenance: "live-api",
        searchTerms: [
          row.BidUnspscCodesString
            ? `UNSPSC ${row.BidUnspscCodesString}`
            : "",
        ].filter(Boolean),
      };
    },
  );
  const result = makeResult(
    sourceKey,
    outputSourceId,
    candidates,
    now,
    options,
  );
  if (documentFailures > 0) {
    result.source.status = "degraded";
    result.source.snapshotComplete = false;
    result.source.note = `${result.source.note} Document lists were unavailable for ${documentFailures} current solicitation${documentFailures === 1 ? "" : "s"} during this check.`;
  }
  return result;
}

export function parseMarylandShaSchedule(
  html: string,
  now: Date,
): Candidate[] {
  const table = html.match(
    /<table\b[^>]*id=["']ContractAdGridView["'][^>]*>([\s\S]*?)<\/table>/i,
  )?.[1];
  if (!table) return [];
  const candidates: Candidate[] = [];
  for (const row of table.matchAll(
    /<tr\b[^>]*class=["']Tr(?:Alternate)?Header["'][^>]*>([\s\S]*?)<\/tr>/gi,
  )) {
    const cells = [
      ...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi),
    ].map((cell) => plainText(cell[1]));
    if (cells.length !== 8) continue;
    const [
      contract,
      route,
      description,
      workType,
      advertised,
      bidsDue,
      noticeToProceed,
      costClass,
    ] = cells;
    const bidDate = endOfDay(bidsDue);
    if (!contract || !description || !isCurrent(bidDate, now)) continue;
    const adDate = dateOnly(advertised);
    const stage: ProjectStage =
      adDate && adDate <= calendarDateInNewYork(now)
        ? "bidding"
        : "planning";
    candidates.push({
      recordId: contract,
      title: `${contract}: ${description}`,
      summary: [
        description,
        route ? `Route: ${route}.` : "",
        workType ? `Type of work: ${workType}.` : "",
        costClass ? `SHA cost class: ${costClass}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      status: stage === "bidding" ? "Advertised" : "Scheduled",
      stage,
      sourceUrl: MARYLAND_SHA_SCHEDULE_URL,
      bidDate,
      postedAt: adDate ? `${adDate}T00:00:00` : undefined,
      documents: [
        {
          name: "Maryland SHA bid package in Bid Express",
          kind: "plans",
          url: MARYLAND_BIDX_URL,
          access: "free-account",
          indexStatus: "account-gated",
        },
      ],
      searchTerms: [
        route,
        workType,
        costClass ? `Cost class ${costClass}` : "",
        noticeToProceed
          ? `Notice to proceed ${noticeToProceed}`
          : "",
      ].filter(Boolean),
    });
  }
  return candidates;
}

async function fetchMarylandSha(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey =
    "maryland-sha-contract-advertising-schedule" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const html = await fetchText(
    MARYLAND_SHA_SCHEDULE_URL,
    definition,
    options,
  );
  return makeResult(
    sourceKey,
    outputSourceId,
    parseMarylandShaSchedule(html, now),
    now,
    options,
  );
}

function bytesToBinary(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + 32_768)),
    );
  }
  return chunks.join("");
}

function binaryToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function decodePdfLiteral(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      output += character;
      continue;
    }
    const next = value[index + 1];
    if (next === "\r" || next === "\n") {
      index += next === "\r" && value[index + 2] === "\n" ? 2 : 1;
      continue;
    }
    const simple: Record<string, string> = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      "(": "(",
      ")": ")",
      "\\": "\\",
    };
    if (simple[next] !== undefined) {
      output += simple[next];
      index += 1;
      continue;
    }
    const octal = value.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      output += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    if (next) {
      output += next;
      index += 1;
    }
  }
  return output;
}

function pdfLiteralStrings(stream: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < stream.length; index += 1) {
    if (stream[index] !== "(") continue;
    let depth = 1;
    let escaped = false;
    let value = "";
    for (let cursor = index + 1; cursor < stream.length; cursor += 1) {
      const character = stream[cursor];
      if (escaped) {
        value += `\\${character}`;
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "(") {
        depth += 1;
        value += character;
        continue;
      }
      if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          values.push(decodePdfLiteral(value));
          index = cursor;
          break;
        }
        value += character;
        continue;
      }
      value += character;
    }
  }
  return values;
}

export function extractLiteralPdfText(bytes: Uint8Array): string {
  const binary = bytesToBinary(bytes);
  const fragments: string[] = [];
  let decodedBytes = 0;
  for (const match of binary.matchAll(
    /<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g,
  )) {
    let streamBytes = binaryToBytes(match[2]);
    if (/\/FlateDecode\b/.test(match[1])) {
      try {
        streamBytes = unzlibSync(streamBytes);
      } catch {
        continue;
      }
    }
    decodedBytes += streamBytes.byteLength;
    if (decodedBytes > MAX_PDF_STREAM_BYTES) {
      throw new Error(`PDF decoded streams exceeded the guarded byte limit`);
    }
    const stream = bytesToBinary(streamBytes);
    if (!/\bTj\b|\bTJ\b/.test(stream)) continue;
    fragments.push(...pdfLiteralStrings(stream));
  }
  return fragments.join(" ").replace(/\s+/g, " ").trim();
}

export function parseScDotNoticeText(
  text: string,
  bidDate: string,
  noticeUrl: string,
): Candidate[] {
  const sections = text.split(
    /(?=Call No\.:\s*\d{3}\s+1\s+Page:)/i,
  );
  const candidates: Candidate[] = [];
  for (const section of sections) {
    const call = section.match(/^Call No\.:\s*(\d+)/i)?.[1];
    const fileNumber = section.match(
      /\b(\d{7})\s+SC File NO/i,
    )?.[1];
    if (!call || !fileNumber) continue;
    const county = section
      .match(/CO\(S\)\.:\s*(.*?)\s+DBE Goal/i)?.[1]
      ?.trim();
    const description = section
      .match(
        /Completion Date:\s*Description:\s*(.*?)\s+\d{1,2}\/\d{1,2}\/\d{4}\s+Days/i,
      )?.[1]
      ?.trim();
    const pcn = section.match(
      /Funding:\s*\S+\s+([A-Z]\d{6})\s+\1\s+PCN:/i,
    )?.[1];
    const title = description || `SCDOT construction project ${fileNumber}`;
    candidates.push({
      recordId: fileNumber,
      title: `${fileNumber}: ${title}`,
      summary: [
        title,
        county ? `County or counties: ${county}.` : "",
        pcn ? `PCN: ${pcn}.` : "",
        `Call ${call}.`,
      ]
        .filter(Boolean)
        .join(" "),
      status: "Letting notice",
      sourceUrl: noticeUrl,
      bidDate,
      county,
      documents: [
        {
          name: "Official notice to contractors",
          kind: "source-record",
          url: noticeUrl,
          access: "public",
          indexStatus: "metadata-only",
        },
        {
          name: "SCDOT plans and proposal package in Bid Express",
          kind: "plans",
          url: SCDOT_BIDX_URL,
          access: "free-account",
          indexStatus: "account-gated",
        },
      ],
      searchTerms: [call, pcn ?? ""].filter(Boolean),
    });
  }
  return candidates;
}

function lettingDateFromUrl(url: string): string | undefined {
  const label = decodeURIComponent(new URL(url).pathname);
  const match = label.match(
    /(?:^|\/)(\d{2})(\d{2})(\d{4})\b/,
  );
  if (!match) return undefined;
  return `${match[3]}-${match[1]}-${match[2]}`;
}

async function fetchScDot(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey = "south-carolina-dot-construction-lettings" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const html = await fetchText(SCDOT_LETTINGS_URL, definition, options);
  const notices = [
    ...html.matchAll(
      /<a\b[^>]*href=["']([^"']+\.pdf[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    ),
  ]
    .map((match) => {
      const url = officialUrl(
        match[1],
        SCDOT_LETTINGS_URL,
        definition.allowedHosts,
      );
      const text = plainText(match[2]);
      const date = url ? lettingDateFromUrl(url) : undefined;
      return { url, text, date };
    })
    .filter(
      (
        notice,
      ): notice is { url: string; text: string; date: string } =>
        Boolean(
          notice.url &&
            notice.date &&
            /notice to contractors|proposal/i.test(notice.text) &&
            notice.date >= calendarDateInNewYork(now),
        ),
    );
  let noticeFailures = 0;
  const parsed = await mapWithConcurrency(
    notices.slice(0, 12),
    3,
    async (notice) => {
      try {
        const bidDate = `${notice.date}T23:59:00`;
        const pdf = await fetchBytes(notice.url, definition, options);
        const candidates = parseScDotNoticeText(
          extractLiteralPdfText(pdf),
          bidDate,
          notice.url,
        );
        if (candidates.length > 0) return candidates;
        return [
          {
            recordId: `SCDOT-${notice.date}`,
            title: `SCDOT ${notice.date} construction letting`,
            summary:
              "Official SCDOT construction letting notice. Project-level text was not represented as literal PDF text, so this guarded fallback retains the official letting.",
            status: "Advance letting notice",
            stage: "planning" as const,
            sourceUrl: notice.url,
            bidDate,
            documents: [
              {
                name: notice.text || "Official notice to contractors",
                kind: "source-record" as const,
                url: notice.url,
                access: "public" as const,
                indexStatus: "metadata-only" as const,
              },
              {
                name: "SCDOT plans and proposal package in Bid Express",
                kind: "plans" as const,
                url: SCDOT_BIDX_URL,
                access: "free-account" as const,
                indexStatus: "account-gated" as const,
              },
            ],
          },
        ];
      } catch {
        noticeFailures += 1;
        return [];
      }
    },
  );
  const byRecordId = new Map<string, Candidate>();
  for (const candidate of parsed.flat()) {
    const existing = byRecordId.get(candidate.recordId);
    if (!existing || (candidate.bidDate ?? "") < (existing.bidDate ?? "")) {
      byRecordId.set(candidate.recordId, candidate);
    }
  }
  const result = makeResult(
    sourceKey,
    outputSourceId,
    [...byRecordId.values()],
    now,
    options,
  );
  if (noticeFailures > 0) {
    result.source.status = "degraded";
    result.source.snapshotComplete = false;
    result.source.note = `${result.source.note} ${noticeFailures} current notice PDF${noticeFailures === 1 ? "" : "s"} could not be decoded during this check.`;
  }
  return result;
}

const GDOT_2026_LETTINGS = [
  { advertised: "2025-12-26", bid: "2026-01-23" },
  { advertised: "2026-01-23", bid: "2026-02-20" },
  { advertised: "2026-02-20", bid: "2026-03-20" },
  { advertised: "2026-03-20", bid: "2026-04-17" },
  { advertised: "2026-04-17", bid: "2026-05-15" },
  { advertised: "2026-05-15", bid: "2026-06-12" },
  { advertised: "2026-06-19", bid: "2026-07-17" },
  { advertised: "2026-07-24", bid: "2026-08-21" },
  { advertised: "2026-08-21", bid: "2026-09-18" },
  { advertised: "2026-09-18", bid: "2026-10-16" },
  { advertised: "2026-10-23", bid: "2026-11-20" },
  { advertised: "2026-11-20", bid: "2026-12-18" },
] as const;

async function fetchGDot(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey =
    "georgia-dot-construction-letting-calendar" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const currentDate = calendarDateInNewYork(now);
  if (!currentDate.startsWith("2026-")) {
    throw new Error(
      "GDOT calendar adapter requires the reviewed schedule for the current year",
    );
  }
  await fetchBytes(GDOT_SCHEDULE_URL, definition, options);
  const candidates: Candidate[] = GDOT_2026_LETTINGS.filter(
    (letting) => letting.bid >= currentDate,
  ).map((letting) => {
    const bidding = letting.advertised <= currentDate;
    const label = new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${letting.bid}T12:00:00Z`));
    return {
      recordId: `GDOT-${letting.bid}`,
      title: `GDOT ${label} construction letting`,
      summary: `Official GDOT construction letting calendar entry advertised ${letting.advertised} with letting date ${letting.bid}. Project packages are account-gated upstream.`,
      status: bidding ? "Advertised" : "Scheduled",
      stage: bidding ? "bidding" : "planning",
      sourceUrl: GDOT_SCHEDULE_URL,
      postedAt: `${letting.advertised}T00:00:00`,
      bidDate: `${letting.bid}T23:59:00`,
      documents: [
        {
          name: "Official GDOT 2026 letting schedule",
          kind: "source-record",
          url: GDOT_SCHEDULE_URL,
          access: "public",
          indexStatus: "metadata-only",
        },
        {
          name: "GDOT project packages in Bid Express",
          kind: "plans",
          url: GDOT_BIDX_URL,
          access: "free-account",
          indexStatus: "account-gated",
        },
      ],
    };
  });
  return makeResult(
    sourceKey,
    outputSourceId,
    candidates,
    now,
    options,
  );
}

function ddotDetailUrl(record: DdotSolicitation): string {
  const requestId = encodeURIComponent(
    record.RequestIdEncoded ?? String(record.RequestId ?? ""),
  );
  const solicitation = encodeURIComponent(
    record.SolicitationNumberEncoded ??
      record.SolicitationNumber ??
      "",
  );
  return `${DDOT_SOLICITATIONS_URL}LocationsDetail/${requestId}?solNum=${solicitation}`;
}

async function fetchDdot(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey = "district-dot-open-solicitations" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const payload = await fetchJson<{
    Data?: DdotSolicitation[];
  }>(DDOT_OPEN_SOLICITATIONS_URL, definition, options);
  const candidates: Candidate[] = (payload.Data ?? [])
    .filter(
      (record) =>
        record.IsAvailableToPublic === true &&
        record.BidStatus?.toUpperCase() === "OPEN" &&
        Boolean(record.SolicitationNumber),
    )
    .map((record) => {
      const recordId = record.SolicitationNumber!;
      const title =
        record.SOWTitle ||
        record.ProjectName ||
        `DDOT solicitation ${recordId}`;
      const sourceUrl = ddotDetailUrl(record);
      const email =
        record.RequestForInfoEmail ||
        record.RequestForCFPInfoEmail;
      return {
        recordId,
        title: `${recordId}: ${title}`,
        summary:
          record.ProjectScope ||
          record.ProjectDescription ||
          `${title}. ${record.DesignationType ?? "DDOT open solicitation"}.`,
        status: "OPEN",
        sourceUrl,
        postedAt: record.LastUpdatedDate,
        value: numericValue(String(record.Amount ?? "")),
        participants: email
          ? [
              {
                name: email,
                role: "agency" as const,
                participantType: "person" as const,
                organization: definition.template.owner,
                email,
                sourceUrl,
              },
            ]
          : undefined,
        provenance: "live-api" as const,
        searchTerms: [
          record.ProjectName ?? "",
          record.ProjectPhase ?? "",
          record.DesignationType ?? "",
          record.Location ?? "",
        ].filter(Boolean),
      };
    });
  return makeResult(
    sourceKey,
    outputSourceId,
    candidates,
    now,
    options,
  );
}

export function fetchEastCoastDotSource(
  sourceId: EastCoastDotSourceId,
  options: PublicDotFeedOptions = {},
): Promise<PublicDotConnectorResult> {
  const outputSourceId = options.sourceId ?? sourceId;
  switch (sourceId) {
    case "massachusetts-dot-advertised-projects":
      return fetchMassDot(outputSourceId, options);
    case "delaware-dot-open-solicitations":
      return fetchDelDot(outputSourceId, options);
    case "maryland-sha-contract-advertising-schedule":
      return fetchMarylandSha(outputSourceId, options);
    case "south-carolina-dot-construction-lettings":
      return fetchScDot(outputSourceId, options);
    case "georgia-dot-construction-letting-calendar":
      return fetchGDot(outputSourceId, options);
    case "district-dot-open-solicitations":
      return fetchDdot(outputSourceId, options);
  }
}
