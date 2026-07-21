import type {
  ProjectDocument,
  ProjectParticipant,
  ProjectRecord,
  SourceCursorRecord,
  SourcePageRecord,
  SourceRecord,
} from "./types";
import { sourceLocalDateTimeToIso } from "./deadline-time.ts";
import { gunzipSync, strFromU8, unzipSync } from "fflate";
import {
  fetchOhioDotSource,
  OHIO_DOT_SOURCE_ID,
  OHIO_DOT_SOURCE_TEMPLATE,
} from "./ohio-dot-connector.ts";
import {
  fetchPennsylvaniaDotProjectEnrichment,
  fetchPennsylvaniaDotSource,
  PENNSYLVANIA_DOT_SOURCE_ID,
  PENNSYLVANIA_DOT_SOURCE_TEMPLATE,
} from "./pennsylvania-dot-connector.ts";
import {
  fetchTexasDotSource,
  TEXAS_DOT_SOURCE_ID,
  TEXAS_DOT_SOURCE_TEMPLATE,
} from "./texas-dot-connector.ts";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_DOT_BINARY_BYTES = 25 * 1024 * 1024;
const VIEW_LIMIT = 20;
const INGEST_LIMIT = 50;
const MAX_SIBLING_CONCURRENCY = 3;
const VIEW_SUCCESS_TTL_MS = 5 * 60 * 1_000;
const VIEW_FAILURE_TTL_MS = 60 * 1_000;

interface BoundedScheduler {
  run<T>(work: () => Promise<T>): Promise<T>;
}

