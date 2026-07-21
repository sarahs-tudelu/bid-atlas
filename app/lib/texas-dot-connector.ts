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
import {
  calendarDateInTimeZone,
  sourceLocalDateTimeToIso,
} from "./deadline-time.ts";

export const TEXAS_DOT_SOURCE_ID =
  "texas-dot-state-let-construction" as const;

export const TEXAS_DOT_LETTING_URL =
  "https://www.txdot.gov/business/road-bridge-maintenance/contract-letting.html";
export const TEXAS_DOT_ORDER_VIEW_URL =
  "https://tableau.txdot.gov/views/ListShowingOrderReportinternal-PreProd/ListShowingOrder?:showVizHome=no";
export const TEXAS_DOT_ORDER_CSV_URL =
  "https://tableau.txdot.gov/views/ListShowingOrderReportinternal-PreProd/ListShowingOrder.csv?:showVizHome=no";
export const TEXAS_DOT_BIDDERS_CSV_URL =
  "https://tableau.txdot.gov/views/BiddersList/BiddersProposalStatus.csv?:showVizHome=no";
export const TEXAS_DOT_CHANGES_CSV_URL =
  "https://tableau.txdot.gov/views/CanceledorChangedProjects/CanceledorChangedProjects.csv?:showVizHome=no";
export const TEXAS_DOT_BID_ITEMS_API_URL =
  "https://data.texas.gov/resource/qh8x-rm8r.json";
export const TEXAS_DOT_BID_ITEMS_DATASET_URL =
  "https://data.texas.gov/dataset/Official-and-Unofficial-Bid-Items/qh8x-rm8r";
export const TEXAS_DOT_PLANS_LICENSE_URL =
  "https://www.dot.state.tx.us/business/plansonline/agreement.htm";

const TEXAS_DOT_FTP_ROOTS = [
  "https://ftp.txdot.gov/plans/State-Let-Construction/",
  "https://ftp.txdot.gov/plans/State-Let-Maintenance/",
] as const;
const TEXAS_DOT_TIME_ZONE = "America/Chicago" as const;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CONCURRENCY = 3;
const MAX_REDIRECTS = 4;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_CSV_ROWS = 5_000;
const MAX_DIRECTORY_FILES = 2_000;
const MAX_PLAN_HOLDERS_PER_PROJECT = 250;
const VIEW_LIMIT = 20;
const INGEST_LIMIT = 50;

const OFFICIAL_HOSTS = new Set([
  "www.txdot.gov",
  "txdot.gov",
  "www.dot.state.tx.us",
  "ftp.txdot.gov",
  "tableau.txdot.gov",
  "data.texas.gov",
]);

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const FULL_MONTHS = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const TEXAS_DOT_SOURCE_TEMPLATE: PublicDotSourceTemplate = {
  id: TEXAS_DOT_SOURCE_ID,
  name: "TxDOT State-Let Construction and Maintenance",
  owner: "Texas Department of Transportation",
  level: "state",
  sourceClass: "procurement",
  stages: ["bidding"],
  access: "open",
  cadence: "Daily",
  url: TEXAS_DOT_LETTING_URL,
  jurisdiction: "Texas",
  note: "Official current TxDOT state-let construction and maintenance projects joined by controlling CSJ across the order-of-bids report, authoritative bid-item deadline data, public plan and proposal archives, addenda, revisions, and authorized proposal-requester list. An authorized proposal requester is shown as a plan holder, not as proof that the vendor submitted a bid. TxDOT plan-package links remain direct metadata-only links because downloading is subject to the TxDOT Plans Online license agreement; BidAtlas does not automatically copy or index those files.",
};

export interface TexasDotFeedOptions extends PublicDotFeedOptions {
  /** Testable lower ceiling; callers cannot raise the production safety limit. */
  maxTextBytes?: number;
}

interface Scheduler {
  run<T>(work: () => Promise<T>): Promise<T>;
}

interface LettingWindow {
  start: string;
  end: string;
  year: number;
  month: number;
}

type FolderKind = "plans" | "specifications" | "addendum";

interface OfficialFolder {
  url: string;
  label: string;
  kind: FolderKind;
}

interface ArchivedFile {
  csj: string;
  document: ProjectDocument;
}

interface OrderRecord {
  csj: string;
  /** Calendar date published in the order report, in America/Chicago. */
  bidDate: string;
  /** Authoritative bid deadline converted from TxDOT local time to UTC. */
  bidDeadline?: string;
  proposalPhone?: string;
  county: string;
  district: string;
  highway: string;
  limitsFrom: string;
  limitsTo: string;
  projectNumber: string;
  sequenceNumber: string;
  shortDescription: string;
  dbeGoal?: string;
  length?: string;
}

interface AuthoritativeDeadline {
  csj: string;
  localDate: string;
  instant: string;
  proposalPhone?: string;
}

