import type {
  ProjectDocument,
  ProjectParticipant,
  ProjectRecord,
  SourcePageRecord,
  SourceRecord,
} from "./types";
import type {
  PublicDotConnectorResult,
  PublicDotFeedOptions,
  PublicDotSourceTemplate,
} from "./public-dot-connectors";
import { sourceLocalDateTimeToIso } from "./deadline-time.ts";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_DETAIL_CONCURRENCY = 3;
const VIEW_LIMIT = 20;
const INGEST_LIMIT = 50;
const MAX_UPSTREAM_PAGES = 20;
const MAX_CHECKLIST_LINKS = 80;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const PENNSYLVANIA_DOT_TIME_ZONE = "America/New_York" as const;

export const PENNSYLVANIA_DOT_SOURCE_ID =
  "pennsylvania-dot-ecms-bid-packages";
export const PENNSYLVANIA_DOT_ECMS_URL =
  "https://www.ecms.penndot.pa.gov/ECMS/";

const ECMS_HOST = "www.ecms.penndot.pa.gov";
const ECMS_GUEST_URL = new URL(
  "SVCOMLogin?action=login&anonymous=true",
  PENNSYLVANIA_DOT_ECMS_URL,
).toString();
const ECMS_GUEST_LANDING_URL = new URL(
  "SVCOMLogin?action=showloginbulletins",
  PENNSYLVANIA_DOT_ECMS_URL,
).toString();
const ECMS_BID_PORTAL_URL = new URL(
  "SVCOMMain?action=showMenuItem&menuId=505",
  PENNSYLVANIA_DOT_ECMS_URL,
).toString();
const ECMS_CURRENT_SEARCH_URL = new URL(
  "SVBSLSearch?action=SearchByLetDate&LET_DATE_IN_SELECTION=00&LET_DATE_WEEKS=52&LET_DATE_DURATION_TIME_FRAME=02&BID_PKG_STATUS_CD_LIST=06&BID_PKG_STATUS_CD_LIST=07",
  PENNSYLVANIA_DOT_ECMS_URL,
).toString();
const ECMS_RESULTS_PAGE_SIZE_URL = new URL(
  "PDTagServlet?action=rowsPerPage&nextPage=WEB-INF/jsp/BSLresultBidPackage.jsp&beanName=DOBSLSEARCHRESULTSLIST&rowsPerPage=100",
  PENNSYLVANIA_DOT_ECMS_URL,
).toString();
const ECMS_RESULTS_NEXT_URL = new URL(
  "PDTagServlet?action=next&nextPage=WEB-INF/jsp/BSLresultBidPackage.jsp&beanName=DOBSLSEARCHRESULTSLIST",
  PENNSYLVANIA_DOT_ECMS_URL,
).toString();

export const PENNSYLVANIA_DOT_SOURCE_TEMPLATE: PublicDotSourceTemplate = {
  id: PENNSYLVANIA_DOT_SOURCE_ID,
  name: "PennDOT ECMS Bid Packages",
  owner: "Pennsylvania Department of Transportation",
  level: "state",
  sourceClass: "procurement",
  stages: ["bidding"],
  access: "open",
  cadence: "Daily",
  url: PENNSYLVANIA_DOT_ECMS_URL,
  jurisdiction: "Pennsylvania",
  note: "Official published PennDOT bid packages with exact deadlines, scope, plans, proposal reports, addenda, attachments, and public planholder contacts. ECMS uses a free anonymous session; withdrawn and expired packages are excluded.",
};

interface EcmsSession {
  cookie: string;
  dependencies: PennsylvaniaDotDependencies;
  requestTail: Promise<void>;
}

interface PennsylvaniaDotDependencies {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** Testable lower ceiling; callers cannot raise the production safety limit. */
  maxDocumentBytes?: number;
  now?: () => Date;
}

interface EcmsAnchor {
  url: string;
  text: string;
  title?: string;
}

interface EcmsListRow {
  recordId: string;
  bidDate: string;
  detailUrl: string;
  projectType: string;
  district: string;
  county: string;
  stateRoute: string;
  section: string;
  groupId: string;
  costRangeThousands: string;
  workType: string;
  submissionMethod: string;
  structuralWork: string;
}

interface HydratedRow {
  project?: ProjectRecord;
  failed: boolean;
}

export interface PennsylvaniaDotPlanholder {
  contractor: string;
  address?: string;
  contractorType?: string;
  contact?: string;
  phone?: string;
  fax?: string;
  email?: string;
}

export interface PennsylvaniaDotProjectEnrichment {
  projectNumber: string;
  sourceUrl: string;
  observedAt: string;
  documents: ProjectDocument[];
  participants: ProjectParticipant[];
  planholders: PennsylvaniaDotPlanholder[];
  warnings: string[];
}