function createBoundedScheduler(limit = MAX_SIBLING_CONCURRENCY): BoundedScheduler {
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

const NETWORK_SCHEDULERS = new WeakMap<object, BoundedScheduler>();

function networkScheduler(
  dependencies: PublicDotRequestDependencies,
): BoundedScheduler {
  const key = dependencies as object;
  const existing = NETWORK_SCHEDULERS.get(key);
  if (existing) return existing;
  const scheduler = createBoundedScheduler();
  NETWORK_SCHEDULERS.set(key, scheduler);
  return scheduler;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const output = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(MAX_SIBLING_CONCURRENCY, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

export const PUBLIC_DOT_SOURCE_IDS = [
  "washington-dot-contracting-opportunities",
  "illinois-dot-transportation-bulletin",
  TEXAS_DOT_SOURCE_ID,
  "new-york-dot-construction-contracts",
  "north-carolina-dot-highway-lettings",
  "iowa-dot-plans-estimating-proposals",
  "florida-dot-statewide-lettings",
  "virginia-dot-cabb-advertisements",
  "michigan-dot-bid-lettings",
  OHIO_DOT_SOURCE_ID,
  PENNSYLVANIA_DOT_SOURCE_ID,
] as const;

export type PublicDotSourceId = (typeof PUBLIC_DOT_SOURCE_IDS)[number];
export type PublicDotFeedMode = "view" | "ingest";
export type PublicDotSourceTemplate = Omit<
  SourceRecord,
  "status" | "recordCount" | "lastChecked"
>;

export interface PublicDotConnectorResult {
  projects: ProjectRecord[];
  source: SourceRecord;
  page: SourcePageRecord;
}

export interface PublicDotRequestDependencies {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** Testable lower ceiling; callers cannot raise the production safety limit. */
  maxBinaryBytes?: number;
  now?: () => Date;
}

export interface PublicDotFeedOptions extends PublicDotRequestDependencies {
  mode?: PublicDotFeedMode;
  sourceCursors?: Record<string, SourceCursorRecord>;
  /** Optional registry ID to use for emitted records. */
  sourceId?: string;
}

interface PublicDotViewSnapshot {
  promise: Promise<PublicDotConnectorResult>;
  /** Undefined while the shared request is still in flight. */
  expiresAt?: number;
}

const PUBLIC_DOT_VIEW_SNAPSHOTS = new Map<
  PublicDotSourceId,
  PublicDotViewSnapshot
>();

function cacheableDefaultView(
  sourceId: PublicDotSourceId,
  options: PublicDotFeedOptions,
): boolean {
  return (
    (options.mode === undefined || options.mode === "view") &&
    options.fetchImpl === undefined &&
    options.now === undefined &&
    options.requestTimeoutMs === undefined &&
    options.maxBinaryBytes === undefined &&
    options.sourceCursors === undefined &&
    (options.sourceId === undefined || options.sourceId === sourceId)
  );
}

interface SourceDefinition {
  template: PublicDotSourceTemplate;
  allowedHosts: readonly string[];
  timeZone: ProjectRecord["bidDateTimeZone"];
}

interface Anchor {
  url: string;
  text: string;
  index: number;
}

interface Candidate {
  recordId: string;
  title: string;
  summary: string;
  status: string;
  sourceUrl: string;
  bidDate: string;
  bidDateTimeZone?: ProjectRecord["bidDateTimeZone"];
  postedAt?: string;
  county?: string;
  value?: number;
  documents?: ProjectDocument[];
  participants?: ProjectParticipant[];
  searchTerms?: string[];
}

const WSDOT_SEARCH_URL =
  "https://wsdot.wa.gov/business-wsdot/contracts/search-contracting-opportunities";
const WSDOT_ARCHIVE_URL = "https://ftp.wsdot.wa.gov/contracts/";
const IDOT_HOME_URL = "https://webapps1.dot.illinois.gov/WCTB/LbHome";
const NYSDOT_CONTRACTS_URL =
  "https://www.dot.ny.gov/doing-business/opportunities/const-notices";
const NCDOT_CENTRAL_URL =
  "https://connect.ncdot.gov/letting/pages/central.aspx";
const IOWADOT_PLANS_URL =
  "https://iowadot.gov/consultants-contractors/contracts/plans-estimation-proposals";
const FDOT_CENTRAL_URL =
  "https://www.fdot.gov/contracts/lettings/letting-project-info.shtm";
const FDOT_CPP_URL = "https://cpp.fdot.gov/";
const FDOT_ADVERTISEMENTS_URL =
  "https://www.fdot.gov/contracts/advertisements.shtm";
const FDOT_DOCUMENT_INDEX_URLS = [
  FDOT_CENTRAL_URL,
  "https://www.fdot.gov/contracts/district-offices/d1/lettings/dist-letting-project-info.shtm",
  "https://www.fdot.gov/contracts/district-offices/d2/lettings/dist-letting-project-info.shtm",
  "https://www.fdot.gov/contracts/district-offices/d3/lettings/dist-letting-project-info.shtm",
  "https://www.fdot.gov/contracts/district-offices/d4/lettings/dist4letting-project-info.shtm",
  "https://www.fdot.gov/contracts/district-offices/d5/lettings/dist-letting-project-info.shtm",
  "https://www.fdot.gov/contracts/district-offices/d6/lettings/letting-project-info.shtm",
  "https://www.fdot.gov/contracts/district-offices/d7/lettings/dist-letting-project-info.shtm",
  "https://www.fdot.gov/contracts/district-offices/tp/lettings/dist-letting-project-info.shtm",
] as const;
const VDOT_CABB_URL =
  "https://cabb.virginiadot.org/AdProjectInfoList.aspx?ADVAWD=1";
const VDOT_CABB_HELP_URL =
  "https://www.vdot.virginia.gov/doing-business/tools/cabb/";
const MDOT_BID_LETTING_URL =
  "https://mdotjboss.state.mi.us/BidLetting/BidLettingHome.htm";

export const PUBLIC_DOT_SOURCE_TEMPLATES: Record<
  PublicDotSourceId,
  PublicDotSourceTemplate
> = {
  "washington-dot-contracting-opportunities": {
    id: "washington-dot-contracting-opportunities",
    name: "WSDOT Contracting Opportunities",
    owner: "Washington State Department of Transportation",
    level: "state",
    sourceClass: "procurement",
    stages: ["bidding"],
    access: "open",
    cadence: "Daily",
    url: WSDOT_SEARCH_URL,
    jurisdiction: "Washington",
    note: "Official advertised opportunities with WSDOT's public plans, specifications, addenda, Q&A, and plan-holder archive.",
  },
  "illinois-dot-transportation-bulletin": {
    id: "illinois-dot-transportation-bulletin",
    name: "IDOT Transportation Bulletin",
    owner: "Illinois Department of Transportation",
    level: "state",
    sourceClass: "procurement",
    stages: ["bidding"],
    access: "open",
    cadence: "Daily",
    url: IDOT_HOME_URL,
    jurisdiction: "Illinois",
    note: "Official current letting bulletin joined to IDOT's public ePlan plans, proposals, and addenda.",
  },
  [TEXAS_DOT_SOURCE_ID]: TEXAS_DOT_SOURCE_TEMPLATE,
  "new-york-dot-construction-contracts": {
    id: "new-york-dot-construction-contracts",
    name: "NYSDOT Construction Contract Documents",
    owner: "New York State Department of Transportation",
    level: "state",
    sourceClass: "procurement",
    stages: ["bidding"],
    access: "open",
    cadence: "Daily",
    url: NYSDOT_CONTRACTS_URL,
    jurisdiction: "New York",
    note: "Official advertised construction contracts with proposal books, plans, amendments, supplemental information, and CADD files where published.",
  },
  "north-carolina-dot-highway-lettings": {
    id: "north-carolina-dot-highway-lettings",
    name: "NCDOT Highway Lettings",
    owner: "North Carolina Department of Transportation",
    level: "state",
    sourceClass: "procurement",
    stages: ["bidding"],
    access: "open",
    cadence: "Daily",
    url: NCDOT_CENTRAL_URL,
    jurisdiction: "North Carolina",
    note: "Official central and division letting details with plans, proposals, addenda, bid tabs, and electronic bid files where published.",
  },
  "iowa-dot-plans-estimating-proposals": {
    id: "iowa-dot-plans-estimating-proposals",
    name: "Iowa DOT Plans & Estimating Proposals",
    owner: "Iowa Department of Transportation",
    level: "state",
    sourceClass: "procurement",
    stages: ["bidding"],
    access: "open",
    cadence: "Daily",
    url: IOWADOT_PLANS_URL,
    jurisdiction: "Iowa",
    note: "Official current letting rows with public project-level ZIP packages containing plans, estimating proposals, and supplemental engineering files where published.",
  },
  "florida-dot-statewide-lettings": {
    id: "florida-dot-statewide-lettings",
    name: "FDOT Statewide Lettings",
    owner: "Florida Department of Transportation",
    level: "state",
    sourceClass: "procurement",
    stages: ["bidding"],
    access: "open",
    cadence: "Daily",
    url: FDOT_ADVERTISEMENTS_URL,
    jurisdiction: "Florida",
    note: "Official central- and district-office advertised proposals with exact scope, deadlines, and public solicitation/addendum files where published. FDOT plan, specification, and bidding packages are free after vendor and CPP account registration.",
  },
  "virginia-dot-cabb-advertisements": {
    id: "virginia-dot-cabb-advertisements",
    name: "VDOT Construction Advertisement Bulletin Board",
    owner: "Virginia Department of Transportation",
    level: "state",
    sourceClass: "procurement",
    stages: ["bidding"],
    access: "open",
    cadence: "Daily",
    url: VDOT_CABB_URL,
    jurisdiction: "Virginia",
    note: "Official active highway advertisement rows with bid dates, values, scope, public advertisement files, Q&A, notices, and plan-holder links. Full e-plans require an approved ProjectWise account; CII advertisements are excluded from automation and the reported source total remains a raw-row count.",
  },
  "michigan-dot-bid-lettings": {
    id: "michigan-dot-bid-lettings",
    name: "Michigan DOT Bid Lettings",
    owner: "Michigan Department of Transportation",
    level: "state",
    sourceClass: "procurement",
    stages: ["bidding"],
    access: "open",
    cadence: "Daily",
    url: MDOT_BID_LETTING_URL,
    jurisdiction: "Michigan",
    note: "Official current MDOT letting packages decoded from public Project Bids EBSX archives, with exact scope, pay-item metadata, public advertisements, addendum listings, bidder and plan-holder files, and bid deadlines. Full plans and proposals require a free MiLogin/eProposal account.",
  },
  [OHIO_DOT_SOURCE_ID]: OHIO_DOT_SOURCE_TEMPLATE,
  [PENNSYLVANIA_DOT_SOURCE_ID]: PENNSYLVANIA_DOT_SOURCE_TEMPLATE,
};

const SOURCE_DEFINITIONS: Record<PublicDotSourceId, SourceDefinition> = {
  "washington-dot-contracting-opportunities": {
    template: PUBLIC_DOT_SOURCE_TEMPLATES["washington-dot-contracting-opportunities"],
    allowedHosts: ["wsdot.wa.gov", "apps.wsdot.wa.gov", "ftp.wsdot.wa.gov"],
    timeZone: "America/Los_Angeles",
  },
  "illinois-dot-transportation-bulletin": {
    template: PUBLIC_DOT_SOURCE_TEMPLATES["illinois-dot-transportation-bulletin"],
    allowedHosts: [
      "webapps1.dot.illinois.gov",
      "webapps.dot.illinois.gov",
      "apps.dot.illinois.gov",
      "idot.illinois.gov",
    ],
    timeZone: "America/Chicago",
  },
  [TEXAS_DOT_SOURCE_ID]: {
    template: TEXAS_DOT_SOURCE_TEMPLATE,
    allowedHosts: [
      "txdot.gov",
      "www.txdot.gov",
      "ftp.txdot.gov",
      "dot.state.tx.us",
      "www.dot.state.tx.us",
    ],
    timeZone: "America/Chicago",
  },
  "new-york-dot-construction-contracts": {
    template: PUBLIC_DOT_SOURCE_TEMPLATES["new-york-dot-construction-contracts"],
    allowedHosts: ["dot.ny.gov", "www.dot.ny.gov"],
    timeZone: "America/New_York",
  },
  "north-carolina-dot-highway-lettings": {
    template: PUBLIC_DOT_SOURCE_TEMPLATES["north-carolina-dot-highway-lettings"],
    allowedHosts: ["connect.ncdot.gov", "ncdot.gov", "www.ncdot.gov"],
    timeZone: "America/New_York",
  },
  "iowa-dot-plans-estimating-proposals": {
    template: PUBLIC_DOT_SOURCE_TEMPLATES["iowa-dot-plans-estimating-proposals"],
    allowedHosts: [
      "iowadot.gov",
      "www.iowadot.gov",
      "ia.iowadot.gov",
      "secure.iowadot.gov",
    ],
    timeZone: "America/Chicago",
  },
  "florida-dot-statewide-lettings": {
    template: PUBLIC_DOT_SOURCE_TEMPLATES["florida-dot-statewide-lettings"],
    allowedHosts: [
      "fdot.gov",
      "www.fdot.gov",
      "ftp.fdot.gov",
      "bqa.fdot.gov",
      "cpp.fdot.gov",
      "fdotwww.blob.core.windows.net",
    ],
    timeZone: "America/New_York",
  },
  "virginia-dot-cabb-advertisements": {
    template: PUBLIC_DOT_SOURCE_TEMPLATES["virginia-dot-cabb-advertisements"],
    allowedHosts: [
      "cabb.virginiadot.org",
      "vdot.virginia.gov",
      "www.vdot.virginia.gov",
    ],
    timeZone: "America/New_York",
  },
  "michigan-dot-bid-lettings": {
    template: PUBLIC_DOT_SOURCE_TEMPLATES["michigan-dot-bid-lettings"],
    allowedHosts: [
      "mdotjboss.state.mi.us",
      "michigan.gov",
      "www.michigan.gov",
      "milogintp.michigan.gov",
      "bidx.com",
      "www.bidx.com",
    ],
    timeZone: "America/Detroit",
  },
  [OHIO_DOT_SOURCE_ID]: {
    template: OHIO_DOT_SOURCE_TEMPLATE,
    allowedHosts: ["tims.dot.state.oh.us", "contracts.dot.state.oh.us"],
    timeZone: "America/New_York",
  },
  [PENNSYLVANIA_DOT_SOURCE_ID]: {
    template: PENNSYLVANIA_DOT_SOURCE_TEMPLATE,
    allowedHosts: ["www.ecms.penndot.pa.gov"],
    timeZone: "America/New_York",
  },
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

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

function cleanLabel(value: string): string {
  return plainText(value).replace(/\s+/g, " ").trim();
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
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
    if (url.protocol !== "https:" || !hostAllowed(url.hostname, allowedHosts)) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

async function fetchOfficialResponse(
  initialUrl: string,
  definition: SourceDefinition,
  dependencies: PublicDotRequestDependencies,
  init: RequestInit,
): Promise<Response> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  let currentUrl = initialUrl;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const response = await fetchImpl(currentUrl, {
      ...init,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      const nextUrl = location
        ? officialUrl(location, currentUrl, definition.allowedHosts)
        : undefined;
      if (!nextUrl || redirect === 4) {
        throw new Error("DOT source returned an unsafe redirect chain");
      }
      currentUrl = nextUrl;
      continue;
    }
    if (
      response.url &&
      !officialUrl(response.url, currentUrl, definition.allowedHosts)
    ) {
      await response.body?.cancel();
      throw new Error("DOT source resolved outside its official host allowlist");
    }
    return response;
  }
  throw new Error("DOT source exceeded its redirect safety limit");
}

function anchors(
  html: string,
  baseUrl: string,
  allowedHosts: readonly string[],
): Anchor[] {
  const result: Anchor[] = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const href = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const url = officialUrl(href, baseUrl, allowedHosts);
    if (!url) continue;
    result.push({ url, text: cleanLabel(match[2]), index: match.index ?? 0 });
  }
  return result;
}

function dateOnly(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDateFromText(value: string): string | undefined {
  const normalized = plainText(value);
  const named = normalized.match(
    /\b(January|February|March|April|May|June|July|August|September|Sept|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:\s*[–—-]\s*\d{1,2})?,?\s+(20\d{2})\b/i,
  );
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    if (month) return dateOnly(Number(named[3]), month, Number(named[2]));
  }
  const iso = normalized.match(/\b(20\d{2})-(\d{2})-(\d{2})(?!\d)/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const numeric = normalized.match(
    /\b(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2}|\d{2})\b/,
  );
  if (numeric) {
    const year = Number(numeric[3]) < 100 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
    return dateOnly(year, Number(numeric[1]), Number(numeric[2]));
  }
  return undefined;
}

function deadlineFromText(value: string): string | undefined {
  const day = parseDateFromText(value);
  if (!day) return undefined;
  const normalized = plainText(value);
  const time = normalized.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  if (!time) return day;
  let hour = Number(time[1]);
  const minute = Number(time[2]);
  if (time[3].toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (time[3].toUpperCase() === "AM" && hour === 12) hour = 0;
  return `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function isCurrentDeadline(deadline: string | undefined, now: Date): deadline is string {
  return Boolean(deadline && deadline.slice(0, 10) >= today(now));
}

function isDirectDocumentUrl(urlValue: string): boolean {
  const url = new URL(urlValue);
  const path = decodeURIComponent(url.pathname).toLowerCase();
  if (/\.(?:pdf|zip|dgn|dwg|xml|kmz|kml|xlsx?|docx?|ebsx?|00\dx?)$/.test(path)) {
    return true;
  }
  return (
    /mexis_app\.bc_const_notice_admin\.viewfile$/i.test(path) &&
    url.searchParams.has("p_file_id")
  );
}

function documentKind(name: string, url: string): ProjectDocument["kind"] {
  const pathname = decodeURIComponent(new URL(url).pathname);
  const filename = pathname.split("/").pop() ?? "";
  const value = `${name} ${filename}`.toLowerCase();
  if (/addend|amend/.test(value)) return "addendum";
  if (/bid[ _-]?tab|tabulation/.test(value)) return "bid-tab";
  if (/award/.test(value)) return "award";
  if (/proposal|specification|special provision|contract book/.test(value)) {
    return "specifications";
  }
  if (/plan|drawing|cadd|\.dgn\b|\.dwg\b/.test(value)) return "plans";
  if (/addend|amend/i.test(pathname)) return "addendum";
  if (/proposal|specification|special.provision/i.test(pathname)) {
    return "specifications";
  }
  if (/plan|drawing|cadd/i.test(pathname)) return "plans";
  return "source-record";
}

function directDocumentsFromHtml(
  html: string,
  baseUrl: string,
  allowedHosts: readonly string[],
  forcedKind?: ProjectDocument["kind"],
): ProjectDocument[] {
  const seen = new Set<string>();
  const documents: ProjectDocument[] = [];
  for (const anchor of anchors(html, baseUrl, allowedHosts)) {
    if (!isDirectDocumentUrl(anchor.url) || seen.has(anchor.url)) continue;
    seen.add(anchor.url);
    const fallbackName = decodeURIComponent(new URL(anchor.url).pathname.split("/").pop() || "Official document");
    documents.push({
      name: anchor.text || fallbackName,
      kind: forcedKind ?? documentKind(anchor.text || fallbackName, anchor.url),
      url: anchor.url,
      access: "public",
      indexStatus: "queued",
    });
  }
  return documents;
}

function uniqueDocuments(documents: ProjectDocument[]): ProjectDocument[] {
  const seen = new Set<string>();
  return documents.filter((document) => {
    if (seen.has(document.url)) return false;
    seen.add(document.url);
    return true;
  });
}

function contactsFromHtml(
  html: string,
  sourceUrl: string,
  agency: string,
): ProjectParticipant[] {
  const participants: ProjectParticipant[] = [
    {
      name: agency,
      role: "agency",
      participantType: "organization",
      sourceUrl,
    },
  ];
  const seen = new Set<string>();
  const emailPattern = /<a\b[^>]*href\s*=\s*["']mailto:([^"'?\s]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(emailPattern)) {
    const email = decodeHtml(match[1]).trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const index = match.index ?? 0;
    const context = plainText(html.slice(Math.max(0, index - 260), index + match[0].length + 160));
    const phone = context.match(/(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/)?.[0];
    let name = cleanLabel(match[2]);
    if (!name || name.includes("@") || /^email$/i.test(name)) {
      name = context
        .replace(email, "")
        .split(/(?:Email|Phone|Tel|Contact)\s*:?/i)
        .filter(Boolean)
        .pop()
        ?.trim()
        .slice(0, 120) || agency;
    }
    participants.push({
      name,
      role: "agency",
      participantType: name === agency ? "organization" : "person",
      organization: name === agency ? undefined : agency,
      email,
      phone,
      sourceUrl,
    });
  }
  return participants;
}

async function fetchHtml(
  url: string,
  definition: SourceDefinition,
  dependencies: PublicDotRequestDependencies,
): Promise<string> {
  const official = officialUrl(url, definition.template.url, definition.allowedHosts);
  if (!official) throw new Error(`Blocked non-official DOT URL: ${url}`);
  return networkScheduler(dependencies).run(async () => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      dependencies.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await fetchOfficialResponse(official, definition, dependencies, {
        signal: controller.signal,
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      if (!response.ok) {
        throw new Error(`DOT source returned HTTP ${response.status}: ${official}`);
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  });
}

async function fetchHtmlOptional(
  url: string,
  definition: SourceDefinition,
  dependencies: PublicDotRequestDependencies,
): Promise<string | undefined> {
  try {
    return await fetchHtml(url, definition, dependencies);
  } catch {
    return undefined;
  }
}

async function fetchBytes(
  url: string,
  definition: SourceDefinition,
  dependencies: PublicDotRequestDependencies,
): Promise<Uint8Array> {
  const official = officialUrl(url, definition.template.url, definition.allowedHosts);
  if (!official) throw new Error(`Blocked non-official DOT URL: ${url}`);
  return networkScheduler(dependencies).run(async () => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      dependencies.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await fetchOfficialResponse(official, definition, dependencies, {
        signal: controller.signal,
        headers: { Accept: "application/zip,application/octet-stream" },
      });
      if (!response.ok) {
        throw new Error(`DOT source returned HTTP ${response.status}: ${official}`);
      }
      const requestedLimit = dependencies.maxBinaryBytes;
      const byteLimit =
        Number.isInteger(requestedLimit) && (requestedLimit ?? 0) > 0
          ? Math.min(requestedLimit as number, MAX_DOT_BINARY_BYTES)
          : MAX_DOT_BINARY_BYTES;
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > byteLimit) {
        await response.body?.cancel();
        throw new Error(`DOT archive exceeds ${byteLimit} bytes`);
      }
      if (!response.body) return new Uint8Array();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > byteLimit) {
            await reader.cancel("DOT archive safety limit exceeded");
            throw new Error(`DOT archive exceeds ${byteLimit} bytes`);
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
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  });
}

async function crawlDocumentFolder(
  rootUrl: string,
  definition: SourceDefinition,
  dependencies: PublicDotRequestDependencies,
  depth = 1,
): Promise<ProjectDocument[]> {
  const html = await fetchHtmlOptional(rootUrl, definition, dependencies);
  if (!html) return [];
  const documents = directDocumentsFromHtml(html, rootUrl, definition.allowedHosts);
  if (depth <= 0) return documents;
  const childFolders = anchors(html, rootUrl, definition.allowedHosts).filter((anchor) => {
    if (isDirectDocumentUrl(anchor.url)) return false;
    const label = `${anchor.text} ${decodeURIComponent(new URL(anchor.url).pathname)}`;
    return /plan|spec|proposal|addend|amend|revision|reference|q\s*&\s*a|contract/i.test(label);
  });
  const childDocuments = await mapWithConcurrency(
    childFolders.slice(0, 8),
    (folder) =>
      crawlDocumentFolder(folder.url, definition, dependencies, depth - 1),
  );
  documents.push(...childDocuments.flat());
  return uniqueDocuments(documents);
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

function buildProject(
  sourceKey: PublicDotSourceId,
  outputSourceId: string,
  candidate: Candidate,
  now: Date,
): ProjectRecord {
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const template = definition.template;
  const sourceRecordId = candidate.recordId.trim();
  return {
    id: `${outputSourceId}:${sourceRecordId}`,
    sourceId: outputSourceId,
    sourceRecordId,
    title: candidate.title,
    summary: candidate.summary,
    stage: "bidding",
    status: candidate.status,
    agency: template.owner,
    county: candidate.county,
    state: template.jurisdiction,
    value: candidate.value,
    postedAt: candidate.postedAt,
    bidDate: candidate.bidDate,
    bidDateTimeZone: candidate.bidDateTimeZone ?? definition.timeZone,
    updatedAt: now.toISOString(),
    sourceName: template.name,
    sourceUrl: candidate.sourceUrl,
    provenance: "live-public-page",
    confidence: "official",
    documents: uniqueDocuments([
      sourceRecordDocument(candidate.sourceUrl),
      ...(candidate.documents ?? []),
    ]),
    participants:
      candidate.participants ??
      contactsFromHtml("", candidate.sourceUrl, template.owner),
    searchableFields: [
      candidate.recordId,
      candidate.title,
      candidate.summary,
      candidate.county ?? "",
      template.owner,
      template.jurisdiction,
      ...(candidate.searchTerms ?? []),
    ].filter(Boolean),
    documentTextIndexed: false,
  };
}

function makePage(
  offset: number,
  recordsRead: number,
  hasMore: boolean,
): SourcePageRecord {
  const nextOffset = offset + recordsRead;
  return {
    offset,
    recordsRead,
    nextOffset,
    hasMore,
    currentCursor: { offset },
    nextCursor: { offset: nextOffset },
  };
}

function makeResult(
  sourceKey: PublicDotSourceId,
  projects: ProjectRecord[],
  page: SourcePageRecord,
  now: Date,
  total = projects.length,
  outputSourceId?: string,
): PublicDotConnectorResult {
  const template = SOURCE_DEFINITIONS[sourceKey].template;
  return {
    projects,
    source: {
      ...template,
      id: outputSourceId ?? template.id,
      status: "live",
      recordCount: total,
      recordCountUnit: "projects",
      loadedCount: projects.length,
      snapshotComplete: !page.hasMore,
      lastChecked: now.toISOString(),
    },
    page,
  };
}

function cursorOffset(sourceKey: PublicDotSourceId, options: PublicDotFeedOptions): number {
  return options.sourceCursors?.[options.sourceId ?? sourceKey]?.offset ?? 0;
}

function feedLimit(options: PublicDotFeedOptions): number {
  return options.mode === "ingest" ? INGEST_LIMIT : VIEW_LIMIT;
}

function labelledValue(text: string, label: string): string | undefined {
  const match = text.match(
    new RegExp(`${label}\\s*:?\\s*(.+?)(?=\\s(?:Publication date|Contract number|Submittal due|Status|County|Counties|Region|District|Description|Scope)\\s*:|$)`, "i"),
  );
  return match?.[1]?.trim();
}

function scopeFromHtml(html: string, fallback: string): string {
  const text = plainText(html);
  const labelled = labelledValue(
    text,
    "(?:Project description|Contract description|Work description|Description|Scope of work|Scope)",
  );
  if (labelled && labelled.length >= 8) return labelled.slice(0, 1_200);
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => plainText(match[1]))
    .filter((value) => value.length >= 30 && !/cookie|accessibility|copyright/i.test(value));
  return paragraphs[0]?.slice(0, 1_200) ?? fallback;
}

async function fetchWsdot(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey = "washington-dot-contracting-opportunities" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const offset = cursorOffset(sourceKey, options);
  const pageNumber = Math.floor(offset / 10);
  const searchUrl = `${WSDOT_SEARCH_URL}?page=${pageNumber}`;
  const html = await fetchHtml(searchUrl, definition, options);
  const headingPattern = /<h[1-4]\b[^>]*>[\s\S]*?<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h[1-4]>/gi;
  const headings = [...html.matchAll(headingPattern)].filter((match) => {
    const url = officialUrl(match[1], searchUrl, definition.allowedHosts);
    return Boolean(url && /contracting-opportunities\//i.test(new URL(url).pathname));
  });
  const candidates: Candidate[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index];
    const start = match.index ?? 0;
    const end = headings[index + 1]?.index ?? html.length;
    const block = html.slice(start, end);
    const text = plainText(block);
    if (!/\bAdvertised\b/i.test(text) || /\b(?:Awarded|Cancelled|Closed)\b/i.test(text)) {
      continue;
    }
    const sourceUrl = officialUrl(match[1], searchUrl, definition.allowedHosts);
    const recordId = labelledValue(text, "Contract number")?.match(/[A-Z0-9-]{4,}/i)?.[0];
    const bidDate = deadlineFromText(labelledValue(text, "Submittal due") ?? text);
    if (!sourceUrl || !recordId || !isCurrentDeadline(bidDate, now)) continue;
    const title = plainText(match[2]);
    const countyValue = labelledValue(text, "Count(?:y|ies)");
    candidates.push({
      recordId,
      title,
      summary: scopeFromHtml(block, `${title}. WSDOT advertised public-works contract ${recordId}.`),
      status: "Advertised",
      sourceUrl,
      bidDate,
      postedAt: deadlineFromText(labelledValue(text, "Publication date") ?? ""),
      county: countyValue?.replace(/\s+County\b/gi, "").trim(),
    });
  }

  const archiveHtml = candidates.length
    ? await fetchHtmlOptional(WSDOT_ARCHIVE_URL, definition, options)
    : undefined;
  const archiveAnchors = archiveHtml
    ? anchors(archiveHtml, WSDOT_ARCHIVE_URL, definition.allowedHosts)
    : [];
  const projects = await mapWithConcurrency(
    candidates.slice(0, feedLimit(options)),
    async (candidate) => {
    const detailHtml = await fetchHtmlOptional(candidate.sourceUrl, definition, options);
    const documents = detailHtml
      ? directDocumentsFromHtml(detailHtml, candidate.sourceUrl, definition.allowedHosts)
      : [];
    const archiveFolder = archiveAnchors.find((anchor) => {
      const folder = decodeURIComponent(new URL(anchor.url).pathname.split("/").filter(Boolean).pop() ?? "");
      return folder.toUpperCase().startsWith(`${candidate.recordId.toUpperCase()}-`);
    });
    if (archiveFolder) {
      documents.push(
        ...(await crawlDocumentFolder(archiveFolder.url, definition, options, 2)),
      );
    }
      return buildProject(
        sourceKey,
        outputSourceId,
        {
          ...candidate,
          summary: detailHtml
            ? scopeFromHtml(detailHtml, candidate.summary)
            : candidate.summary,
          documents,
          participants: contactsFromHtml(
            detailHtml ?? "",
            candidate.sourceUrl,
            definition.template.owner,
          ),
        },
        now,
      );
    },
  );
  const hasMore = new RegExp(`[?&]page=${pageNumber + 1}(?:["'&]|$)`).test(html);
  const total = Number(plainText(html).match(/\bof\s+([\d,]+)\s+(?:results|opportunities)\b/i)?.[1]?.replace(/,/g, "")) || projects.length;
  return makeResult(
    sourceKey,
    projects,
    makePage(offset, Math.max(headings.length, projects.length), hasMore),
    now,
    total,
    outputSourceId,
  );
}

function chooseCurrentIdotLetting(
  html: string,
  definition: SourceDefinition,
  now: Date,
): { url: string; date: string } | undefined {
  const lettingAnchors = anchors(html, IDOT_HOME_URL, definition.allowedHosts).filter(
    (anchor) => /\/WCTB\/LbLettingDetail\/Index\//i.test(new URL(anchor.url).pathname),
  );
  const choices = lettingAnchors
    .map((anchor) => {
      const context = html.slice(Math.max(0, anchor.index - 250), anchor.index + 500);
      return { url: anchor.url, date: parseDateFromText(`${anchor.text} ${context}`) };
    })
    .filter((choice): choice is { url: string; date: string } =>
      isCurrentDeadline(choice.date, now),
    )
    .sort((left, right) => left.date.localeCompare(right.date));
  return choices[0];
}

async function fetchIdot(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey = "illinois-dot-transportation-bulletin" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const homeHtml = await fetchHtml(IDOT_HOME_URL, definition, options);
  const letting = chooseCurrentIdotLetting(homeHtml, definition, now);
  if (!letting) {
    return makeResult(sourceKey, [], makePage(0, 0, false), now, 0, outputSourceId);
  }
  const lettingHtml = await fetchHtml(letting.url, definition, options);
  const lettingDeadline = deadlineFromText(plainText(lettingHtml)) ?? letting.date;
  const planRoot = anchors(lettingHtml, letting.url, definition.allowedHosts).find(
    (anchor) => /\/eplan\/desenv\//i.test(new URL(anchor.url).pathname),
  );
  const planIndexHtml = planRoot
    ? await fetchHtmlOptional(planRoot.url, definition, options)
    : undefined;
  const planFolders = planIndexHtml && planRoot
    ? anchors(planIndexHtml, planRoot.url, definition.allowedHosts).filter(
        (anchor) => !isDirectDocumentUrl(anchor.url),
      )
    : [];
  const rows = [...lettingHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const rowAnchors = anchors(row[1], letting.url, definition.allowedHosts);
    const detail = rowAnchors.find((anchor) =>
      /\/WCTB\/LbContractDetail\/Index\//i.test(new URL(anchor.url).pathname),
    );
    if (!detail) continue;
    const rowText = plainText(row[1]);
    if (/\b(?:Withdrawn|Deleted|Cancelled|Awarded)\b/i.test(rowText)) continue;
    const recordId = `${detail.text} ${rowText}`.match(/\b\d{2,3}[A-Z]?-[A-Z0-9]{4,6}\b/i)?.[0];
    if (!recordId || !isCurrentDeadline(lettingDeadline, now)) continue;
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => plainText(cell[1]))
      .filter(Boolean);
    const summary = cells.filter((cell) => cell.length > 20).sort((a, b) => b.length - a.length)[0]
      ?? `IDOT advertised highway contract ${recordId}.`;
    candidates.push({
      recordId,
      title: `${recordId} — ${summary.slice(0, 180)}`,
      summary,
      status: "Active",
      sourceUrl: detail.url,
      bidDate: lettingDeadline,
    });
  }

  const offset = cursorOffset(sourceKey, options);
  const selected = candidates.slice(offset, offset + feedLimit(options));
  const enriched = await mapWithConcurrency(selected, async (candidate) => {
    const detailHtml = await fetchHtmlOptional(candidate.sourceUrl, definition, options);
    if (
      !detailHtml ||
      /(?:FOR REVIEW AND INSPECTION ONLY|NOT FOR BID)/i.test(plainText(detailHtml))
    ) {
      return undefined;
    }
    const documents = directDocumentsFromHtml(
      detailHtml,
      candidate.sourceUrl,
      definition.allowedHosts,
    );
    const folder = planFolders.find((anchor) => {
      const value = `${anchor.text} ${decodeURIComponent(new URL(anchor.url).pathname)}`;
      return value.toUpperCase().includes(candidate.recordId.toUpperCase());
    });
    if (folder) {
      documents.push(...(await crawlDocumentFolder(folder.url, definition, options, 2)));
    }
    return buildProject(
        sourceKey,
        outputSourceId,
        {
          ...candidate,
          summary: scopeFromHtml(detailHtml, candidate.summary),
          county: plainText(detailHtml).match(/Count(?:y|ies)\s*:?\s*([A-Za-z ,'-]+?)(?=\s(?:District|Region|Route|Contract|$))/i)?.[1]?.trim(),
          documents,
          participants: contactsFromHtml(
            detailHtml,
            candidate.sourceUrl,
            definition.template.owner,
          ),
        },
        now,
      );
  });
  const projects = enriched.filter(
    (project): project is ProjectRecord => Boolean(project),
  );
  const hasMore = offset + selected.length < candidates.length;
  return makeResult(
    sourceKey,
    projects,
    makePage(offset, selected.length, hasMore),
    now,
    candidates.length,
    outputSourceId,
  );
}

async function fetchNysdot(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey = "new-york-dot-construction-contracts" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const masterHtml = await fetchHtml(NYSDOT_CONTRACTS_URL, definition, options);
  const byContract = new Map<string, { url: string; bidDate: string }>();
  for (const anchor of anchors(masterHtml, NYSDOT_CONTRACTS_URL, definition.allowedHosts)) {
    const recordId = `${anchor.text} ${anchor.url}`.match(/\bD\d{6}\b/i)?.[0]?.toUpperCase();
    if (!recordId) continue;
    const context = masterHtml.slice(Math.max(0, anchor.index - 350), anchor.index + 500);
    const bidDate = deadlineFromText(context);
    if (!isCurrentDeadline(bidDate, now)) continue;
    const existing = byContract.get(recordId);
    const detailLike = /const-contract-docs|BC_CONST_DIGITAL_DOCS/i.test(anchor.url);
    if (!existing || detailLike) byContract.set(recordId, { url: anchor.url, bidDate });
  }
  const all = [...byContract.entries()].sort((left, right) =>
    left[1].bidDate.localeCompare(right[1].bidDate),
  );
  const offset = cursorOffset(sourceKey, options);
  const selected = all.slice(offset, offset + feedLimit(options));
  const enriched = await mapWithConcurrency(selected, async ([recordId, entry]) => {
    const detailHtml = await fetchHtmlOptional(entry.url, definition, options);
    if (!detailHtml) return undefined;
    const detailText = plainText(detailHtml);
    if (/\b(?:withdrawn|cancelled)\b/i.test(detailText)) return undefined;
    const summary = scopeFromHtml(
      detailHtml,
      `NYSDOT advertised construction contract ${recordId} for the ${entry.bidDate} letting.`,
    );
    return buildProject(
        sourceKey,
        outputSourceId,
        {
          recordId,
          title: `${recordId} — ${summary.slice(0, 180)}`,
          summary,
          status: "Advertised",
          sourceUrl: entry.url,
          bidDate: entry.bidDate,
          documents: directDocumentsFromHtml(
            detailHtml,
            entry.url,
            definition.allowedHosts,
          ),
          participants: contactsFromHtml(
            detailHtml,
            entry.url,
            definition.template.owner,
          ),
        },
        now,
      );
  });
  const projects = enriched.filter(
    (project): project is ProjectRecord => Boolean(project),
  );
  return makeResult(
    sourceKey,
    projects,
    makePage(offset, selected.length, offset + selected.length < all.length),
    now,
    all.length,
    outputSourceId,
  );
}

function ncdotLettingDate(url: string): string | undefined {
  const value = new URL(url).searchParams.get("let_date") ?? "";
  return parseDateFromText(value);
}

function ncdotContractId(value: string): string | undefined {
  return value.match(/\b(?:C\d{6}|DF\d{5,}|[A-Z]{1,3}\d{5,})\b/i)?.[0]?.toUpperCase();
}

async function fetchNcdot(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey = "north-carolina-dot-highway-lettings" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const centralHtml = await fetchHtml(NCDOT_CENTRAL_URL, definition, options);
  const lettingLinks = anchors(centralHtml, NCDOT_CENTRAL_URL, definition.allowedHosts)
    .map((anchor) => ({ ...anchor, bidDate: ncdotLettingDate(anchor.url) }))
    .filter(
      (anchor): anchor is Anchor & { bidDate: string } =>
        /\/letting\/Pages\/Letting-Details\.aspx/i.test(new URL(anchor.url).pathname) &&
        isCurrentDeadline(anchor.bidDate, now),
    )
    .sort((left, right) => left.bidDate.localeCompare(right.bidDate));
  const candidatesByLetting = await mapWithConcurrency(
    lettingLinks.slice(0, 8),
    async (letting) => {
    const detailHtml = await fetchHtmlOptional(letting.url, definition, options);
    if (!detailHtml) return [];
    const byLetting = new Map<string, Candidate>();
    const detailAnchors = anchors(detailHtml, letting.url, definition.allowedHosts);
    const detailContacts = contactsFromHtml(
      detailHtml,
      letting.url,
      definition.template.owner,
    );
    const rowTextById = new Map<string, string>();
    for (const row of detailHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const text = plainText(row[1]);
      const id = ncdotContractId(text);
      if (id) rowTextById.set(id, text);
    }
    for (const anchor of detailAnchors) {
      if (!isDirectDocumentUrl(anchor.url)) continue;
      const id = ncdotContractId(`${anchor.text} ${decodeURIComponent(new URL(anchor.url).pathname)}`);
      if (!id) continue;
      const rowText = rowTextById.get(id) ?? "";
      if (/\b(?:withdrawn|cancelled|awarded)\b/i.test(rowText)) continue;
      const existing = byLetting.get(id);
      const fallback = `NCDOT advertised highway contract ${id} for the ${letting.bidDate} letting.`;
      const summary = rowText.length > 20 ? rowText : fallback;
      const document: ProjectDocument = {
        name: anchor.text || decodeURIComponent(new URL(anchor.url).pathname.split("/").pop() || "Official document"),
        kind: documentKind(anchor.text, anchor.url),
        url: anchor.url,
        access: "public",
        indexStatus: "queued",
      };
      if (existing) {
        existing.documents = uniqueDocuments([...(existing.documents ?? []), document]);
      } else {
        byLetting.set(id, {
          recordId: id,
          title: `${id} — ${summary.slice(0, 180)}`,
          summary,
          status: "Advertised",
          sourceUrl: letting.url,
          bidDate: letting.bidDate,
          documents: [document],
          participants: detailContacts,
        });
      }
    }
    return [...byLetting.values()];
    },
  );
  const byContract = new Map<string, Candidate>();
  for (const lettingCandidates of candidatesByLetting) {
    for (const candidate of lettingCandidates) {
      const existing = byContract.get(candidate.recordId);
      if (existing) {
        existing.documents = uniqueDocuments([
          ...(existing.documents ?? []),
          ...(candidate.documents ?? []),
        ]);
      } else {
        byContract.set(candidate.recordId, candidate);
      }
    }
  }
  const all = [...byContract.values()].sort((left, right) =>
    left.bidDate.localeCompare(right.bidDate) || left.recordId.localeCompare(right.recordId),
  );
  const offset = cursorOffset(sourceKey, options);
  const selected = all.slice(offset, offset + feedLimit(options));
  const projects = selected.map((candidate) =>
    buildProject(sourceKey, outputSourceId, candidate, now),
  );
  return makeResult(
    sourceKey,
    projects,
    makePage(offset, selected.length, offset + selected.length < all.length),
    now,
    all.length,
    outputSourceId,
  );
}

function thirdTuesday(year: number, month: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const day = 1 + ((2 - first.getUTCDay() + 7) % 7) + 14;
  return dateOnly(year, month, day);
}

function iowaLettingDate(label: string): string | undefined {
  const explicit = parseDateFromText(label);
  if (explicit) return explicit;
  const match = plainText(label).match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\s+Letting\b/i,
  );
  if (!match) return undefined;
  const month = MONTHS[match[1].toLowerCase()];
  return month ? thirdTuesday(Number(match[2]), month) : undefined;
}

function iowaCallGroup(order: number): string {
  if (order <= 80) return "Structures";
  if (order <= 100) return "Alternate pavement types";
  if (order <= 150) return "PCC pavement";
  if (order <= 200) return "HMA resurfacing";
  if (order <= 300) return "Surface rehabilitation";
  if (order <= 350) return "Grading";
  if (order <= 400) return "Traffic safety";
  if (order <= 450) return "Buildings and sites";
  if (order <= 500) return "Miscellaneous";
  if (order <= 600) return "Erosion control";
  if (order <= 650) return "Bridge painting";
  if (order >= 981 && order <= 999) return "Small business contract";
  return "Highway construction";
}

function iowaDocuments(
  rowHtml: string,
  sourceUrl: string,
  definition: SourceDefinition,
): ProjectDocument[] {
  return anchors(rowHtml, sourceUrl, definition.allowedHosts)
    .filter((anchor) => isDirectDocumentUrl(anchor.url))
    .map((anchor) => {
      const filename = decodeURIComponent(
        new URL(anchor.url).pathname.split("/").pop() ?? "Iowa DOT project package.zip",
      );
      const engineeringFile = /_efiles_/i.test(filename);
      return {
        name: engineeringFile
          ? `Supplemental engineering files — ${filename.replace(/\.zip$/i, "")}`
          : "Plans and estimating proposal package",
        kind: "plans" as const,
        url: anchor.url,
        access: "public" as const,
        indexStatus: "queued" as const,
      };
    });
}

async function fetchIowadot(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey = "iowa-dot-plans-estimating-proposals" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const masterHtml = await fetchHtml(IOWADOT_PLANS_URL, definition, options);
  const currentLettings = anchors(
    masterHtml,
    IOWADOT_PLANS_URL,
    definition.allowedHosts,
  )
    .map((anchor) => ({ ...anchor, bidDate: iowaLettingDate(anchor.text) }))
    .filter(
      (anchor): anchor is Anchor & { bidDate: string } =>
        /\/contracts\/biddocuments\//i.test(new URL(anchor.url).pathname) &&
        isCurrentDeadline(anchor.bidDate, now),
    )
    .sort((left, right) => left.bidDate.localeCompare(right.bidDate))
    .slice(0, 6);

  const lettingCandidates = await mapWithConcurrency(
    currentLettings,
    async (letting) => {
      const html = await fetchHtmlOptional(letting.url, definition, options);
      if (!html) return [];
      const candidates: Candidate[] = [];
      for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
          .map((cell) => plainText(cell[1]));
        if (cells.length < 5 || !/^\d{3}$/.test(cells[0])) continue;
        const order = Number(cells[0]);
        const proposalId = cells[1]?.trim();
        const county = cells[2]?.trim();
        const projectNumbers = cells[3]?.trim();
        if (!proposalId || !county || !projectNumbers) continue;
        const documents = iowaDocuments(row[1], letting.url, definition);
        if (documents.length === 0) continue;
        const callGroup = iowaCallGroup(order);
        documents.push({
          name: "Bid authorization, plan holders, and electronic submission",
          kind: "source-record",
          url: "https://bidx.com/ia/lettings",
          access: "free-account",
          indexStatus: "account-gated",
        });
        candidates.push({
          recordId: proposalId,
          title: `${proposalId} — ${county} — ${callGroup}`,
          summary: `${callGroup} proposal ${proposalId} in ${county}. Official project number${projectNumbers.includes(" ") ? "s" : ""}: ${projectNumbers}. Iowa DOT publishes the plans and estimating proposal as a project ZIP package.`,
          status: "Advertised",
          sourceUrl: letting.url,
          bidDate: letting.bidDate,
          county,
          documents,
          participants: [
            {
              name: "Iowa DOT Office of Contracts",
              role: "agency",
              participantType: "organization",
              email: "dot.contracts@iowadot.us",
              phone: "515-239-1414",
              sourceUrl: IOWADOT_PLANS_URL,
            },
          ],
        });
      }
      return candidates;
    },
  );

  const byProposal = new Map<string, Candidate>();
  for (const candidate of lettingCandidates.flat()) {
    const existing = byProposal.get(candidate.recordId);
    if (!existing || candidate.bidDate < existing.bidDate) {
      byProposal.set(candidate.recordId, candidate);
    }
  }
  const all = [...byProposal.values()].sort(
    (left, right) =>
      left.bidDate.localeCompare(right.bidDate) ||
      left.recordId.localeCompare(right.recordId),
  );
  const offset = cursorOffset(sourceKey, options);
  const selected = all.slice(offset, offset + feedLimit(options));
  const projects = selected.map((candidate) =>
    buildProject(sourceKey, outputSourceId, candidate, now),
  );
  return makeResult(
    sourceKey,
    projects,
    makePage(offset, selected.length, offset + selected.length < all.length),
    now,
    all.length,
    outputSourceId,
  );
}

interface FdotProposalProject {
  projectName?: string;
  projectDescription?: string;
  isControllingProject?: boolean;
}

interface FdotProposalRow {
  proposalName?: string;
  proposalLongDescription?: string;
  proposalShortDescription?: string;
  proposalStatus?: string;
  proposalPublicationDate?: string;
  proposalCounty?: string;
  proposalDistrictId?: number;
  proposalDistrictName?: string;
  lettingDate?: string;
  lettingTime?: string;
  lettingStatus?: string;
  isAdvertised?: boolean;
  projects?: FdotProposalProject[];
}

interface FdotDistrictContact {
  districtPhone?: string;
}

function fdotPhone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return value.trim() || undefined;
}

function fdotProposalSearchUrl(now: Date): string {
  const through = new Date(now);
  through.setUTCDate(through.getUTCDate() + 366);
  const url = new URL("https://bqa.fdot.gov/api/v1/proposal/search");
  url.searchParams.set("letting-begin", today(now));
  url.searchParams.set("letting-end", today(through));
  url.searchParams.set("letting-name", "");
  url.searchParams.set("proposal-district", "");
  url.searchParams.set("proposal-county", "");
  url.searchParams.set("proposal-name", "");
  url.searchParams.set("question-text", "");
  return url.toString();
}

function fdotRowDocuments(
  rowHtml: string,
  sourceUrl: string,
  definition: SourceDefinition,
  recordId: string,
): ProjectDocument[] {
  const documents = anchors(rowHtml, sourceUrl, definition.allowedHosts)
    .filter((anchor) => isDirectDocumentUrl(anchor.url))
    .map((anchor) => {
      const filename = decodeURIComponent(
        new URL(anchor.url).pathname.split("/").pop() ?? "FDOT document",
      );
      const isAddendum = /addend|amend/i.test(`${anchor.text} ${filename}`);
      return {
        name: isAddendum
          ? `FDOT ${recordId} addendum ${anchor.text || filename}`
          : `FDOT ${recordId} bid solicitation notice`,
        kind: isAddendum ? "addendum" as const : "source-record" as const,
        url: anchor.url,
        access: "public" as const,
        indexStatus: "queued" as const,
      };
    });
  documents.push({
    name: "Plans, specifications, and bidding documents (free FDOT account)",
    kind: "plans",
    url: FDOT_CPP_URL,
    access: "free-account",
    indexStatus: "account-gated",
  });
  return uniqueDocuments(documents);
}

async function fetchFdot(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey = "florida-dot-statewide-lettings" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const payload = await fetchHtml(fdotProposalSearchUrl(now), definition, options);
  let proposals: FdotProposalRow[];
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!Array.isArray(parsed)) throw new Error("Expected an array");
    proposals = parsed as FdotProposalRow[];
  } catch (error) {
    throw new Error(
      `FDOT statewide proposal search returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const current = proposals.filter((proposal) => {
    const bidDate = deadlineFromText(
      `${proposal.lettingDate ?? ""} ${proposal.lettingTime ?? ""}`,
    );
    return (
      proposal.isAdvertised === true &&
      /^Advertised$/i.test(proposal.proposalStatus?.trim() ?? "") &&
      /^Scheduled$/i.test(proposal.lettingStatus?.trim() ?? "") &&
      isCurrentDeadline(bidDate, now) &&
      Boolean(proposal.proposalName?.trim())
    );
  });
  const currentIds = new Set(
    current.map((proposal) => proposal.proposalName!.trim().toUpperCase()),
  );
  const districtIds = [...new Set(
    current
      .map((proposal) => proposal.proposalDistrictId)
      .filter((districtId): districtId is number => Number.isInteger(districtId)),
  )];
  const [documentPages, districtEntries] = await Promise.all([
    mapWithConcurrency(
      FDOT_DOCUMENT_INDEX_URLS,
      async (url) => ({
        url,
        html: await fetchHtmlOptional(url, definition, options),
      }),
    ),
    mapWithConcurrency(districtIds, async (districtId) => {
      const url = `https://bqa.fdot.gov/api/v1/settings/district/${districtId}`;
      const body = await fetchHtmlOptional(url, definition, options);
      if (!body) return [districtId, undefined] as const;
      try {
        return [districtId, JSON.parse(body) as FdotDistrictContact] as const;
      } catch {
        return [districtId, undefined] as const;
      }
    }),
  ]);
  const districtContacts = new Map(districtEntries);
  const documentsByProposal = new Map<string, ProjectDocument[]>();
  for (const page of documentPages) {
    if (!page.html) continue;
    for (const row of page.html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const firstCell = row[1].match(/<td\b[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? "";
      const recordId = plainText(firstCell)
        .match(/\b[A-Z][A-Z0-9-]{3,12}\b/i)?.[0]
        ?.toUpperCase();
      if (!recordId || !currentIds.has(recordId)) continue;
      documentsByProposal.set(
        recordId,
        uniqueDocuments([
          ...(documentsByProposal.get(recordId) ?? []),
          ...fdotRowDocuments(row[1], page.url, definition, recordId),
        ]),
      );
    }
  }

  const all = current.map((proposal): Candidate | undefined => {
    const recordId = proposal.proposalName?.trim().toUpperCase();
    const bidDate = deadlineFromText(
      `${proposal.lettingDate ?? ""} ${proposal.lettingTime ?? ""}`,
    );
    if (!recordId || !bidDate) return undefined;
    const county = cleanLabel(proposal.proposalCounty ?? "") || undefined;
    const workType = cleanLabel(proposal.proposalShortDescription ?? "")
      .replace(/^[\s–—-]+/, "") || "Construction";
    const projectNumbers = (proposal.projects ?? [])
      .map((project) => cleanLabel(project.projectName ?? ""))
      .filter(Boolean);
    const scope = cleanLabel(
      proposal.proposalLongDescription ??
        proposal.projects?.find((project) => project.isControllingProject)
          ?.projectDescription ??
        proposal.projects?.[0]?.projectDescription ??
        workType,
    );
    const detailUrl = `https://bqa.fdot.gov/proposal/${encodeURIComponent(recordId)}`;
    return {
      recordId,
      title: `${recordId} — ${county ?? proposal.proposalDistrictName ?? "Florida"} — ${workType}`,
      summary: `${scope}${projectNumbers.length > 0 ? ` Project number${projectNumbers.length === 1 ? "" : "s"}: ${projectNumbers.join(", ")}.` : ""}`,
      status: proposal.proposalStatus?.trim() || "Advertised",
      sourceUrl: detailUrl,
      bidDate,
      bidDateTimeZone:
        proposal.proposalDistrictId === 70
          ? "America/Chicago"
          : "America/New_York",
      postedAt: proposal.proposalPublicationDate,
      county,
      documents:
        documentsByProposal.get(recordId) ??
        fdotRowDocuments("", FDOT_ADVERTISEMENTS_URL, definition, recordId),
      participants: [
        {
          name: proposal.proposalDistrictName
            ? `FDOT ${proposal.proposalDistrictName}`
            : definition.template.owner,
          role: "agency",
          participantType: "organization",
          phone: fdotPhone(
            proposal.proposalDistrictId === undefined
              ? undefined
              : districtContacts.get(proposal.proposalDistrictId)?.districtPhone,
          ),
          sourceUrl: detailUrl,
        },
      ],
    };
  }).filter((candidate): candidate is Candidate => Boolean(candidate)).sort(
    (left, right) =>
      left.bidDate.localeCompare(right.bidDate) ||
      left.recordId.localeCompare(right.recordId),
  );
  const offset = cursorOffset(sourceKey, options);
  const selected = all.slice(offset, offset + feedLimit(options));
  const projects = selected.map((candidate) =>
    buildProject(sourceKey, outputSourceId, candidate, now),
  );
  const result = makeResult(
    sourceKey,
    projects,
    makePage(offset, selected.length, offset + selected.length < all.length),
    now,
    all.length,
    outputSourceId,
  );
  const documentFailureCount = documentPages.filter((page) => !page.html).length;
  const contactFailureCount = districtEntries.filter((entry) => !entry[1]).length;
  if (documentFailureCount > 0 || contactFailureCount > 0) {
    result.source.status = "degraded";
    result.source.snapshotComplete = false;
    result.source.note = `${result.source.note} Current check was partial: ${documentFailureCount} document index${documentFailureCount === 1 ? "" : "es"} and ${contactFailureCount} district contact lookup${contactFailureCount === 1 ? "" : "s"} could not be read.`;
  }
  return result;
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "") || undefined;
}

function responseCookieHeader(response: Response): string | undefined {
  const raw = response.headers.get("set-cookie");
  if (!raw) return undefined;
  const cookies = raw
    .split(/,(?=\s*[^;,=\s]+=[^;,]+)/)
    .map((value) => value.trim().split(";", 1)[0])
    .filter(Boolean);
  return cookies.length > 0 ? cookies.join("; ") : undefined;
}

async function requestCabbHtml(
  definition: SourceDefinition,
  dependencies: PublicDotRequestDependencies,
  init?: RequestInit,
): Promise<{ html: string; cookies?: string }> {
  const official = officialUrl(
    VDOT_CABB_URL,
    VDOT_CABB_URL,
    definition.allowedHosts,
  );
  if (!official) throw new Error("Blocked non-official VDOT CABB URL");
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  return networkScheduler(dependencies).run(async () => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      dependencies.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await fetchImpl(official, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          ...(init?.headers ?? {}),
        },
      });
      if (!response.ok) {
        throw new Error(`VDOT CABB returned HTTP ${response.status}`);
      }
      return {
        html: await response.text(),
        cookies: responseCookieHeader(response),
      };
    } finally {
      clearTimeout(timer);
    }
  });
}