interface PlanHolderRecord {
  csj: string;
  bidDate: string;
  vendor: string;
  email?: string;
  sourceUrl: string;
}

interface CandidateProject {
  order: OrderRecord;
  documents: ProjectDocument[];
  planHolders: PlanHolderRecord[];
}

class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

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

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&ndash;|&mdash;/gi, "-")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
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

function cleanText(value: string | undefined): string {
  return decodeHtml(value ?? "").replace(/\s+/g, " ").trim();
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp(
      `\\b${escaped}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`,
      "i",
    ),
  );
  return decodeHtml(match?.[1] ?? match?.[2] ?? "") || undefined;
}

function assertOfficialUrl(value: string, base?: string): URL {
  let url: URL;
  try {
    url = new URL(decodeHtml(value.trim()), base);
  } catch {
    throw new Error(`Invalid TxDOT URL: ${value}`);
  }
  if (
    url.protocol !== "https:" ||
    !OFFICIAL_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error(`Blocked non-official TxDOT URL: ${url.toString()}`);
  }
  if (
    url.hostname.toLowerCase() === "ftp.txdot.gov" &&
    !TEXAS_DOT_FTP_ROOTS.some(
      (root) => url.pathname.startsWith(new URL(root).pathname),
    )
  ) {
    throw new Error(`Blocked out-of-scope TxDOT archive URL: ${url.toString()}`);
  }
  url.hash = "";
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

async function boundedText(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel();
    throw new Error(`TxDOT response exceeds ${limit} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("TxDOT response safety limit exceeded");
        throw new Error(`TxDOT response exceeds ${limit} bytes`);
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function fetchOfficialText(
  urlValue: string,
  accept: string,
  options: TexasDotFeedOptions,
  scheduler: Scheduler,
): Promise<string> {
  const initialUrl = assertOfficialUrl(urlValue).toString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestedLimit = options.maxTextBytes;
  const byteLimit =
    Number.isInteger(requestedLimit) && (requestedLimit ?? 0) > 0
      ? Math.min(requestedLimit as number, MAX_TEXT_BYTES)
      : MAX_TEXT_BYTES;
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
          let url = initialUrl;
          for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
            const response = await fetchImpl(url, {
              signal: controller.signal,
              redirect: "manual",
              headers: { Accept: accept },
            });
            if (response.status >= 300 && response.status < 400) {
              const location = response.headers.get("location");
              await response.body?.cancel();
              if (!location || redirect === MAX_REDIRECTS) {
                throw new Error("TxDOT returned an invalid redirect chain");
              }
              url = assertOfficialUrl(location, url).toString();
              continue;
            }
            if (response.url) assertOfficialUrl(response.url);
            if (!response.ok) {
              await response.body?.cancel();
              throw new HttpStatusError(
                `TxDOT returned HTTP ${response.status}: ${url}`,
                response.status,
                retryDelay(response),
              );
            }
            return boundedText(response, byteLimit);
          }
          throw new Error("TxDOT exceeded its redirect safety limit");
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

function dateOnly(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`TxDOT published an invalid date: ${month}/${day}/${year}`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function centralDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TEXAS_DOT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return dateOnly(value("year"), value("month"), value("day"));
}

function lettingWindows(html: string): LettingWindow[] {
  const text = plainText(html);
  const windows: LettingWindow[] = [];
  const pattern = /\b(January|February|March|April|May|June|July|August|September|Sept|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:\s*[\u2013\u2014-]\s*(\d{1,2}))?,?\s+(20\d{2})\b/gi;
  for (const match of text.matchAll(pattern)) {
    const month = MONTHS[match[1].toLowerCase()];
    const year = Number(match[4]);
    const startDay = Number(match[2]);
    const endDay = Number(match[3] ?? match[2]);
    if (!month || endDay < startDay) continue;
    windows.push({
      start: dateOnly(year, month, startDay),
      end: dateOnly(year, month, endDay),
      year,
      month,
    });
  }
  return windows.sort(
    (left, right) =>
      left.start.localeCompare(right.start) || left.end.localeCompare(right.end),
  );
}

function currentLettingWindow(html: string, today: string): LettingWindow {
  const windows = lettingWindows(html);
  const current = windows.find((window) => window.end >= today);
  if (!current) {
    throw new Error("TxDOT did not publish a current or future statewide letting date");
  }
  return current;
}

function monthlyArchiveUrls(window: LettingWindow): string[] {
  const month = String(window.month).padStart(2, "0");
  const segment = encodeURIComponent(`${month} ${FULL_MONTHS[window.month]}`);
  return TEXAS_DOT_FTP_ROOTS.map((root) =>
    assertOfficialUrl(`${root}${window.year}/${segment}/`).toString(),
  );
}

function anchors(html: string, baseUrl: string): Array<{ url: string; text: string }> {
  const result: Array<{ url: string; text: string }> = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = htmlAttribute(match[1], "href");
    if (!href || /^javascript:/i.test(href)) continue;
    try {
      result.push({
        url: assertOfficialUrl(href, baseUrl).toString(),
        text: plainText(match[2]),
      });
    } catch {
      // Ignore malformed, off-site, and out-of-scope archive navigation.
    }
  }
  return result;
}

function folderKind(label: string): FolderKind | undefined {
  const normalized = label.replace(/\/+$/, "").trim();
  if (/proposal\s+addenda|revisions?$/i.test(normalized)) return "addendum";
  if (/contract\s+plans?$/i.test(normalized)) return undefined;
  if (/plans?$/i.test(normalized)) return "plans";
  if (/proposals?$/i.test(normalized)) return "specifications";
  return undefined;
}

function officialFolders(html: string, rootUrl: string): OfficialFolder[] {
  const root = assertOfficialUrl(rootUrl);
  const folders: OfficialFolder[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors(html, rootUrl)) {
    const url = assertOfficialUrl(anchor.url);
    if (!url.pathname.startsWith(root.pathname) || !url.pathname.endsWith("/")) {
      continue;
    }
    const relative = safeDecode(url.pathname.slice(root.pathname.length));
    if (!relative || relative.slice(0, -1).includes("/")) continue;
    const label = cleanText(anchor.text || relative);
    const kind = folderKind(label);
    if (!kind || seen.has(url.toString())) continue;
    seen.add(url.toString());
    folders.push({ url: url.toString(), label, kind });
  }
  const hasPlans = folders.some((folder) => folder.kind === "plans");
  const hasProposals = folders.some(
    (folder) => folder.kind === "specifications",
  );
  if (!hasPlans || !hasProposals) {
    throw new Error(
      "TxDOT current archive is missing its public plans or proposals directory; refusing a false live-zero result",
    );
  }
  return folders.slice(0, 8);
}

function normalizeCsj(value: string): string | undefined {
  return value.match(/\b(\d{4}-\d{2}-\d{3})(?!\d)/)?.[1];
}

function filesFromFolder(html: string, folder: OfficialFolder): ArchivedFile[] {
  const root = assertOfficialUrl(folder.url);
  const files: ArchivedFile[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors(html, folder.url)) {
    const url = assertOfficialUrl(anchor.url);
    if (!url.pathname.startsWith(root.pathname) || url.pathname.endsWith("/")) {
      continue;
    }
    const relative = url.pathname.slice(root.pathname.length);
    if (!relative || safeDecode(relative).includes("/")) continue;
    const filename = safeDecode(relative);
    if (!/\.(?:pdf|zip|dgn|dwg)$/i.test(filename)) continue;
    const csj = normalizeCsj(`${anchor.text} ${filename}`);
    if (!csj || seen.has(url.toString())) continue;
    seen.add(url.toString());
    files.push({
      csj,
      document: {
        name: cleanText(anchor.text) || filename,
        kind: folder.kind,
        url: url.toString(),
        access: "public",
        indexStatus: "metadata-only",
      },
    });
    if (files.length > MAX_DIRECTORY_FILES) {
      throw new Error(
        `TxDOT archive directory exceeds ${MAX_DIRECTORY_FILES} documents`,
      );
    }
  }
  return files;
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field.trim());
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, "").trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
      if (rows.length > MAX_CSV_ROWS + 1) {
        throw new Error(`TxDOT CSV exceeds ${MAX_CSV_ROWS} data rows`);
      }
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("TxDOT returned an unterminated CSV field");
  row.push(field.replace(/\r$/, "").trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length > MAX_CSV_ROWS + 1) {
    throw new Error(`TxDOT CSV exceeds ${MAX_CSV_ROWS} data rows`);
  }
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows;
}

function csvTable(
  csv: string,
  requiredHeaders: readonly string[],
): { headers: Map<string, number>; rows: string[][] } {
  const parsed = parseCsv(csv);
  const header = parsed[0] ?? [];
  const headers = new Map(
    header.map((value, index) => [value.trim().toUpperCase(), index]),
  );
  for (const required of requiredHeaders) {
    if (!headers.has(required.toUpperCase())) {
      throw new Error(`TxDOT CSV is missing required column: ${required}`);
    }
  }
  return { headers, rows: parsed.slice(1) };
}

function csvValue(
  row: readonly string[],
  headers: ReadonlyMap<string, number>,
  name: string,
): string {
  const index = headers.get(name.toUpperCase());
  return index === undefined ? "" : cleanText(row[index]);
}

function parseUsDate(value: string): string | undefined {
  const numeric = value.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (numeric) {
    return dateOnly(Number(numeric[3]), Number(numeric[1]), Number(numeric[2]));
  }
  const named = value.match(
    /\b(January|February|March|April|May|June|July|August|September|Sept|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i,
  );
  const month = named ? MONTHS[named[1].toLowerCase()] : undefined;
  return named && month
    ? dateOnly(Number(named[3]), month, Number(named[2]))
    : undefined;
}

function authoritativeDeadlineUrl(window: LettingWindow): string {
  const params = new URLSearchParams({
    "$select":
      "controlling_project_id_ccsj,bid_recieved_until_date_and,proposal_phone_number",
    "$where":
      `let_type='Statewide Let' AND proposal_status='Official' AND bid_recieved_until_date_and between '${window.start}T00:00:00' and '${window.end}T23:59:59'`,
    "$group":
      "controlling_project_id_ccsj,bid_recieved_until_date_and,proposal_phone_number",
    "$order":
      "bid_recieved_until_date_and,controlling_project_id_ccsj",
    "$limit": String(MAX_CSV_ROWS),
  });
  return assertOfficialUrl(`${TEXAS_DOT_BID_ITEMS_API_URL}?${params}`).toString();
}

function authoritativeDeadlines(
  json: string,
  window: LettingWindow,
): Map<string, AuthoritativeDeadline> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("TxDOT authoritative bid-item dataset returned invalid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("TxDOT authoritative bid-item dataset did not return an array");
  }
  if (parsed.length > MAX_CSV_ROWS) {
    throw new Error(
      `TxDOT authoritative bid-item dataset exceeds ${MAX_CSV_ROWS} grouped projects`,
    );
  }

  const deadlines = new Map<string, AuthoritativeDeadline>();
  for (const value of parsed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("TxDOT authoritative bid-item dataset contains a malformed row");
    }
    const row = value as Record<string, unknown>;
    const rawCsj = row.controlling_project_id_ccsj;
    const rawDeadline = row.bid_recieved_until_date_and;
    const rawProposalPhone = row.proposal_phone_number;
    const csj = typeof rawCsj === "string" ? normalizeCsj(rawCsj) : undefined;
    const instant =
      typeof rawDeadline === "string"
        ? sourceLocalDateTimeToIso(rawDeadline, TEXAS_DOT_TIME_ZONE)
        : undefined;
    if (!csj || !instant) {
      throw new Error(
        "TxDOT authoritative bid-item dataset contains an invalid CSJ or deadline",
      );
    }
    const proposalPhone =
      typeof rawProposalPhone === "string"
        ? rawProposalPhone.replace(/\D/g, "")
        : typeof rawProposalPhone === "number" && Number.isFinite(rawProposalPhone)
          ? String(Math.trunc(rawProposalPhone))
          : undefined;
    const normalizedProposalPhone =
      proposalPhone && /^\d{10}$/.test(proposalPhone)
        ? `${proposalPhone.slice(0, 3)}-${proposalPhone.slice(3, 6)}-${proposalPhone.slice(6)}`
        : undefined;
    const localDate = calendarDateInTimeZone(
      new Date(instant),
      TEXAS_DOT_TIME_ZONE,
    );
    if (localDate < window.start || localDate > window.end) {
      throw new Error(
        `TxDOT authoritative deadline for CSJ ${csj} falls outside the selected letting`,
      );
    }
    const current = deadlines.get(csj);
    if (
      current &&
      (current.instant !== instant ||
        (current.proposalPhone &&
          normalizedProposalPhone &&
          current.proposalPhone !== normalizedProposalPhone))
    ) {
      throw new Error(
        `TxDOT published conflicting authoritative deadlines for CSJ ${csj}`,
      );
    }
    deadlines.set(csj, {
      csj,
      localDate,
      instant,
      proposalPhone: current?.proposalPhone ?? normalizedProposalPhone,
    });
  }
  return deadlines;
}

const ORDER_HEADERS = [
  "BID RECEIVED UNTIL DATE",
  "CCSJ",
  "COUNTY",
  "DISTRICT",
  "HIGHWAY",
  "LIMITS FROM",
  "LIMITS TO",
  "MEASURE NAMES",
  "PROJ NUMBER",
  "SEQUENCE NUMBER",
  "SHORT DESCRIPTION",
  "MEASURE VALUES",
] as const;

function orderRecords(csv: string, window: LettingWindow): Map<string, OrderRecord> {
  const table = csvTable(csv, ORDER_HEADERS);
  const records = new Map<string, OrderRecord>();
  for (const row of table.rows) {
    const csj = normalizeCsj(csvValue(row, table.headers, "CCSJ"));
    const bidDate = parseUsDate(
      csvValue(row, table.headers, "BID RECEIVED UNTIL DATE"),
    );
    if (!csj || !bidDate || bidDate < window.start || bidDate > window.end) {
      continue;
    }
    const current = records.get(csj) ?? {
      csj,
      bidDate,
      county: csvValue(row, table.headers, "COUNTY"),
      district: csvValue(row, table.headers, "DISTRICT"),
      highway: csvValue(row, table.headers, "HIGHWAY"),
      limitsFrom: csvValue(row, table.headers, "LIMITS FROM"),
      limitsTo: csvValue(row, table.headers, "LIMITS TO"),
      projectNumber: csvValue(row, table.headers, "PROJ NUMBER"),
      sequenceNumber: csvValue(row, table.headers, "SEQUENCE NUMBER"),
      shortDescription: csvValue(row, table.headers, "SHORT DESCRIPTION"),
    };
    if (current.bidDate !== bidDate) {
      throw new Error(`TxDOT published conflicting letting dates for CSJ ${csj}`);
    }
    const measure = csvValue(row, table.headers, "MEASURE NAMES");
    const measureValue = csvValue(row, table.headers, "MEASURE VALUES");
    if (/DBE\s+GOAL/i.test(measure)) current.dbeGoal = measureValue;
    if (/LENGTH/i.test(measure)) current.length = measureValue;
    records.set(csj, current);
  }
  if (records.size === 0) {
    throw new Error(
      "TxDOT order-of-bids report has no rows for the current statewide letting; refusing a false live-zero result",
    );
  }
  return records;
}

const BIDDER_HEADERS = [
  "CONTROLLING PROJECT ID",
  "EMAIL",
  "LET DATE",
  "LET TYPE",
  "LINK",
  "PROPOSALS REQUEST",
  "VENDOR NAME",
] as const;

function planHolderRecords(csv: string): Map<string, PlanHolderRecord[]> {
  const table = csvTable(csv, BIDDER_HEADERS);
  const records = new Map<string, PlanHolderRecord[]>();
  for (const row of table.rows) {
    const csj = normalizeCsj(
      csvValue(row, table.headers, "CONTROLLING PROJECT ID"),
    );
    const bidDate = parseUsDate(csvValue(row, table.headers, "LET DATE"));
    const letType = csvValue(row, table.headers, "LET TYPE");
    const request = csvValue(row, table.headers, "PROPOSALS REQUEST");
    const vendor = csvValue(row, table.headers, "VENDOR NAME");
    if (
      !csj ||
      !bidDate ||
      !vendor ||
      !/^Statewide Let\b/i.test(letType) ||
      !/^Authorized Bidder$/i.test(request)
    ) {
      continue;
    }
    const rawEmail = csvValue(row, table.headers, "EMAIL").toLowerCase();
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)
      ? rawEmail
      : undefined;
    const rawLink = csvValue(row, table.headers, "LINK");
    let sourceUrl = TEXAS_DOT_BIDDERS_CSV_URL;
    if (rawLink) {
      try {
        sourceUrl = assertOfficialUrl(rawLink).toString();
      } catch {
        // Keep the official proposal-requester index when a row contains a bad link.
      }
    }
    const group = records.get(csj) ?? [];
    if (
      !group.some(
        (entry) =>
          entry.bidDate === bidDate &&
          entry.vendor.toLowerCase() === vendor.toLowerCase() &&
          entry.email === email,
      )
    ) {
      group.push({ csj, bidDate, vendor, email, sourceUrl });
    }
    records.set(csj, group);
  }
  return records;
}

const CHANGES_HEADERS = [
  "CHANGE",
  "CONTROLLING PROJECT ID (CCSJ)",
  "PROJECT TYPE",
] as const;

function excludedChangedProjects(
  csv: string,
  window: LettingWindow,
): Set<string> {
  const table = csvTable(csv, CHANGES_HEADERS);
  const result = new Set<string>();
  const currentLetting = `${FULL_MONTHS[window.month]} ${window.year}`;
  for (const row of table.rows) {
    const csj = normalizeCsj(
      csvValue(row, table.headers, "CONTROLLING PROJECT ID (CCSJ)"),
    );
    const projectType = csvValue(row, table.headers, "PROJECT TYPE");
    const change = csvValue(row, table.headers, "CHANGE");
    if (
      !csj ||
      (projectType && !/\b(?:CONSTRUCTION|MAINTENANCE)\b/i.test(projectType))
    ) {
      continue;
    }
    const cancelled = /\bCANCEL(?:L)?ED\b/i.test(change);
    const movedFromCurrentLetting =
      /\b(?:DELAYED|POSTPONED|RESCHEDULED)\b/i.test(change) &&
      change.toLowerCase().includes(currentLetting.toLowerCase());
    if (cancelled || movedFromCurrentLetting) result.add(csj);
  }
  return result;
}

function byCsj(files: readonly ArchivedFile[]): Map<string, ProjectDocument[]> {
  const result = new Map<string, ProjectDocument[]>();
  for (const file of files) {
    const documents = result.get(file.csj) ?? [];
    if (!documents.some((document) => document.url === file.document.url)) {
      documents.push(file.document);
    }
    result.set(file.csj, documents);
  }
  return result;
}

function setDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/\b(?:Us|Sh|Ih|Fm|Rm)\b/g, (token) => token.toUpperCase());
}

function projectSummary(order: OrderRecord): string {
  const description = titleCase(order.shortDescription || "State-let highway work");
  const highway = order.highway ? ` on ${order.highway}` : "";
  const limits = [order.limitsFrom, order.limitsTo]
    .filter((value) => value && value !== ".")
    .join(" to ");
  const location = limits ? ` from ${limits}` : "";
  const district = order.district ? ` ${titleCase(order.district)} District.` : "";
  const project = order.projectNumber
    ? ` TxDOT project ${order.projectNumber}.`
    : "";
  return `${description}${highway}${location}.${district}${project}`
    .replace(/\.\s*\./g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function participantsFor(candidate: CandidateProject): {
  participants: ProjectParticipant[];
  truncated: boolean;
} {
  const matching = candidate.planHolders.filter(
    (planHolder) => planHolder.bidDate === candidate.order.bidDate,
  );
  const truncated = matching.length > MAX_PLAN_HOLDERS_PER_PROJECT;
  const participants: ProjectParticipant[] = [
    {
      name: "Texas Department of Transportation - Construction Division",
      role: "agency",
      participantType: "organization",
      phone: candidate.order.proposalPhone,
      sourceUrl: TEXAS_DOT_BID_ITEMS_DATASET_URL,
    },
    ...matching.slice(0, MAX_PLAN_HOLDERS_PER_PROJECT).map(
      (planHolder): ProjectParticipant => ({
        name: planHolder.vendor,
        role: "plan-holder",
        participantType: "organization",
        email: planHolder.email,
        sourceUrl: planHolder.sourceUrl,
      }),
    ),
  ];
  return { participants, truncated };
}

function sourceRecordDocument(): ProjectDocument {
  return {
    name: "Official TxDOT order of bids",
    kind: "source-record",
    url: TEXAS_DOT_ORDER_VIEW_URL,
    access: "public",
    indexStatus: "metadata-only",
  };
}

function plansLicenseDocument(): ProjectDocument {
  return {
    name: "TxDOT Plans Online license agreement",
    kind: "source-record",
    url: TEXAS_DOT_PLANS_LICENSE_URL,
    access: "public",
    indexStatus: "metadata-only",
  };
}

function buildProject(
  candidate: CandidateProject,
  outputSourceId: string,
  now: Date,
): { project: ProjectRecord; contactsTruncated: boolean } {
  const { order } = candidate;
  const contacts = participantsFor(candidate);
  const county = titleCase(order.county || "Texas");
  const description = titleCase(
    order.shortDescription || "State-let highway work",
  );
  const documents = [
    sourceRecordDocument(),
    plansLicenseDocument(),
    ...candidate.documents,
  ].filter(
    (document, index, all) =>
      all.findIndex((entry) => entry.url === document.url) === index,
  );
  const publishedBidDate = order.bidDeadline ?? order.bidDate;
  const deadlineIsDateOnly = /T00:00:00(?:\.000)?Z$/i.test(publishedBidDate);
  return {
    project: {
      id: `${outputSourceId}:${order.csj}`,
      sourceId: outputSourceId,
      sourceRecordId: order.csj,
      title: `${county} County - ${description} (${order.csj})`,
      summary: projectSummary(order),
      stage: "bidding",
      status: !deadlineIsDateOnly
        ? `Advertised - bids received until ${publishedBidDate}`
        : `Advertised - bid date ${order.bidDate.slice(0, 10)}; deadline time not published`,
      agency: TEXAS_DOT_SOURCE_TEMPLATE.owner,
      county,
      state: "Texas",
      bidDate: publishedBidDate,
      bidDateTimeZone: TEXAS_DOT_TIME_ZONE,
      updatedAt: now.toISOString(),
      sourceName: TEXAS_DOT_SOURCE_TEMPLATE.name,
      sourceUrl: TEXAS_DOT_ORDER_VIEW_URL,
      provenance: "live-public-page",
      confidence: "official",
      documents,
      participants: contacts.participants,
      searchableFields: [
        order.csj,
        order.projectNumber,
        order.sequenceNumber,
        order.shortDescription,
        order.county,
        order.district,
        order.highway,
        order.limitsFrom,
        order.limitsTo,
        order.dbeGoal ? `DBE goal ${order.dbeGoal}` : "",
        order.length ? `length ${order.length}` : "",
        ...contacts.participants.map((participant) => participant.name),
      ].filter(Boolean),
      documentTextIndexed: false,
    },
    contactsTruncated: contacts.truncated,
  };
}

function pageRecord(
  offset: number,
  projects: readonly ProjectRecord[],
  total: number,
): SourcePageRecord {
  const nextOffset = offset + projects.length;
  const last = projects.at(-1);
  return {
    offset,
    recordsRead: projects.length,
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

function safeOffset(value: number | undefined): number {
  return Number.isInteger(value) && (value ?? 0) >= 0 ? (value as number) : 0;
}

export async function fetchTexasDotSource(
  options: TexasDotFeedOptions = {},
): Promise<PublicDotConnectorResult> {
  const now = (options.now ?? (() => new Date()))();
  const today = centralDate(now);
  const scheduler = createScheduler();
  const outputSourceId = options.sourceId ?? TEXAS_DOT_SOURCE_ID;
  const scheduleHtml = await fetchOfficialText(
    TEXAS_DOT_LETTING_URL,
    "text/html,application/xhtml+xml",
    options,
    scheduler,
  );
  const window = currentLettingWindow(scheduleHtml, today);
  const archiveUrls = monthlyArchiveUrls(window);
  const deadlineUrl = authoritativeDeadlineUrl(window);
  let deadlineJson: string | undefined;
  let planHolderCsv: string | undefined;
  let changesCsv: string | undefined;
  const [orderCsv, archiveHtmls] = await Promise.all([
    fetchOfficialText(
      TEXAS_DOT_ORDER_CSV_URL,
      "text/csv,text/plain;q=0.9,*/*;q=0.1",
      options,
      scheduler,
    ),
    Promise.all(
      archiveUrls.map((archiveUrl) =>
        fetchOfficialText(
          archiveUrl,
          "text/html,application/xhtml+xml",
          options,
          scheduler,
        ),
      ),
    ),
    fetchOfficialText(
      deadlineUrl,
      "application/json",
      options,
      scheduler,
    ).then(
      (value) => {
        deadlineJson = value;
      },
      () => undefined,
    ),
    fetchOfficialText(
      TEXAS_DOT_BIDDERS_CSV_URL,
      "text/csv,text/plain;q=0.9,*/*;q=0.1",
      options,
      scheduler,
    ).then(
      (value) => {
        planHolderCsv = value;
      },
      () => undefined,
    ),
    fetchOfficialText(
      TEXAS_DOT_CHANGES_CSV_URL,
      "text/csv,text/plain;q=0.9,*/*;q=0.1",
      options,
      scheduler,
    ).then(
      (value) => {
        changesCsv = value;
      },
      () => undefined,
    ),
  ]);
  const folders = archiveHtmls.flatMap((archiveHtml, index) =>
    officialFolders(archiveHtml, archiveUrls[index]),
  );
  const folderFiles = await Promise.all(
    folders.map(async (folder) =>
      filesFromFolder(
        await fetchOfficialText(
          folder.url,
          "text/html,application/xhtml+xml",
          options,
          scheduler,
        ),
        folder,
      ),
    ),
  );
  const files = folderFiles.flat();
  const planFiles = files.filter((file) => file.document.kind === "plans");
  const proposalFiles = files.filter(
    (file) => file.document.kind === "specifications",
  );
  if (planFiles.length === 0 || proposalFiles.length === 0) {
    throw new Error(
      "TxDOT current archive contains no public plan or proposal files; refusing a false live-zero result",
    );
  }
  const plansByCsj = byCsj(planFiles);
  const proposalsByCsj = byCsj(proposalFiles);
  const addendaByCsj = byCsj(
    files.filter((file) => file.document.kind === "addendum"),
  );
  const planIds = new Set(plansByCsj.keys());
  const proposalIds = new Set(proposalsByCsj.keys());
  const orderByCsj = orderRecords(orderCsv, window);
  const deadlinesByCsj = deadlineJson
    ? authoritativeDeadlines(deadlineJson, window)
    : new Map<string, AuthoritativeDeadline>();
  const planHoldersByCsj = planHolderCsv
    ? planHolderRecords(planHolderCsv)
    : new Map<string, PlanHolderRecord[]>();
  const excludedCsjs = changesCsv
    ? excludedChangedProjects(changesCsv, window)
    : new Set<string>();
  const allDocumentIds = new Set([...planIds, ...proposalIds]);
  const incompleteDocumentIds = new Set([
    ...setDifference(planIds, proposalIds),
    ...setDifference(proposalIds, planIds),
  ]);
  const missingOrderIds = new Set(
    [...allDocumentIds].filter((csj) => !orderByCsj.has(csj)),
  );
  const expectedOrderIds = new Set(
    [...orderByCsj.entries()]
      .filter(
        ([csj, order]) => order.bidDate >= today && !excludedCsjs.has(csj),
      )
      .map(([csj]) => csj),
  );
  const missingDocumentIds = new Set(
    [...expectedOrderIds].filter(
      (csj) => !planIds.has(csj) || !proposalIds.has(csj),
    ),
  );
  const validatedIds = [...expectedOrderIds]
    .filter(
      (csj) =>
        planIds.has(csj) &&
        proposalIds.has(csj) &&
        !incompleteDocumentIds.has(csj) &&
        !missingOrderIds.has(csj),
    )
    .sort();
  if (validatedIds.length === 0) {
    throw new Error(
      "TxDOT plans, proposals, and order-of-bids report have no matching current CSJs; refusing a false live-zero result",
    );
  }
  const missingDeadlineIds = new Set(
    validatedIds.filter((csj) => !deadlinesByCsj.has(csj)),
  );
  const deadlineDateMismatchIds = new Set(
    validatedIds.filter((csj) => {
      const order = orderByCsj.get(csj);
      const deadline = deadlinesByCsj.get(csj);
      return Boolean(order && deadline && order.bidDate !== deadline.localDate);
    }),
  );
  const candidates = validatedIds.flatMap((csj): CandidateProject[] => {
    const order = orderByCsj.get(csj);
    const deadline = deadlinesByCsj.get(csj);
    if (!order || (deadline && Date.parse(deadline.instant) < now.getTime())) {
      return [];
    }
    const authoritativeOrder: OrderRecord = {
      ...order,
      bidDate: deadline?.localDate ?? order.bidDate,
      bidDeadline:
        deadline?.instant ?? `${order.bidDate}T00:00:00.000Z`,
      proposalPhone: deadline?.proposalPhone,
    };
    return [
      {
        order: authoritativeOrder,
        documents: [
          ...(plansByCsj.get(csj) ?? []),
          ...(proposalsByCsj.get(csj) ?? []),
          ...(addendaByCsj.get(csj) ?? []),
        ],
        planHolders: planHoldersByCsj.get(csj) ?? [],
      },
    ];
  });
  candidates.sort(
    (left, right) =>
      (left.order.bidDeadline ?? left.order.bidDate).localeCompare(
        right.order.bidDeadline ?? right.order.bidDate,
      ) ||
      Number(left.order.sequenceNumber) - Number(right.order.sequenceNumber) ||
      left.order.csj.localeCompare(right.order.csj),
  );
  const built = candidates.map((candidate) =>
    buildProject(candidate, outputSourceId, now),
  );
  const degraded =
    planHolderCsv === undefined ||
    changesCsv === undefined ||
    incompleteDocumentIds.size > 0 ||
    missingOrderIds.size > 0 ||
    missingDocumentIds.size > 0 ||
    missingDeadlineIds.size > 0 ||
    deadlineDateMismatchIds.size > 0 ||
    built.some((entry) => entry.contactsTruncated);
  const offset = safeOffset(
    options.sourceCursors?.[outputSourceId]?.offset ??
      options.sourceCursors?.[TEXAS_DOT_SOURCE_ID]?.offset,
  );
  const limit = options.mode === "ingest" ? INGEST_LIMIT : VIEW_LIMIT;
  const projects = built
    .slice(offset, offset + limit)
    .map((entry) => entry.project);
  const page = pageRecord(offset, projects, built.length);
  const warnings = [
    planHolderCsv === undefined
      ? "The public authorized proposal-requester export could not be refreshed."
      : "",
    changesCsv === undefined
      ? "The public cancelled-or-changed-project export could not be refreshed."
      : "",
    incompleteDocumentIds.size > 0
      ? `${incompleteDocumentIds.size} archive CSJ(s) lacked either a public plan or proposal and were excluded.`
      : "",
    missingOrderIds.size > 0
      ? `${missingOrderIds.size} archive CSJ(s) lacked a matching current order-of-bids row and were excluded.`
      : "",
    missingDocumentIds.size > 0
      ? `${missingDocumentIds.size} current order-report CSJ(s) lacked either a public plan or proposal across the construction and maintenance archives and were excluded.`
      : "",
    missingDeadlineIds.size > 0
      ? `${missingDeadlineIds.size} current CSJ(s) lacked an authoritative TxDOT bid-item time and were retained with the official order-report date only; no deadline hour was invented.`
      : "",
    deadlineDateMismatchIds.size > 0
      ? `${deadlineDateMismatchIds.size} current CSJ(s) had a Tableau order date that differed from the authoritative TxDOT bid-item deadline; the authoritative deadline was used.`
      : "",
    built.some((entry) => entry.contactsTruncated)
      ? "At least one project exceeded the authorized proposal-requester contact safety limit."
      : "",
  ].filter(Boolean);
  return {
    projects,
    source: {
      ...TEXAS_DOT_SOURCE_TEMPLATE,
      id: outputSourceId,
      status: degraded ? "degraded" : "live",
      recordCount: built.length,
      recordCountUnit: "projects",
      loadedCount: projects.length,
      snapshotComplete: !page.hasMore && !degraded,
      lastChecked: now.toISOString(),
      note: [TEXAS_DOT_SOURCE_TEMPLATE.note, ...warnings].join(" "),
    },
    page,
  };
}