export interface PennsylvaniaDotFetchedDocument {
  sourceUrl: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
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

function officialEcmsUrl(rawUrl: string, baseUrl = PENNSYLVANIA_DOT_ECMS_URL): string {
  let url: URL;
  try {
    url = new URL(decodeHtml(rawUrl.trim()), baseUrl);
  } catch {
    throw new Error(`Invalid PennDOT ECMS URL: ${rawUrl}`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== ECMS_HOST ||
    !url.pathname.toLowerCase().startsWith("/ecms/")
  ) {
    throw new Error(`Blocked non-production PennDOT ECMS URL: ${url.toString()}`);
  }
  url.hash = "";
  return url.toString();
}

function ecmsAnchors(html: string, baseUrl: string): EcmsAnchor[] {
  const result: EcmsAnchor[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = htmlAttribute(match[1], "href");
    if (!href || /^javascript:/i.test(href)) continue;
    try {
      result.push({
        url: officialEcmsUrl(href, baseUrl),
        text: plainText(match[2]),
        title: htmlAttribute(match[1], "title"),
      });
    } catch {
      // Ignore off-site navigation and malformed links from the ECMS chrome.
    }
  }
  return result;
}

async function mapBounded<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency = MAX_DETAIL_CONCURRENCY,
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
        output[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

interface EcmsConsumedResponse<T> {
  body: T;
  headers: Headers;
}

async function ecmsRequest<T>(
  urlValue: string,
  dependencies: PennsylvaniaDotDependencies,
  consume: (response: Response) => Promise<T>,
  cookie?: string,
  accept = "text/html,application/xhtml+xml",
): Promise<EcmsConsumedResponse<T>> {
  let url = officialEcmsUrl(urlValue);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    dependencies.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    for (let redirect = 0; redirect <= 4; redirect += 1) {
      const response = await (dependencies.fetchImpl ?? fetch)(url, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          Accept: accept,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirect === 4) {
          throw new Error("PennDOT ECMS returned an invalid redirect chain");
        }
        url = officialEcmsUrl(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`PennDOT ECMS returned HTTP ${response.status}: ${url}`);
      }
      if (response.url) officialEcmsUrl(response.url);
      return {
        body: await consume(response),
        headers: response.headers,
      };
    }
    throw new Error("PennDOT ECMS exceeded its redirect safety limit");
  } finally {
    clearTimeout(timer);
  }
}

async function withEcmsSession<T>(
  session: EcmsSession,
  work: () => Promise<T>,
): Promise<T> {
  const previous = session.requestTail;
  let release = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  session.requestTail = next;
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function loginPage(html: string): boolean {
  return (
    /enter ECMS as a guest/i.test(html) &&
    !/currently logged in as\s*<b>\s*Anonymous\s*<\/b>/i.test(html)
  );
}

async function ecmsText(session: EcmsSession, url: string): Promise<string> {
  return withEcmsSession(session, async () => {
    const response = await ecmsRequest(
      url,
      session.dependencies,
      (value) => value.text(),
      session.cookie,
    );
    if (loginPage(response.body)) {
      throw new Error(`PennDOT ECMS anonymous session expired while reading ${url}`);
    }
    return response.body;
  });
}

async function openEcmsSession(
  dependencies: PennsylvaniaDotDependencies,
): Promise<EcmsSession> {
  const root = await ecmsRequest(
    PENNSYLVANIA_DOT_ECMS_URL,
    dependencies,
    (response) => response.text(),
  );
  const setCookie = root.headers.get("set-cookie") ?? "";
  const sessionId = setCookie.match(/(?:^|[,;]\s*)JSESSIONID=([^;,\s]+)/i)?.[1];
  if (!sessionId) {
    throw new Error("PennDOT ECMS did not issue an anonymous JSESSIONID");
  }
  const cookie = `JSESSIONID=${sessionId}`;
  const guestResponse = await ecmsRequest(
    ECMS_GUEST_URL,
    dependencies,
    (response) => response.text(),
    cookie,
  );
  const guestHtml = guestResponse.body;
  if (!/SVCOMLogin\?action=showloginbulletins/i.test(guestHtml)) {
    throw new Error("PennDOT ECMS guest login did not return its expected landing page");
  }
  const session: EcmsSession = {
    cookie,
    dependencies,
    requestTail: Promise.resolve(),
  };
  const landingHtml = await ecmsText(session, ECMS_GUEST_LANDING_URL);
  if (!/currently logged in as\s*<b>\s*Anonymous\s*<\/b>/i.test(landingHtml)) {
    throw new Error("PennDOT ECMS did not confirm an Anonymous guest session");
  }
  return session;
}

function ecmsDateTime(value: string): string | undefined {
  const match = plainText(value).match(
    /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\b/i,
  );
  if (!match) return undefined;
  let hour = Number(match[4]);
  if (match[7].toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (match[7].toUpperCase() === "AM" && hour === 12) hour = 0;
  const local = `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}T${String(hour).padStart(2, "0")}:${match[5]}:${match[6] ?? "00"}`;
  return sourceLocalDateTimeToIso(local, PENNSYLVANIA_DOT_TIME_ZONE);
}

function recordCount(html: string): number | undefined {
  const count = plainText(html).match(
    /Records\s+\d+\s+to\s+\d+\s+of\s+([\d,]+)/i,
  )?.[1];
  if (count) return Number(count.replace(/,/g, ""));
  if (/No records found\.?/i.test(plainText(html)) && /Bid Packages?/i.test(html)) {
    return 0;
  }
  return undefined;
}

function resultRows(html: string): EcmsListRow[] {
  const rows: EcmsListRow[] = [];
  for (const match of html.matchAll(
    /<tr\b[^>]*class\s*=\s*["'][^"']*PD(?:Even|Odd)Row[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi,
  )) {
    const rowHtml = match[1];
    if (!/SVBSLBidPackage\?action=Show/i.test(rowHtml)) continue;
    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (cell) => plainText(cell[1]),
    );
    if (cells.length < 12) continue;
    const detailAnchor = ecmsAnchors(rowHtml, ECMS_CURRENT_SEARCH_URL).find(
      (anchor) =>
        /\/ECMS\/SVBSLBidPackage$/i.test(new URL(anchor.url).pathname) &&
        /^Show$/i.test(new URL(anchor.url).searchParams.get("action") ?? ""),
    );
    const detailUrl = detailAnchor?.url;
    const detailProjectNumber = detailUrl
      ? new URL(detailUrl).searchParams.get("ECMS_PROJECT_NUM")
      : undefined;
    const hiddenProjectNumber = rowHtml.match(
      /<input\b[^>]*name\s*=\s*["']?ECMS_PROJECT_NUM["']?[^>]*value\s*=\s*["']?([\d,]+)/i,
    )?.[1];
    const recordId = (hiddenProjectNumber ?? detailProjectNumber ?? cells[1] ?? "")
      .replace(/\D/g, "");
    const bidDate = ecmsDateTime(cells[0]);
    if (!recordId || !bidDate || !detailUrl) continue;
    rows.push({
      recordId,
      bidDate,
      detailUrl: detailUrlForRecord(recordId),
      projectType: cells[2] ?? "",
      district: cells[3] ?? "",
      county: cells[4] ?? "",
      stateRoute: cells[5] ?? "",
      section: cells[6] ?? "",
      groupId: cells[7] ?? "",
      costRangeThousands: cells[8] ?? "",
      workType: cells[9] ?? "",
      submissionMethod: cells[10] ?? "",
      structuralWork: cells[11] ?? "",
    });
  }
  return rows;
}

function hasNextResultsPage(html: string): boolean {
  return ecmsAnchors(html, ECMS_CURRENT_SEARCH_URL).some((anchor) => {
    const url = new URL(anchor.url);
    return (
      /\/ECMS\/PDTagServlet$/i.test(url.pathname) &&
      /^next$/i.test(url.searchParams.get("action") ?? "") &&
      url.searchParams.get("beanName") === "DOBSLSEARCHRESULTSLIST"
    );
  });
}

async function currentList(
  session: EcmsSession,
): Promise<{ rows: EcmsListRow[]; total: number; incomplete: boolean }> {
  await ecmsText(session, ECMS_BID_PORTAL_URL);
  let html = await ecmsText(session, ECMS_CURRENT_SEARCH_URL);
  const total = recordCount(html);
  if (total === undefined) {
    throw new Error("PennDOT ECMS result count or empty-result marker was missing");
  }
  if (!/<option\b[^>]*value\s*=\s*["']?100["']?[^>]*selected/i.test(html)) {
    html = await ecmsText(session, ECMS_RESULTS_PAGE_SIZE_URL);
  }
  const byId = new Map<string, EcmsListRow>();
  let pageNumber = 0;
  let previousFingerprint = "";
  while (true) {
    pageNumber += 1;
    if (pageNumber > MAX_UPSTREAM_PAGES) {
      throw new Error("PennDOT ECMS result pagination exceeded its safety limit");
    }
    const pageRows = resultRows(html);
    const fingerprint = pageRows.map((row) => row.recordId).join("|");
    if (pageNumber > 1 && fingerprint && fingerprint === previousFingerprint) {
      throw new Error("PennDOT ECMS repeated a result page while paginating");
    }
    previousFingerprint = fingerprint;
    for (const row of pageRows) byId.set(row.recordId, row);
    if (!hasNextResultsPage(html)) break;
    html = await ecmsText(session, ECMS_RESULTS_NEXT_URL);
  }
  return {
    rows: [...byId.values()],
    total,
    incomplete: byId.size < total,
  };
}

function detailUrlForRecord(projectNumber: string): string {
  const url = new URL("SVBSLBidPackage", PENNSYLVANIA_DOT_ECMS_URL);
  url.searchParams.set("action", "Show");
  url.searchParams.set("ECMS_PROJECT_NUM", projectNumber);
  url.searchParams.set("BID_PACKAGE_NUM", "1");
  return url.toString();
}

function planholderUrl(projectNumber: string): string {
  const url = new URL("SVBSLSearch", PENNSYLVANIA_DOT_ECMS_URL);
  url.searchParams.set("action", "ShowPlanholdersList");
  url.searchParams.set("ECMS_PROJECT_NUM", projectNumber);
  return url.toString();
}

function projectNumberFromUrl(url: URL): string | undefined {
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() !== "ecms_project_num") continue;
    const normalized = value.replace(/\D/g, "");
    return /^\d{1,9}$/.test(normalized) ? normalized : undefined;
  }
  return undefined;
}

function projectIdentities(html: string, baseUrl: string): Set<string> {
  const identities = new Set<string>();
  for (const anchor of ecmsAnchors(html, baseUrl)) {
    const identity = projectNumberFromUrl(new URL(anchor.url));
    if (identity) identities.add(identity);
  }
  for (const match of html.matchAll(/<input\b([^>]*)>/gi)) {
    if (htmlAttribute(match[1], "name")?.toLowerCase() !== "ecms_project_num") {
      continue;
    }
    const identity = (htmlAttribute(match[1], "value") ?? "").replace(/\D/g, "");
    if (/^\d{1,9}$/.test(identity)) identities.add(identity);
  }
  return identities;
}

function assertProjectHtmlScope(
  html: string,
  projectNumber: string,
  baseUrl: string,
  requireIdentity: boolean,
): void {
  const identities = projectIdentities(html, baseUrl);
  if (requireIdentity && identities.size === 0) {
    throw new Error(`PennDOT ECMS did not identify project ${projectNumber}`);
  }
  if ([...identities].some((identity) => identity !== projectNumber)) {
    throw new Error(`PennDOT ECMS mixed another project into ${projectNumber}`);
  }
}

function assertDocumentScope(
  documents: readonly ProjectDocument[],
  projectNumber: string,
): void {
  for (const document of documents) {
    const identity = projectNumberFromUrl(new URL(document.url));
    if (identity && identity !== projectNumber) {
      throw new Error(`PennDOT ECMS document did not belong to ${projectNumber}`);
    }
  }
}

function labelledCell(html: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(
      `${escaped}\\s*:\\s*<\\/td>\\s*<td\\b[^>]*>([\\s\\S]*?)<\\/td>`,
      "i",
    ),
  );
  const value = plainText(match?.[1] ?? "");
  return value || undefined;
}

function detailLifecycle(html: string): string | undefined {
  const match = html.match(
    /<td\b[^>]*class\s*=\s*["'][^"']*header1title\s+right\s+middle[^"']*["'][^>]*>([\s\S]*?)<\/td>/i,
  );
  const value = plainText(match?.[1] ?? "");
  return value || undefined;
}

function descriptionSection(html: string): string | undefined {
  const heading = html.search(
    /<td\b[^>]*class\s*=\s*["'][^"']*Section1Title[^"']*["'][^>]*>\s*Description\s*(?:<|$)/i,
  );
  if (heading < 0) return undefined;
  const body = html.slice(heading, heading + 12_000);
  const match = body.match(/<td\b[^>]*class\s*=\s*["'][^"']*data[^"']*["'][^>]*>([\s\S]*?)<\/td>/i);
  const value = plainText(match?.[1] ?? "");
  return value || undefined;
}

function workflowPublishDate(html: string): string | undefined {
  for (const row of html.matchAll(
    /<tr\b[^>]*class\s*=\s*["'][^"']*PD(?:Even|Odd)Row[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi,
  )) {
    const text = plainText(row[1]);
    if (!/\bPublish\b/i.test(text)) continue;
    return ecmsDateTime(text);
  }
  return undefined;
}

function documentName(anchor: EcmsAnchor, fallback: string): string {
  return anchor.text || anchor.title || fallback;
}

function metadataDocuments(
  html: string,
  projectNumber: string,
  projectDetailUrl: string,
): ProjectDocument[] {
  const documents: ProjectDocument[] = [
    {
      name: "Official PennDOT ECMS bid package",
      kind: "source-record",
      url: projectDetailUrl,
      access: "public",
      indexStatus: "metadata-only",
    },
    {
      name: "PennDOT ECMS public planholders",
      kind: "source-record",
      url: planholderUrl(projectNumber),
      access: "public",
      indexStatus: "metadata-only",
    },
  ];
  for (const anchor of ecmsAnchors(html, projectDetailUrl)) {
    const url = new URL(anchor.url);
    const action = url.searchParams.get("action")?.toLowerCase() ?? "";
    const source = url.searchParams.get("SOURCE")?.toUpperCase();
    const version = url.searchParams.get("VERSION_ID")?.toUpperCase();
    const addendum = url.searchParams.get("ADDENDUM_NUM");
    let kind: ProjectDocument["kind"] | undefined;
    let name: string | undefined;
    let indexStatus: ProjectDocument["indexStatus"] = "metadata-only";
    if (/\/ECMS\/SVPDC$/i.test(url.pathname) && source === "PLANS") {
      kind = addendum ? "addendum" : "plans";
      name = addendum
        ? `Addendum ${addendum} plan checklist`
        : version === "C"
          ? "Current PennDOT plans"
          : "Original PennDOT plans";
    } else if (/\/ECMS\/SVPDCSP$/i.test(url.pathname)) {
      kind = addendum ? "addendum" : "specifications";
      name = addendum
        ? `Addendum ${addendum} special provisions`
        : "Current PennDOT special provisions";
    } else if (/\/ECMS\/SVPIQ$/i.test(url.pathname)) {
      kind = "specifications";
      name = addendum
        ? `Addendum ${addendum} project items and quantities`
        : "PennDOT project items and quantities";
    } else if (/\/ECMS\/SVBSLBidPackage$/i.test(url.pathname)) {
      if (action === "showcurrentproposalreport") {
        kind = "specifications";
        name = "Current PennDOT proposal report";
        indexStatus = "queued";
      } else if (action === "showproposalplansets") {
        kind = "plans";
        name = "Original PennDOT plan sets";
      } else if (action === "showproposalattachments") {
        kind = "source-record";
        name = "Original PennDOT proposal attachments";
      }
    } else if (/\/ECMS\/SVBSLAddendum$/i.test(url.pathname)) {
      if (action === "showaddendumproposalreport") {
        kind = "addendum";
        name = `PennDOT addendum ${addendum ?? ""} report`.trim();
        indexStatus = "queued";
      } else if (action === "showproposalplansets") {
        kind = "addendum";
        name = `PennDOT addendum ${addendum ?? ""} plan sets`.trim();
      } else if (action === "showproposalattachments") {
        kind = "addendum";
        name = `PennDOT addendum ${addendum ?? ""} attachments`.trim();
        indexStatus = "queued";
      }
    }
    if (!kind || !name) continue;
    documents.push({
      name: documentName(anchor, name) || name,
      kind,
      url: anchor.url,
      access: "public",
      indexStatus,
    });
  }
  const unique = uniqueDocuments(documents);
  assertDocumentScope(unique, projectNumber);
  return unique;
}

function uniqueDocuments(documents: ProjectDocument[]): ProjectDocument[] {
  const seen = new Set<string>();
  return documents.filter((document) => {
    if (seen.has(document.url)) return false;
    seen.add(document.url);
    return true;
  });
}

function fallbackSummary(row: EcmsListRow): string {
  const facts = [
    row.workType,
    row.stateRoute && row.stateRoute !== "---" ? `SR ${row.stateRoute}` : "",
    row.section && row.section !== "---" ? `section ${row.section}` : "",
    row.county ? `${row.county} County` : "",
    row.district ? `District ${row.district}` : "",
    row.costRangeThousands && row.costRangeThousands !== "---"
      ? `published cost range $${row.costRangeThousands} thousand`
      : "",
  ].filter(Boolean);
  return `${facts.join("; ")}.`;
}

function projectFromDetail(
  row: EcmsListRow,
  detailHtml: string,
  outputSourceId: string,
  now: Date,
): ProjectRecord | undefined {
  assertProjectHtmlScope(detailHtml, row.recordId, row.detailUrl, true);
  const lifecycle = detailLifecycle(detailHtml);
  if (!lifecycle) return undefined;
  if (/withdrawn|rejected|cancelled|awarded|bid\s*opened/i.test(lifecycle)) {
    return undefined;
  }
  if (!/Advertised/i.test(lifecycle)) return undefined;
  const title =
    labelledCell(detailHtml, "Short Description") ??
    `${row.recordId} — ${row.county || "Pennsylvania"} — ${row.workType || "Construction"}`;
  const summary = descriptionSection(detailHtml) ?? fallbackSummary(row);
  const detailFields = [
    row.recordId,
    title,
    summary,
    row.projectType,
    row.district,
    row.county,
    row.stateRoute,
    row.section,
    row.groupId,
    row.costRangeThousands,
    row.workType,
    row.submissionMethod,
    row.structuralWork,
    labelledCell(detailHtml, "Municipality") ?? "",
    labelledCell(detailHtml, "Anticipated NTP") ?? "",
    labelledCell(detailHtml, "Required Completion") ?? "",
  ].filter(Boolean);
  return {
    id: `${outputSourceId}:${row.recordId}`,
    sourceId: outputSourceId,
    sourceRecordId: row.recordId,
    title,
    summary,
    stage: "bidding",
    status: lifecycle,
    agency: PENNSYLVANIA_DOT_SOURCE_TEMPLATE.owner,
    county: row.county || undefined,
    state: "Pennsylvania",
    postedAt: workflowPublishDate(detailHtml),
    bidDate: row.bidDate,
    bidDateTimeZone: PENNSYLVANIA_DOT_TIME_ZONE,
    updatedAt: now.toISOString(),
    sourceName: PENNSYLVANIA_DOT_SOURCE_TEMPLATE.name,
    sourceUrl: row.detailUrl,
    provenance: "live-public-page",
    confidence: "official",
    documents: metadataDocuments(
      detailHtml,
      row.recordId,
      row.detailUrl,
    ),
    participants: [
      {
        name: PENNSYLVANIA_DOT_SOURCE_TEMPLATE.owner,
        role: "agency",
        participantType: "organization",
        sourceUrl: row.detailUrl,
      },
    ],
    searchableFields: detailFields,
    documentTextIndexed: false,
  };
}

function pageRecord(
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

function sourceRecord(
  outputSourceId: string,
  now: Date,
  total: number,
  loadedCount: number,
  page: SourcePageRecord,
  degraded: boolean,
): SourceRecord {
  return {
    ...PENNSYLVANIA_DOT_SOURCE_TEMPLATE,
    id: outputSourceId,
    status: degraded ? "degraded" : "live",
    recordCount: total,
    recordCountUnit: "rows",
    loadedCount,
    snapshotComplete: !page.hasMore && !degraded,
    lastChecked: now.toISOString(),
    note: degraded
      ? `${PENNSYLVANIA_DOT_SOURCE_TEMPLATE.note} This check was incomplete because at least one ECMS result or detail page could not be reconciled.`
      : PENNSYLVANIA_DOT_SOURCE_TEMPLATE.note,
  };
}

async function hydrateRowsWithIsolatedSessions(
  rows: readonly EcmsListRow[],
  initialSession: EcmsSession,
  outputSourceId: string,
  now: Date,
  options: PublicDotFeedOptions,
): Promise<HydratedRow[]> {
  if (rows.length === 0) return [];
  const workerCount = Math.min(MAX_DETAIL_CONCURRENCY, rows.length);
  const sessions = [initialSession];
  if (workerCount > 1) {
    sessions.push(
      ...(await Promise.all(
        Array.from({ length: workerCount - 1 }, () => openEcmsSession(options)),
      )),
    );
  }
  const output = new Array<HydratedRow>(rows.length);
  let nextIndex = 0;
  await Promise.all(
    sessions.map(async (session) => {
      while (nextIndex < rows.length) {
        const index = nextIndex;
        nextIndex += 1;
        const row = rows[index];
        if (Date.parse(row.bidDate) < now.getTime()) {
          output[index] = { failed: false };
          continue;
        }
        try {
          const html = await ecmsText(session, row.detailUrl);
          output[index] = {
            project: projectFromDetail(row, html, outputSourceId, now),
            failed: false,
          };
        } catch {
          output[index] = { failed: true };
        }
      }
    }),
  );
  return output;
}

export async function fetchPennsylvaniaDotSource(
  outputSourceId = PENNSYLVANIA_DOT_SOURCE_ID,
  options: PublicDotFeedOptions = {},
): Promise<PublicDotConnectorResult> {
  const now = (options.now ?? (() => new Date()))();
  const session = await openEcmsSession(options);
  const list = await currentList(session);
  const offset =
    options.sourceCursors?.[outputSourceId]?.offset ??
    options.sourceCursors?.[PENNSYLVANIA_DOT_SOURCE_ID]?.offset ??
    0;
  const limit = options.mode === "ingest" ? INGEST_LIMIT : VIEW_LIMIT;
  const selected = list.rows.slice(offset, offset + limit);
  const hydrated = await hydrateRowsWithIsolatedSessions(
    selected,
    session,
    outputSourceId,
    now,
    options,
  );
  const projects = hydrated
    .map((entry) => entry.project)
    .filter((project): project is ProjectRecord => Boolean(project));
  const page = pageRecord(
    offset,
    selected.length,
    offset + selected.length < list.rows.length,
  );
  const degraded = list.incomplete || hydrated.some((entry) => entry.failed);
  return {
    projects,
    source: sourceRecord(
      outputSourceId,
      now,
      list.total,
      projects.length,
      page,
      degraded,
    ),
    page,
  };
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
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows;
}

function planholdersFromCsv(csv: string): PennsylvaniaDotPlanholder[] {
  const rows = parseCsv(csv);
  const expected = [
    "Contractor",
    "Address",
    "Contractor Type",
    "Contact",
    "Phone",
    "Fax",
    "Email",
  ];
  if (
    rows.length === 0 ||
    expected.some((header, index) => rows[0]?.[index] !== header)
  ) {
    throw new Error("PennDOT ECMS planholder CSV headers changed");
  }
  return rows.slice(1).flatMap((values) => {
    const contractor = values[0]?.trim();
    if (!contractor) return [];
    return [
      {
        contractor,
        address: values[1]?.trim() || undefined,
        contractorType: values[2]?.trim() || undefined,
        contact: values[3]?.trim() || undefined,
        phone: values[4]?.trim() || undefined,
        fax: values[5]?.trim() || undefined,
        email: values[6]?.trim().toLowerCase() || undefined,
      },
    ];
  });
}

function participantsFromPlanholders(
  projectNumber: string,
  planholders: PennsylvaniaDotPlanholder[],
): ProjectParticipant[] {
  const sourceUrl = planholderUrl(projectNumber);
  return [
    {
      name: PENNSYLVANIA_DOT_SOURCE_TEMPLATE.owner,
      role: "agency",
      participantType: "organization",
      sourceUrl: detailUrlForRecord(projectNumber),
    },
    ...planholders.map((planholder): ProjectParticipant => ({
      name: planholder.contact ?? planholder.contractor,
      role: "contractor",
      participantType: planholder.contact ? "person" : "organization",
      organization: planholder.contact ? planholder.contractor : undefined,
      email: planholder.email,
      phone: planholder.phone,
      sourceUrl,
    })),
  ];
}

function edmsDocuments(
  html: string,
  baseUrl: string,
  kind: ProjectDocument["kind"],
  prefix = "",
): ProjectDocument[] {
  return ecmsAnchors(html, baseUrl).flatMap((anchor) => {
    const url = new URL(anchor.url);
    if (
      !/\/ECMS\/SVCOMDownloadDocument$/i.test(url.pathname) ||
      !/^EDMS$/i.test(url.searchParams.get("action") ?? "") ||
      !url.searchParams.has("docId")
    ) {
      return [];
    }
    const name = plainText(`${prefix} ${anchor.text || anchor.title || "PennDOT ECMS document"}`);
    return [
      {
        name,
        kind,
        url: anchor.url,
        access: "public" as const,
        indexStatus: "queued" as const,
      },
    ];
  });
}

async function expandedPlanDocuments(
  session: EcmsSession,
  detailHtml: string,
  projectNumber: string,
): Promise<{ documents: ProjectDocument[]; warnings: string[] }> {
  const projectDetailUrl = detailUrlForRecord(projectNumber);
  assertProjectHtmlScope(detailHtml, projectNumber, projectDetailUrl, true);
  const anchors = ecmsAnchors(detailHtml, projectDetailUrl);
  const documents = metadataDocuments(
    detailHtml,
    projectNumber,
    projectDetailUrl,
  );
  const warnings: string[] = [];
  const planSetLinks = anchors.filter((anchor) => {
    const url = new URL(anchor.url);
    return (
      /^showProposalPlanSets$/i.test(url.searchParams.get("action") ?? "") &&
      /\/ECMS\/(?:SVBSLBidPackage|SVBSLAddendum)$/i.test(url.pathname)
    );
  });
  const planSetResults = await mapBounded(planSetLinks, async (anchor) => {
    try {
      const url = new URL(anchor.url);
      const addendum = url.searchParams.get("ADDENDUM_NUM");
      const html = await ecmsText(session, anchor.url);
      assertProjectHtmlScope(html, projectNumber, anchor.url, false);
      return {
        documents: edmsDocuments(
          html,
          anchor.url,
          "plans",
          addendum ? `Addendum ${addendum}` : "Original plan",
        ),
      };
    } catch (error) {
      return { warning: error instanceof Error ? error.message : String(error) };
    }
  }, 1);
  for (const result of planSetResults) {
    if (result.documents) documents.push(...result.documents);
    if (result.warning) warnings.push(result.warning);
  }

  const hasExpandedPlanFiles = documents.some(
    (document) =>
      document.kind === "plans" &&
      /\/ECMS\/SVCOMDownloadDocument$/i.test(new URL(document.url).pathname),
  );
  const currentPlanLink = hasExpandedPlanFiles
    ? undefined
    : anchors.find((anchor) => {
    const url = new URL(anchor.url);
    return (
      /\/ECMS\/SVPDC$/i.test(url.pathname) &&
      /^SHOW$/i.test(url.searchParams.get("action") ?? "") &&
      url.searchParams.get("SOURCE")?.toUpperCase() === "PLANS" &&
      url.searchParams.get("VERSION_ID")?.toUpperCase() === "C"
    );
      });
  if (currentPlanLink) {
    try {
      const checklistHtml = await ecmsText(session, currentPlanLink.url);
      assertProjectHtmlScope(
        checklistHtml,
        projectNumber,
        currentPlanLink.url,
        false,
      );
      const attachmentLinks = ecmsAnchors(checklistHtml, currentPlanLink.url)
        .filter((anchor) => {
          const url = new URL(anchor.url);
          return (
            /\/ECMS\/SVPDCDetail$/i.test(url.pathname) &&
            /^ShowAttachments$/i.test(url.searchParams.get("action") ?? "") &&
            url.searchParams.get("SOURCE")?.toUpperCase() === "PLANS"
          );
        })
        .slice(0, MAX_CHECKLIST_LINKS);
      const attachmentResults = await mapBounded(attachmentLinks, async (anchor) => {
        try {
          const attachmentHtml = await ecmsText(session, anchor.url);
          assertProjectHtmlScope(
            attachmentHtml,
            projectNumber,
            anchor.url,
            false,
          );
          return {
            documents: edmsDocuments(
              attachmentHtml,
              anchor.url,
              "plans",
              "Current plan",
            ),
          };
        } catch (error) {
          return { warning: error instanceof Error ? error.message : String(error) };
        }
      }, 1);
      for (const result of attachmentResults) {
        if (result.documents) documents.push(...result.documents);
        if (result.warning) warnings.push(result.warning);
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  const unique = uniqueDocuments(documents);
  assertDocumentScope(unique, projectNumber);
  return { documents: unique, warnings };
}

async function fetchPlanholders(
  session: EcmsSession,
  projectNumber: string,
): Promise<PennsylvaniaDotPlanholder[]> {
  await ecmsText(session, planholderUrl(projectNumber));
  const exportUrl = new URL("SVBSLSearch", PENNSYLVANIA_DOT_ECMS_URL);
  exportUrl.searchParams.set("action", "ExportPlanHolders");
  exportUrl.searchParams.set("ecmsProjectNum", projectNumber);
  const response = await withEcmsSession(session, () =>
    ecmsRequest(
      exportUrl.toString(),
      session.dependencies,
      (value) => value.text(),
      session.cookie,
      "text/csv,text/plain;q=0.9,*/*;q=0.1",
    ),
  );
  const csv = response.body;
  if (loginPage(csv) || !csv.trim()) {
    throw new Error("PennDOT ECMS returned an empty or unauthenticated planholder export");
  }
  return planholdersFromCsv(csv);
}

function normalizeProjectNumber(value: string): string {
  const normalized = value.replace(/\D/g, "");
  if (!/^\d{1,9}$/.test(normalized)) {
    throw new Error("A valid numeric PennDOT ECMS project number is required");
  }
  return normalized;
}

export async function fetchPennsylvaniaDotProjectEnrichment(
  projectNumberValue: string,
  dependencies: PennsylvaniaDotDependencies = {},
): Promise<PennsylvaniaDotProjectEnrichment> {
  const projectNumber = normalizeProjectNumber(projectNumberValue);
  const now = (dependencies.now ?? (() => new Date()))();
  const session = await openEcmsSession(dependencies);
  const sourceUrl = detailUrlForRecord(projectNumber);
  const detailHtml = await ecmsText(session, sourceUrl);
  assertProjectHtmlScope(detailHtml, projectNumber, sourceUrl, true);
  const lifecycle = detailLifecycle(detailHtml);
  if (!lifecycle || !/^Advertised$/i.test(lifecycle.trim())) {
    throw new Error(`PennDOT ECMS project ${projectNumber} is not an active advertised package`);
  }
  const expanded = await expandedPlanDocuments(
    session,
    detailHtml,
    projectNumber,
  );
  let planholders: PennsylvaniaDotPlanholder[] = [];
  try {
    planholders = await fetchPlanholders(session, projectNumber);
  } catch (error) {
    expanded.warnings.push(error instanceof Error ? error.message : String(error));
  }
  return {
    projectNumber,
    sourceUrl,
    observedAt: now.toISOString(),
    documents: expanded.documents,
    participants: participantsFromPlanholders(projectNumber, planholders),
    planholders,
    warnings: expanded.warnings,
  };
}

function allowedDocumentAction(url: URL): boolean {
  const action = url.searchParams.get("action")?.toLowerCase() ?? "";
  if (/\/ECMS\/SVCOMDownloadDocument$/i.test(url.pathname)) {
    return action === "edms" && url.searchParams.has("docId");
  }
  if (/\/ECMS\/SVBSLBidPackage$/i.test(url.pathname)) {
    return [
      "showcurrentproposalreport",
      "showoriginalproposalreport",
      "showproposalattachments",
    ].includes(action);
  }
  if (/\/ECMS\/SVBSLAddendum$/i.test(url.pathname)) {
    return ["showaddendumproposalreport", "showproposalattachments"].includes(
      action,
    );
  }
  return false;
}

function dispositionFileName(value: string | null): string | undefined {
  return value?.match(/filename\*?=(?:UTF-8''|["']?)([^"';]+)["']?/i)?.[1]
    ? decodeURIComponent(
        value.match(/filename\*?=(?:UTF-8''|["']?)([^"';]+)["']?/i)?.[1] ?? "",
      )
    : undefined;
}

async function readBoundedDocumentBytes(
  response: Response,
  byteLimit: number,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > byteLimit) {
    await response.body?.cancel();
    throw new Error("PennDOT ECMS document exceeds the download safety limit");
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
        await reader.cancel("PennDOT ECMS document safety limit exceeded");
        throw new Error("PennDOT ECMS document exceeds the download safety limit");
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
}

export async function fetchPennsylvaniaDotDocument(
  stableActionUrl: string,
  dependencies: PennsylvaniaDotDependencies = {},
): Promise<PennsylvaniaDotFetchedDocument> {
  const sourceUrl = officialEcmsUrl(stableActionUrl);
  if (!allowedDocumentAction(new URL(sourceUrl))) {
    throw new Error("Unsupported PennDOT ECMS document action URL");
  }
  const session = await openEcmsSession(dependencies);
  const requestedLimit = dependencies.maxDocumentBytes;
  const byteLimit =
    Number.isInteger(requestedLimit) && (requestedLimit ?? 0) > 0
      ? Math.min(requestedLimit as number, MAX_DOCUMENT_BYTES)
      : MAX_DOCUMENT_BYTES;
  const response = await withEcmsSession(session, () =>
    ecmsRequest(
      sourceUrl,
      dependencies,
      (value) => readBoundedDocumentBytes(value, byteLimit),
      session.cookie,
      "application/pdf,application/octet-stream,*/*;q=0.1",
    ),
  );
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const bytes = response.body;
  if (bytes.byteLength === 0) {
    throw new Error("PennDOT ECMS document was empty or exceeded the download safety limit");
  }
  const prefix = new TextDecoder().decode(bytes.slice(0, 256));
  if (/text\/html/i.test(contentType) || loginPage(prefix) || /^\s*</.test(prefix)) {
    throw new Error("PennDOT ECMS returned HTML instead of the requested document");
  }
  const fileName =
    dispositionFileName(response.headers.get("content-disposition")) ??
    "PennDOT-ECMS-document.pdf";
  return { sourceUrl, fileName, contentType, bytes };
}