function aspNetHiddenFields(html: string): URLSearchParams {
  const fields = new URLSearchParams();
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    if (htmlAttribute(tag, "type")?.toLowerCase() !== "hidden") continue;
    const name = htmlAttribute(tag, "name");
    if (!name) continue;
    fields.set(name, htmlAttribute(tag, "value") ?? "");
  }
  return fields;
}

function cabbPagerTarget(html: string, pageNumber: number): string | undefined {
  for (const match of html.matchAll(
    /<a\b[^>]*href\s*=\s*["']javascript:__doPostBack\('([^']+)'[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    if (plainText(match[2]) === String(pageNumber)) return decodeHtml(match[1]);
  }
  return undefined;
}

async function cabbSourcePage(
  offset: number,
  definition: SourceDefinition,
  options: PublicDotFeedOptions,
): Promise<string> {
  const first = await requestCabbHtml(definition, options);
  const pageNumber = Math.floor(offset / 20) + 1;
  if (pageNumber <= 1) return first.html;
  const target = cabbPagerTarget(first.html, pageNumber);
  if (!target) {
    throw new Error(`VDOT CABB did not expose pager target ${pageNumber}`);
  }
  const form = aspNetHiddenFields(first.html);
  form.set("__EVENTTARGET", target);
  form.set("__EVENTARGUMENT", "");
  const posted = await requestCabbHtml(definition, options, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(first.cookies ? { Cookie: first.cookies } : {}),
    },
    body: form.toString(),
  });
  const displayed = plainText(posted.html).match(
    /Displaying results\s+(\d+)\s*[-–—]\s*(\d+)\s*\(of\s+(\d+)\)/i,
  );
  const expectedStart = (pageNumber - 1) * 20 + 1;
  if (!displayed || Number(displayed[1]) !== expectedStart) {
    throw new Error(`VDOT CABB did not return requested page ${pageNumber}`);
  }
  return posted.html;
}

function cabbDocuments(
  rowHtml: string,
  detailUrl: string,
  definition: SourceDefinition,
  orderNumber: string,
  noticeUrl?: string,
  noticeHtml?: string,
): ProjectDocument[] {
  const documents: ProjectDocument[] = [
    {
      name: "VDOT project Q&A",
      kind: "source-record",
      url: detailUrl.replace("AdProjectInfoView.aspx", "AdQADisplayFormat.aspx"),
      access: "public",
      indexStatus: "metadata-only",
    },
  ];
  if (noticeUrl) {
    documents.push({
      name: `VDOT ${orderNumber} revisions and notices`,
      kind: "source-record",
      url: noticeUrl,
      access: "public",
      indexStatus: "metadata-only",
    });
  }
  if (noticeUrl && noticeHtml) {
    documents.push(
      ...directDocumentsFromHtml(
        noticeHtml,
        noticeUrl,
        definition.allowedHosts,
      ).map((document) => ({
        ...document,
        name: `VDOT ${orderNumber} ${document.name}`,
      })),
    );
  }
  for (const anchor of anchors(rowHtml, VDOT_CABB_URL, definition.allowedHosts)) {
    const pathname = decodeURIComponent(new URL(anchor.url).pathname);
    if (/\/ProjectWise\.aspx$/i.test(pathname)) {
      documents.push({
        name: "Electronic plans and proposal (approved ProjectWise account)",
        kind: "plans",
        url: anchor.url,
        access: "free-account",
        indexStatus: "account-gated",
      });
      continue;
    }
    if (!isDirectDocumentUrl(anchor.url)) continue;
    const planHolders = /holder/i.test(anchor.text) || /holder/i.test(pathname);
    documents.push({
      name: planHolders
        ? `VDOT ${orderNumber} plan holders`
        : `VDOT ${orderNumber} advertisement`,
      kind: "source-record",
      url: anchor.url,
      access: "public",
      indexStatus: "queued",
    });
  }
  return uniqueDocuments(documents);
}

function cabbNoticeUrl(
  rowHtml: string,
  adProjectId: string,
  definition: SourceDefinition,
): string | undefined {
  const escapedId = adProjectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    !new RegExp(`openNoticesView\\(\\s*${escapedId}\\s*\\)`, "i").test(rowHtml) ||
    !/\b\d+\s+Notices?\b/i.test(plainText(rowHtml))
  ) {
    return undefined;
  }
  return officialUrl(
    `/AdNTCInfoView.aspx?ad_prj_id=${encodeURIComponent(adProjectId)}`,
    VDOT_CABB_URL,
    definition.allowedHosts,
  );
}

async function fetchVdotCabb(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey = "virginia-dot-cabb-advertisements" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const offset = cursorOffset(sourceKey, options);
  const html = await cabbSourcePage(offset, definition, options);
  const total = Number(
    plainText(html).match(/Displaying results\s+\d+\s*[-–—]\s*\d+\s*\(of\s+(\d+)\)/i)?.[1] ?? 0,
  );
  const pairs = [...html.matchAll(
    /<tr\b[^>]*id\s*=\s*["'][^"']*row1_(\d+)["'][^>]*>([\s\S]*?)<\/tr>\s*<tr\b[^>]*id\s*=\s*["'][^"']*row2_\1["'][^>]*>([\s\S]*?)<\/tr>/gi,
  )];
  const candidates: Array<{
    candidate: Candidate;
    rowHtml: string;
    detailUrl: string;
    orderNumber: string;
    noticeUrl?: string;
  }> = [];
  for (const pair of pairs) {
    const adProjectId = pair[1];
    const firstCells = [...pair[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => plainText(cell[1]));
    const secondCells = [...pair[3].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => plainText(cell[1]));
    if (firstCells.length < 13) continue;
    const orderNumber = firstCells[2]?.trim();
    const bidDate = deadlineFromText(firstCells[6]);
    if (
      !orderNumber ||
      /\bCII\b/i.test(`${orderNumber} ${plainText(pair[2])}`) ||
      /\bWithdrawn\b/i.test(pair[0]) ||
      !isCurrentDeadline(bidDate, now)
    ) {
      continue;
    }
    const stateProjectNumber = firstCells[7]?.trim();
    const route = firstCells[8]?.trim();
    const county = firstCells[9]?.trim();
    const valueText = firstCells[10]?.replace(/[^\d.]/g, "");
    const value = valueText ? Number(valueText) : undefined;
    const description = firstCells[11]?.trim();
    const beginSite = firstCells[12]?.trim();
    const upc = secondCells[0]?.trim();
    const federalProjectNumber = secondCells[1]?.trim();
    const endSite = secondCells[2]?.trim();
    if (!county || !description) continue;
    const detailUrl = officialUrl(
      `/AdProjectInfoView.aspx?ADVAWD=1&ad_prj_id=${encodeURIComponent(adProjectId)}`,
      VDOT_CABB_URL,
      definition.allowedHosts,
    );
    if (!detailUrl) continue;
    const facts = [
      `State project ${stateProjectNumber}`,
      upc ? `UPC ${upc}` : "",
      federalProjectNumber ? `federal project ${federalProjectNumber}` : "",
      route ? `Route ${route}` : "",
      beginSite && endSite ? `${beginSite} to ${endSite}` : beginSite || endSite || "",
    ].filter(Boolean);
    const candidate: Candidate = {
      recordId: `${adProjectId}-${orderNumber.replace(/\s+/g, "-")}`,
      title: `${orderNumber} — ${county} — ${description}`,
      summary: `${description}. ${facts.join("; ")}.`,
      status: "Advertised",
      sourceUrl: detailUrl,
      bidDate,
      county,
      value: Number.isFinite(value) ? value : undefined,
      participants: [
        {
          name: "Mary \"Kiwi\" Roane",
          role: "agency",
          participantType: "person",
          organization: "VDOT Construction Division",
          email: "kiwi.roane@vdot.virginia.gov",
          phone: "804-786-2124",
          sourceUrl: VDOT_CABB_HELP_URL,
        },
      ],
    };
    candidates.push({
      candidate,
      rowHtml: pair[2],
      detailUrl,
      orderNumber,
      noticeUrl: cabbNoticeUrl(pair[2], adProjectId, definition),
    });
  }
  const hydrated = await mapWithConcurrency(candidates, async (entry) => {
    const noticeHtml = entry.noticeUrl
      ? await fetchHtmlOptional(entry.noticeUrl, definition, options)
      : undefined;
    return {
      project: buildProject(
        sourceKey,
        outputSourceId,
        {
          ...entry.candidate,
          documents: cabbDocuments(
            entry.rowHtml,
            entry.detailUrl,
            definition,
            entry.orderNumber,
            entry.noticeUrl,
            noticeHtml,
          ),
        },
        now,
      ),
      noticeFailed: Boolean(entry.noticeUrl && !noticeHtml),
    };
  });
  const projects = hydrated.map((entry) => entry.project);
  const recordsRead = pairs.length;
  const nextOffset = offset + recordsRead;
  const result = makeResult(
    sourceKey,
    projects,
    makePage(offset, recordsRead, total > nextOffset),
    now,
    total,
    outputSourceId,
  );
  result.source.recordCountUnit = "rows";
  if (hydrated.some((entry) => entry.noticeFailed)) {
    result.source.status = "degraded";
    result.source.snapshotComplete = false;
    result.source.note = `${result.source.note} At least one advertised notice page could not be read during this check.`;
  }
  return result;
}

function xmlFragment(xml: string, tagName: string): string | undefined {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return xml.match(
    new RegExp(
      `<(?:[A-Za-z_][\\w.-]*:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escaped}>`,
      "i",
    ),
  )?.[1];
}

function xmlText(xml: string, tagName: string): string | undefined {
  const fragment = xmlFragment(xml, tagName);
  if (fragment === undefined) return undefined;
  return plainText(fragment.replace(/^<!\[CDATA\[|\]\]>$/g, "")) || undefined;
}

function floatingIsoDateTime(value: string | undefined): string | undefined {
  const match = value?.trim().match(
    /^(20\d{2}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!match) return undefined;
  if (!match[2]) return match[1];
  return `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}`;
}

function cloudflareEmail(encoded: string | undefined): string | undefined {
  if (!encoded || !/^[0-9a-f]{4,512}$/i.test(encoded) || encoded.length % 2 !== 0) {
    return undefined;
  }
  const key = Number.parseInt(encoded.slice(0, 2), 16);
  let decoded = "";
  for (let index = 2; index < encoded.length; index += 2) {
    decoded += String.fromCharCode(Number.parseInt(encoded.slice(index, index + 2), 16) ^ key);
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(decoded) ? decoded.toLowerCase() : undefined;
}

function mdotBidEmail(html: string): string | undefined {
  return cloudflareEmail(
    html.match(/\bdata-cfemail\s*=\s*["']([0-9a-f]+)["']/i)?.[1],
  );
}

function mdotLettingDocuments(
  html: string,
  sourceUrl: string,
  definition: SourceDefinition,
): ProjectDocument[] {
  const labels: Record<
    string,
    { name: string; kind: ProjectDocument["kind"] }
  > = {
    "ads.pdf": { name: "MDOT letting advertisements", kind: "source-record" },
    "addendum.pdf": { name: "MDOT letting-wide addendums issued listing", kind: "source-record" },
    "estqua.pdf": { name: "MDOT letting-wide schedule of pay items", kind: "source-record" },
    "bidders.pdf": { name: "MDOT eligible bidders", kind: "source-record" },
    "hldrs.pdf": { name: "MDOT plan holders", kind: "source-record" },
    "warrantyinfo.pdf": { name: "MDOT letting-wide warranty information", kind: "source-record" },
    "printvendors.pdf": { name: "MDOT proposal and plan vendors", kind: "source-record" },
    "ebsx.zip": { name: "MDOT Project Bids EBSX letting archive", kind: "source-record" },
  };
  const documents: ProjectDocument[] = [];
  for (const anchor of anchors(html, sourceUrl, definition.allowedHosts)) {
    const url = new URL(anchor.url);
    if (!/\/BidLetting\/getFileByName\.htm$/i.test(url.pathname)) continue;
    const filename = (url.searchParams.get("fileName") ?? "")
      .split("/")
      .pop()
      ?.toLowerCase();
    const label = filename ? labels[filename] : undefined;
    if (!label) continue;
    documents.push({
      name: label.name,
      kind: label.kind,
      url: anchor.url,
      access: "public",
      indexStatus: "queued",
    });
  }
  documents.push({
    name: "Project plans and proposal (free MiLogin/eProposal account)",
    kind: "plans",
    url: "https://milogintp.michigan.gov/",
    access: "free-account",
    indexStatus: "account-gated",
  });
  return uniqueDocuments(documents);
}

function mdotGzipSize(bytes: Uint8Array): number {
  if (bytes.length < 4) return 0;
  const offset = bytes.length - 4;
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function mdotArchiveXml(archive: Uint8Array): string[] {
  let matchingEntryCount = 0;
  let expandedZipBytes = 0;
  const files = unzipSync(archive, {
    filter: (file) => {
      if (!/\.(?:ebsx|\d{3}x)$/i.test(file.name)) return false;
      matchingEntryCount += 1;
      expandedZipBytes += file.originalSize;
      if (
        matchingEntryCount > 1_000 ||
        file.originalSize > MAX_DOT_BINARY_BYTES ||
        expandedZipBytes > MAX_DOT_BINARY_BYTES
      ) {
        throw new Error("MDOT EBSX ZIP exceeds its expanded-size limit");
      }
      return true;
    },
  });
  if (Object.keys(files).length === 0) {
    throw new Error("MDOT EBSX archive did not contain project records");
  }
  const latestByContract = new Map<
    string,
    { name: string; revision: number; bytes: Uint8Array }
  >();
  for (const [name, bytes] of Object.entries(files)) {
    const filename = name.split(/[\\/]/).pop() ?? name;
    const match = filename.match(/^(.+)\.(ebsx|(\d{3})x)$/i);
    if (!match) continue;
    const revision = match[2].toLowerCase() === "ebsx" ? 0 : Number(match[3]);
    const key = match[1].toUpperCase();
    const existing = latestByContract.get(key);
    if (!existing || revision > existing.revision) {
      latestByContract.set(key, { name, revision, bytes });
    }
  }
  const xmlDocuments: string[] = [];
  let totalInflatedBytes = 0;
  for (const { name, bytes } of latestByContract.values()) {
    const expectedSize = mdotGzipSize(bytes);
    if (expectedSize <= 0 || expectedSize > 5 * 1024 * 1024) {
      throw new Error(`MDOT EBSX entry has an unsafe expanded size: ${name}`);
    }
    totalInflatedBytes += expectedSize;
    if (totalInflatedBytes > 50 * 1024 * 1024) {
      throw new Error("MDOT EBSX archive exceeds the expanded-size limit");
    }
    const inflated = gunzipSync(bytes);
    if (inflated.byteLength !== expectedSize || inflated.byteLength > 5 * 1024 * 1024) {
      throw new Error(`MDOT EBSX entry expanded unexpectedly: ${name}`);
    }
    xmlDocuments.push(strFromU8(inflated));
  }
  return xmlDocuments;
}

function xmlFragments(xml: string, tagName: string): string[] {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...xml.matchAll(
    new RegExp(
      `<(?:[A-Za-z_][\\w.-]*:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escaped}>`,
      "gi",
    ),
  )].map((match) => match[1]);
}

function mdotSearchTerms(xml: string, proposal: string): string[] {
  const terms = [
    xmlText(xml, "CallOrder"),
    xmlText(proposal, "ControllingPCN"),
    xmlText(proposal, "ControllingProjNum"),
    xmlText(proposal, "WorkTypeValue"),
    ...xmlFragments(proposal, "Project").flatMap((project) => [
      xmlText(project, "ProjectNumber"),
    ]),
    ...xmlFragments(proposal, "Item").flatMap((item) => [
      xmlText(item, "ItemNumber"),
      xmlText(item, "ItemClass"),
      xmlText(item, "DescriptionPISUPDES"),
      xmlText(item, "DescriptionIDESCRL"),
    ]),
  ];
  return [...new Set(
    terms
      .map((term) => term?.trim())
      .filter((term): term is string => Boolean(term))
      .map((term) => term.slice(0, 240)),
  )].slice(0, 5_000);
}

async function fetchMdot(
  outputSourceId: string,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const sourceKey = "michigan-dot-bid-lettings" as const;
  const definition = SOURCE_DEFINITIONS[sourceKey];
  const now = (options.now ?? (() => new Date()))();
  const masterHtml = await fetchHtml(MDOT_BID_LETTING_URL, definition, options);
  const lettings: Array<{ bidDate: string; url: string }> = [];
  let datedLettingControls = 0;
  let currentDateInputs = 0;
  let unresolvedCurrentControls = 0;
  for (const match of masterHtml.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\blettingButtons\b/i.test(htmlAttribute(tag, "class") ?? "")) continue;
    const action = htmlAttribute(tag, "onclick")?.match(
      /window\.location\.assign\(['"]([^'"]+)["']\)/i,
    )?.[1];
    const bidDate = parseDateFromText(htmlAttribute(tag, "title") ?? "");
    if (bidDate) datedLettingControls += 1;
    if (isCurrentDeadline(bidDate, now)) currentDateInputs += 1;
    const url = action
      ? officialUrl(action, MDOT_BID_LETTING_URL, definition.allowedHosts)
      : undefined;
    if (!isCurrentDeadline(bidDate, now)) continue;
    if (!url) {
      unresolvedCurrentControls += 1;
      continue;
    }
    lettings.push({ bidDate, url });
  }
  if (datedLettingControls === 0) {
    throw new Error("MDOT letting controls were not present in the response");
  }
  if (currentDateInputs > 0 && lettings.length === 0) {
    throw new Error("MDOT current letting controls could not be parsed");
  }
  if (lettings.length > 52) {
    throw new Error("MDOT returned an implausible number of current lettings");
  }

  const lettingResults = await mapWithConcurrency(
    lettings,
    async (letting) => {
      try {
        const detailHtml = await fetchHtml(letting.url, definition, options);
        const archiveUrl = anchors(
          detailHtml,
          letting.url,
          definition.allowedHosts,
        ).find((anchor) => /(?:^|\/)ebsx\.zip$/i.test(
          new URL(anchor.url).searchParams.get("fileName") ?? "",
        ))?.url;
        if (!archiveUrl) {
          throw new Error(`MDOT letting ${letting.bidDate} did not publish an EBSX archive`);
        }
        const xmlDocuments = mdotArchiveXml(
          await fetchBytes(archiveUrl, definition, options),
        );
        const sharedDocuments = mdotLettingDocuments(
          detailHtml,
          letting.url,
          definition,
        );
        const email = mdotBidEmail(detailHtml);
        const candidates: Candidate[] = [];
        let malformedRecords = 0;
        for (const xml of xmlDocuments) {
          const proposal = xmlFragment(xml, "Proposal") ?? xml;
          const county = xmlText(xmlFragment(proposal, "County") ?? "", "Name");
          const recordId = xmlText(proposal, "ContractId")?.toUpperCase();
          const bidDate = sourceLocalDateTimeToIso(
            floatingIsoDateTime(xmlText(xml, "LettingDateTime")),
            "America/Detroit",
          );
          const proposalStatus = xmlText(xml, "ProposalStatusValue");
          const lettingStatus = xmlText(xml, "LettingStatusValue");
          if (!recordId || !bidDate || !proposalStatus || !lettingStatus) {
            malformedRecords += 1;
            continue;
          }
          if (
            !isCurrentDeadline(bidDate, now) ||
            !/^Advertised$/i.test(proposalStatus) ||
            !/^Scheduled$/i.test(lettingStatus)
          ) {
            continue;
          }
          const workType = xmlText(proposal, "WorkTypeValue") ?? "Construction";
          const shortDescription = xmlText(proposal, "ShortDescription");
          const description = xmlText(proposal, "Description") ?? shortDescription ?? workType;
          const controllingProject =
            xmlText(proposal, "ControllingProjNum") ??
            xmlText(proposal, "ControllingPCN");
          candidates.push({
            recordId,
            title: `${recordId} - ${county ?? "Michigan"} - ${workType}`,
            summary: `${description.slice(0, 1_500)}${controllingProject ? ` Controlling project: ${controllingProject}.` : ""}`,
            status: proposalStatus ?? "Advertised",
            sourceUrl: letting.url,
            bidDate,
            postedAt: parseDateFromText(xmlText(xml, "LetpropDate") ?? ""),
            county,
            documents: sharedDocuments,
            participants: [
              {
                name: "MDOT Bid Letting",
                role: "agency",
                participantType: "organization",
                email,
                sourceUrl: letting.url,
              },
            ],
            searchTerms: mdotSearchTerms(xml, proposal),
          });
        }
        return { candidates, failed: malformedRecords > 0 };
      } catch {
        return { candidates: [] as Candidate[], failed: true };
      }
    },
  );

  const byContract = new Map<string, Candidate>();
  for (const candidate of lettingResults.flatMap((result) => result.candidates)) {
    const existing = byContract.get(candidate.recordId);
    if (!existing || candidate.bidDate > existing.bidDate) {
      byContract.set(candidate.recordId, candidate);
    }
  }
  const all = [...byContract.values()].sort(
    (left, right) =>
      left.bidDate.localeCompare(right.bidDate) ||
      left.recordId.localeCompare(right.recordId),
  );
  const offset = cursorOffset(sourceKey, options);
  const selected = all.slice(offset, offset + feedLimit(options));
  const projects = selected.map((candidate) =>
    buildProject(sourceKey, outputSourceId, candidate, now),
  );
  const result = makeResult(
    sourceKey,
    projects,
    makePage(offset, selected.length, offset + selected.length < all.length),
    now,
    all.length,
    outputSourceId,
  );
  const failureCount =
    unresolvedCurrentControls +
    lettingResults.filter((entry) => entry.failed).length;
  if (failureCount > 0) {
    result.source.status = "degraded";
    result.source.snapshotComplete = false;
    result.source.note = `${result.source.note} Current check was partial: ${failureCount} letting archive${failureCount === 1 ? "" : "s"} could not be read safely.`;
  }
  return result;
}

function fetchPublicDotSourceUncached(
  sourceId: PublicDotSourceId,
  options: PublicDotFeedOptions,
): Promise<PublicDotConnectorResult> {
  const outputSourceId = options.sourceId ?? sourceId;
  switch (sourceId) {
    case "washington-dot-contracting-opportunities":
      return fetchWsdot(outputSourceId, options);
    case "illinois-dot-transportation-bulletin":
      return fetchIdot(outputSourceId, options);
    case TEXAS_DOT_SOURCE_ID:
      return fetchTexasDotSource({ ...options, sourceId: outputSourceId });
    case "new-york-dot-construction-contracts":
      return fetchNysdot(outputSourceId, options);
    case "north-carolina-dot-highway-lettings":
      return fetchNcdot(outputSourceId, options);
    case "iowa-dot-plans-estimating-proposals":
      return fetchIowadot(outputSourceId, options);
    case "florida-dot-statewide-lettings":
      return fetchFdot(outputSourceId, options);
    case "virginia-dot-cabb-advertisements":
      return fetchVdotCabb(outputSourceId, options);
    case "michigan-dot-bid-lettings":
      return fetchMdot(outputSourceId, options);
    case OHIO_DOT_SOURCE_ID:
      return fetchOhioDotSource({ ...options, sourceId: outputSourceId });
    case PENNSYLVANIA_DOT_SOURCE_ID:
      return fetchPennsylvaniaDotSource(outputSourceId, options);
  }
}

export function fetchPublicDotSource(
  sourceId: PublicDotSourceId,
  options: PublicDotFeedOptions = {},
): Promise<PublicDotConnectorResult> {
  if (!PUBLIC_DOT_SOURCE_IDS.includes(sourceId)) {
    return Promise.reject(new Error(`Unknown public DOT source: ${sourceId}`));
  }
  if (!cacheableDefaultView(sourceId, options)) {
    return fetchPublicDotSourceUncached(sourceId, options);
  }

  const existing = PUBLIC_DOT_VIEW_SNAPSHOTS.get(sourceId);
  const now = Date.now();
  if (
    existing &&
    (existing.expiresAt === undefined || existing.expiresAt > now)
  ) {
    return existing.promise;
  }
  if (existing) PUBLIC_DOT_VIEW_SNAPSHOTS.delete(sourceId);

  const promise = fetchPublicDotSourceUncached(sourceId, options);
  const snapshot: PublicDotViewSnapshot = { promise };
  PUBLIC_DOT_VIEW_SNAPSHOTS.set(sourceId, snapshot);
  void promise.then(
    () => {
      if (PUBLIC_DOT_VIEW_SNAPSHOTS.get(sourceId) === snapshot) {
        snapshot.expiresAt = Date.now() + VIEW_SUCCESS_TTL_MS;
      }
    },
    () => {
      if (PUBLIC_DOT_VIEW_SNAPSHOTS.get(sourceId) === snapshot) {
        snapshot.expiresAt = Date.now() + VIEW_FAILURE_TTL_MS;
      }
    },
  );
  return promise;
}

export async function lookupPublicDotSourceProject(
  sourceId: PublicDotSourceId,
  projectIdOrRecordId: string,
  dependencies: PublicDotRequestDependencies = {},
): Promise<ProjectRecord | undefined> {
  const recordId = projectIdOrRecordId.startsWith(`${sourceId}:`)
    ? projectIdOrRecordId.slice(sourceId.length + 1)
    : projectIdOrRecordId;
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 30; pageNumber += 1) {
    const result = await fetchPublicDotSource(sourceId, {
      ...dependencies,
      mode: "ingest",
      sourceCursors: { [sourceId]: { offset } },
    });
    const found = result.projects.find(
      (project) =>
        project.id === projectIdOrRecordId ||
        project.sourceRecordId.toLowerCase() === recordId.toLowerCase(),
    );
    if (found) {
      if (sourceId !== PENNSYLVANIA_DOT_SOURCE_ID) return found;
      try {
        const enrichment = await fetchPennsylvaniaDotProjectEnrichment(
          found.sourceRecordId,
          dependencies,
        );
        const participantKeys = new Set<string>();
        const participants = [
          ...enrichment.participants,
          ...found.participants,
        ].filter((participant) => {
          const key = [
            participant.role,
            participant.name,
            participant.organization,
            participant.email,
            participant.phone,
          ].join("|").toLowerCase();
          if (participantKeys.has(key)) return false;
          participantKeys.add(key);
          return true;
        });
        return {
          ...found,
          documents: uniqueDocuments([
            ...enrichment.documents,
            ...found.documents,
          ]),
          participants,
          searchableFields: [
            ...(found.searchableFields ?? []),
            ...enrichment.planholders.flatMap((planholder) => [
              planholder.contractor,
              planholder.contractorType ?? "",
              planholder.contact ?? "",
              planholder.address ?? "",
            ]),
          ].filter(Boolean),
        };
      } catch {
        return found;
      }
    }
    if (!result.page.hasMore || result.page.nextOffset <= offset) return undefined;
    offset = result.page.nextOffset;
  }
  return undefined;
}

export async function lookupPublicDotProject(
  projectId: string,
  dependencies: PublicDotRequestDependencies = {},
): Promise<ProjectRecord | undefined> {
  const prefixed = PUBLIC_DOT_SOURCE_IDS.find((sourceId) =>
    projectId.startsWith(`${sourceId}:`),
  );
  if (prefixed) {
    return lookupPublicDotSourceProject(prefixed, projectId, dependencies);
  }
  for (const sourceId of PUBLIC_DOT_SOURCE_IDS) {
    const project = await lookupPublicDotSourceProject(
      sourceId,
      projectId,
      dependencies,
    );
    if (project) return project;
  }
  return undefined;
}
