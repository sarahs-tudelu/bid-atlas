import {
  PORTAL_CLASSIFIER_VERSION,
  classifyPortal,
  createSafePortalAdapterCandidate,
} from "../app/lib/portal-classification";

export interface JurisdictionDiscoveryEnv {
  DB: D1Database;
  DATA_GOV_API_KEY?: string;
}

export interface JurisdictionDiscoveryOptions {
  trigger?: "scheduled" | "manual";
  batchSize?: number;
}

export interface JurisdictionDiscoveryResult {
  trigger: "scheduled" | "manual";
  status: "complete" | "partial" | "skipped";
  leasedJobs: number;
  completedJobs: number;
  requeuedJobs: number;
  failedJobs: number;
  candidates: number;
  startedAt: string;
  finishedAt: string;
  warnings: string[];
}

interface LeasedJob {
  id: string;
  jurisdictionId: string;
  jurisdictionName: string;
  governmentType: string;
  state: string | null;
  requiredSourceClasses: string;
  completedSourceClasses: string;
  cursor: string | null;
  attemptCount: number | string;
  sourceCandidatesFound: number | string;
}

interface DiscoveryCursor extends Record<string, unknown> {
  after?: string;
  query?: string;
  sourceClass?: string;
  resultsSeen?: number;
  scanCandidateCount?: number;
  lastScanCandidateCount?: number;
  failureCount?: number;
  lastCatalogUrl?: string;
  lastCompletedAt?: string;
  lastErrorAt?: string;
  truncatedSourceClasses?: string[];
  catalogProvider?: CatalogProvider;
}

type CatalogProvider = "gsa-v4" | "catalog-public";

interface CatalogOrganization {
  name?: unknown;
  slug?: unknown;
  organization_type?: unknown;
}

interface CatalogPublisher {
  name?: unknown;
}

interface CatalogDistribution {
  title?: unknown;
  description?: unknown;
  format?: unknown;
  mediaType?: unknown;
  accessURL?: unknown;
  downloadURL?: unknown;
}

interface CatalogDcat {
  title?: unknown;
  description?: unknown;
  identifier?: unknown;
  modified?: unknown;
  landingPage?: unknown;
  publisher?: CatalogPublisher | null;
  distribution?: CatalogDistribution[] | null;
}

interface CatalogDataset {
  identifier?: unknown;
  slug?: unknown;
  title?: unknown;
  description?: unknown;
  publisher?: unknown;
  last_harvested_date?: unknown;
  organization?: CatalogOrganization | null;
  dcat?: CatalogDcat | null;
  harvest_record?: unknown;
}

interface CatalogSearchResponse {
  after?: unknown;
  sort?: unknown;
  results?: CatalogDataset[] | null;
}

interface CatalogPage {
  after: string | null;
  results: CatalogDataset[];
  requestUrl: string;
  provider: CatalogProvider;
  catalogLabel: string;
}

interface DatasetCandidate {
  id: string;
  publisher: string | null;
  jurisdictionName: string;
  title: string;
  description: string | null;
  sourceUrl: string;
  apiUrl: string;
  sourceClass: string;
  portalReview: DiscoveredCandidatePortalReview;
}

export interface DiscoveredCandidatePortalInput {
  id: string;
  publisher: string | null;
  jurisdictionName: string;
  title: string;
  description: string | null;
  sourceUrl: string;
}

export interface DiscoveredCandidatePortalReview {
  family: string;
  confidence: number;
  classifierVersion: string;
  evidence: Record<string, unknown>;
  networkAccessStatus: "disabled-until-reviewed";
  reviewStatus: "unverified";
  connectionState: "not-connected";
}

const DATA_GOV_SEARCH_URL = "https://api.gsa.gov/technology/datagov/v4/search";
const DATA_GOV_PUBLIC_SEARCH_URL = "https://catalog.data.gov/search";
const DATA_GOV_DATASET_URL = "https://catalog.data.gov/dataset/";
const REQUIRED_SOURCE_CLASSES = [
  "planning",
  "permits",
  "procurement",
  "documents",
  "bid-results",
  "awards",
  "capital-plans",
] as const;
type RequiredSourceClass = (typeof REQUIRED_SOURCE_CLASSES)[number];

const SOURCE_CLASS_QUERY_TERMS: Record<RequiredSourceClass, string> = {
  planning: "planning",
  permits: "building permits",
  procurement: "procurement",
  documents: "construction plans",
  "bid-results": "bid results",
  awards: "contract awards",
  "capital-plans": "capital improvement",
};
const DEFAULT_BATCH_SIZE = 3;
const MAX_BATCH_SIZE = 3;
const CATALOG_ROWS_PER_PAGE = 6;
const MAX_CANDIDATES_PER_JOB = 8;
const MAX_RESULTS_PER_SCAN = 24;
const REQUEST_TIMEOUT_MS = 12_000;
const REQUEST_SPACING_MS = 400;
const LEASE_DURATION_MS = 5 * 60 * 1000;
const PAGE_REQUEUE_MS = 10 * 60 * 1000;
const SUCCESS_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const BASE_RETRY_MS = 15 * 60 * 1000;
const MAX_RETRY_MS = 24 * 60 * 60 * 1000;

// Finish a jurisdiction's active source-class/page scan before opening another
// untouched row. Completed weekly rechecks are deliberately last so they cannot
// crowd out the initial registry pass. Population priority and due time still
// break ties inside each fairness tier.
const DISCOVERY_JOB_LEASE_ORDER_SQL = `
  CASE
    WHEN status='complete' THEN 2
    WHEN status IN ('retry', 'running')
      OR attempt_count > 0
      OR current_source_class IS NOT NULL
      OR cursor IS NOT NULL
      OR completed_source_classes <> '[]'
      THEN 0
    ELSE 1
  END ASC,
  priority DESC,
  next_run_at ASC,
  id ASC`;

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

class CatalogRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "CatalogRequestError";
  }
}

function boundedBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(value ?? DEFAULT_BATCH_SIZE)));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…`;
}

function parseCursor(value: string | null): DiscoveryCursor {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as DiscoveryCursor)
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function finiteNonnegative(value: unknown, fallback = 0): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : fallback;
}

function officialStateName(state: string | null): string | null {
  if (!state) return null;
  return STATE_NAMES[state.toUpperCase()] ?? state;
}

function normalizedSearchName(name: string, governmentType: string): string {
  if (!/municip|city|town|village|borough/i.test(governmentType)) return name.trim();
  return name
    .replace(/\s+(city|town|village|borough|municipality)$/i, "")
    .trim();
}

function sourceClassFromCursor(value: unknown): RequiredSourceClass | null {
  return typeof value === "string" &&
    (REQUIRED_SOURCE_CLASSES as readonly string[]).includes(value)
    ? (value as RequiredSourceClass)
    : null;
}

function requiredClassesForJob(job: LeasedJob): RequiredSourceClass[] {
  const requested = parseStringArray(job.requiredSourceClasses)
    .map(sourceClassFromCursor)
    .filter((sourceClass): sourceClass is RequiredSourceClass => sourceClass !== null);
  return [...new Set([...requested, ...REQUIRED_SOURCE_CLASSES])];
}

function completedClassesForJob(
  job: LeasedJob,
  requiredClasses: RequiredSourceClass[],
): RequiredSourceClass[] {
  const completed = new Set(parseStringArray(job.completedSourceClasses));
  return requiredClasses.filter((sourceClass) => completed.has(sourceClass));
}

function catalogQuery(job: LeasedJob, sourceClass: RequiredSourceClass): string {
  const jurisdiction = normalizedSearchName(job.jurisdictionName, job.governmentType);
  // Data.gov's full-text search behaves conjunctively. State names and long
  // synonym lists cause valid local datasets to disappear from the result set.
  // State and ownership are verified after discovery; this query only produces
  // review candidates and never marks a source connected.
  return [jurisdiction, SOURCE_CLASS_QUERY_TERMS[sourceClass]]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function catalogOrganizationType(governmentType: string): string | null {
  if (/county|parish/i.test(governmentType)) return "County Government";
  if (/state/i.test(governmentType)) return "State Government";
  if (/municip|city|town|village|borough/i.test(governmentType)) return "City Government";
  return null;
}

function buildV4CatalogUrl(job: LeasedJob, query: string, after: string | null): string {
  const url = new URL(DATA_GOV_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(CATALOG_ROWS_PER_PAGE));
  url.searchParams.set("sort", "relevance");
  const organizationType = catalogOrganizationType(job.governmentType);
  if (organizationType) url.searchParams.set("org_type", organizationType);
  if (after) url.searchParams.set("after", after);
  return url.toString();
}

function buildPublicCatalogUrl(job: LeasedJob, query: string, after: string | null): string {
  const url = new URL(DATA_GOV_PUBLIC_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(CATALOG_ROWS_PER_PAGE));
  url.searchParams.set("sort", "relevance");
  const organizationType = catalogOrganizationType(job.governmentType);
  if (organizationType) url.searchParams.set("org_type", organizationType);
  if (after) url.searchParams.set("after", after);
  return url.toString();
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_MS);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.min(date - Date.now(), MAX_RETRY_MS));
}

async function fetchCatalogPage(
  apiKey: string | undefined,
  job: LeasedJob,
  query: string,
  after: string | null,
): Promise<CatalogPage> {
  const normalizedApiKey = apiKey?.trim();
  const provider: CatalogProvider = normalizedApiKey ? "gsa-v4" : "catalog-public";
  const requestUrl = normalizedApiKey
    ? buildV4CatalogUrl(job, query, after)
    : buildPublicCatalogUrl(job, query, after);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(requestUrl, {
      headers: {
        accept: "application/json",
        ...(normalizedApiKey ? { "X-Api-Key": normalizedApiKey } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const defaultRetry = response.status === 429
        ? 60 * 60 * 1000
        : response.status === 403
          ? MAX_RETRY_MS
          : undefined;
      throw new CatalogRequestError(
        `Data.gov catalog returned HTTP ${response.status}.`,
        response.status,
        retryAfterMilliseconds(response.headers.get("retry-after")) ?? defaultRetry,
      );
    }
    const payload = (await response.json()) as CatalogSearchResponse;
    if (!Array.isArray(payload.results)) {
      throw new CatalogRequestError("Data.gov catalog returned an invalid search response.");
    }
    return {
      after: stringValue(payload.after),
      results: payload.results,
      requestUrl,
      provider,
      catalogLabel:
        provider === "gsa-v4"
          ? "official GSA Data.gov v4 catalog API"
          : "official public Data.gov catalog search API",
    };
  } catch (error) {
    if (error instanceof CatalogRequestError) throw error;
    if (controller.signal.aborted) {
      throw new CatalogRequestError(`Data.gov catalog request timed out after ${REQUEST_TIMEOUT_MS}ms.`);
    }
    const message = error instanceof Error ? error.message : "Unknown catalog request failure";
    throw new CatalogRequestError(`Data.gov catalog request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedHttpUrl(value: unknown): string | null {
  const candidate = stringValue(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function classifyDiscoveredCandidatePortal(
  candidate: DiscoveredCandidatePortalInput,
): DiscoveredCandidatePortalReview {
  const classification = classifyPortal({
    url: candidate.sourceUrl,
    title: candidate.title,
    description: candidate.description ?? undefined,
    owner: candidate.publisher ?? candidate.jurisdictionName,
  });
  const adapterCandidate = createSafePortalAdapterCandidate(
    {
      sourceKey: candidate.id,
      official: true,
      url: candidate.sourceUrl,
      title: candidate.title,
      description: candidate.description ?? undefined,
      owner: candidate.publisher ?? candidate.jurisdictionName,
    },
    classification,
  );
  const safety = adapterCandidate?.safety ?? {
    automatedNetworkAccess: "disabled-until-reviewed" as const,
    allowedMethodsAfterReview: [],
    credentialPolicy: "never-automate-or-store" as const,
    accessControlPolicy: "do-not-bypass" as const,
    publicMetadataOnly: true as const,
    robotsReviewRequired: true as const,
    termsReviewRequired: true as const,
    rateLimitReviewRequired: true as const,
  };

  return {
    family: classification.family,
    confidence: classification.confidenceScore,
    classifierVersion: PORTAL_CLASSIFIER_VERSION,
    evidence: {
      signals: classification.evidence,
      conflictingFamilies: classification.conflictingFamilies,
      candidateKind: adapterCandidate?.candidateKind ?? "manual-source-review",
      requiresHumanReview: true,
      safety,
      metadataScope: "data-gov-candidate-title-description-publisher-and-source-url",
    },
    networkAccessStatus: "disabled-until-reviewed",
    reviewStatus: "unverified",
    connectionState: "not-connected",
  };
}

function sourceClassFor(
  value: string,
  searchedClass: RequiredSourceClass,
): RequiredSourceClass {
  if (/capital improvement|capital program|capital plan|\bcip\b/i.test(value)) {
    return "capital-plans";
  }
  if (/bid tab|bid result|bid opening|apparent low|bidder list/i.test(value)) {
    return "bid-results";
  }
  if (/notice of award|contract award|awarded contract|award recommendation/i.test(value)) {
    return "awards";
  }
  if (/construction drawing|plan set|blueprint|specification|addend(?:um|a)|bid document/i.test(value)) {
    return "documents";
  }
  if (/\bpermit(?:s|ting)?\b|plan review|building code|inspection/i.test(value)) {
    return "permits";
  }
  if (/procurement|purchasing|solicitation|contract opportunit|\brfp\b|\brfq\b/i.test(value)) {
    return "procurement";
  }
  if (/planning|zoning|development review|site plan|land use/i.test(value)) {
    return "planning";
  }
  return searchedClass;
}

function distributionUrl(distribution: CatalogDistribution): string | null {
  return normalizedHttpUrl(distribution.accessURL) ?? normalizedHttpUrl(distribution.downloadURL);
}

function resourceScore(resource: CatalogDistribution): number {
  const format = [stringValue(resource.format), stringValue(resource.mediaType)]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
  const url = distributionUrl(resource) ?? "";
  if (normalizedHttpUrl(resource.accessURL)) return 4;
  if (/API|JSON|GEOJSON|CSV|XML|ARCGIS|SOCRATA/.test(format)) return 3;
  if (/api|query|resource|dataset/i.test(url)) return 2;
  return 1;
}

async function stableCandidateId(sourceUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`data.gov|${sourceUrl}`),
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `candidate_${hex}`;
}

async function candidatesFromPage(
  page: CatalogPage,
  job: LeasedJob,
  query: string,
  searchedClass: RequiredSourceClass,
): Promise<DatasetCandidate[]> {
  const byUrl = new Map<string, Omit<DatasetCandidate, "id">>();
  for (const dataset of page.results) {
    const datasetName =
      stringValue(dataset.slug) ??
      stringValue(dataset.identifier) ??
      stringValue(dataset.dcat?.identifier);
    const datasetTitle =
      stringValue(dataset.title) ??
      stringValue(dataset.dcat?.title) ??
      datasetName ??
      "Untitled Data.gov dataset";
    const landingUrl =
      normalizedHttpUrl(dataset.dcat?.landingPage) ??
      normalizedHttpUrl(dataset.identifier) ??
      (stringValue(dataset.slug)
        ? `${DATA_GOV_DATASET_URL}${encodeURIComponent(stringValue(dataset.slug) ?? "")}`
        : null);
    const publisher =
      stringValue(dataset.organization?.name) ??
      stringValue(dataset.publisher) ??
      stringValue(dataset.dcat?.publisher?.name);
    const resources = Array.isArray(dataset.dcat?.distribution)
      ? [...dataset.dcat.distribution]
          .filter((resource) => distributionUrl(resource))
          .sort((left, right) => resourceScore(right) - resourceScore(left))
          .slice(0, 2)
      : [];
    const selectedResources: CatalogDistribution[] = resources.length
      ? resources
      : landingUrl
        ? [{ title: "Data.gov dataset", accessURL: landingUrl, format: "CATALOG" }]
        : [];

    for (const resource of selectedResources) {
      const sourceUrl = distributionUrl(resource);
      if (!sourceUrl || byUrl.has(sourceUrl)) continue;
      const resourceName = stringValue(resource.title);
      const resourceFormat = stringValue(resource.format) ?? stringValue(resource.mediaType);
      const datasetDescription =
        stringValue(dataset.description) ?? stringValue(dataset.dcat?.description);
      const searchable = [
        datasetTitle,
        datasetDescription,
        resourceName,
        stringValue(resource.description),
      ]
        .filter((value): value is string => Boolean(value))
        .join(" ");
      const provenance = [
        datasetDescription,
        stringValue(resource.description),
        `Discovered through the ${page.catalogLabel}. Dataset: ${datasetName ?? "unknown"}.`,
        `Expected registry jurisdiction: ${job.jurisdictionName}${
          officialStateName(job.state) ? `, ${officialStateName(job.state)}` : ""
        }. Association remains unverified until source review.`,
        `Requested coverage class: ${searchedClass}.`,
        `Catalog query: ${query}`,
        stringValue(dataset.last_harvested_date)
          ? `Catalog last harvested: ${stringValue(dataset.last_harvested_date)}.`
          : null,
        stringValue(dataset.dcat?.modified)
          ? `Publisher metadata modified: ${stringValue(dataset.dcat?.modified)}.`
          : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n\n");
      byUrl.set(sourceUrl, {
        publisher,
        jurisdictionName: [job.jurisdictionName, job.state].filter(Boolean).join(", "),
        title: truncate(
          resourceName && resourceName !== datasetTitle
            ? `${datasetTitle} — ${resourceName}${resourceFormat ? ` (${resourceFormat})` : ""}`
            : datasetTitle,
          500,
        ),
        description: provenance ? truncate(provenance, 4_000) : null,
        sourceUrl,
        apiUrl: page.requestUrl,
        sourceClass: sourceClassFor(searchable, searchedClass),
      });
      if (byUrl.size >= MAX_CANDIDATES_PER_JOB) break;
    }
    if (byUrl.size >= MAX_CANDIDATES_PER_JOB) break;
  }

  return Promise.all(
    [...byUrl.values()].map(async (candidate) => {
      const id = await stableCandidateId(candidate.sourceUrl);
      return {
        id,
        ...candidate,
        portalReview: classifyDiscoveredCandidatePortal({ id, ...candidate }),
      };
    }),
  );
}

function candidateStatements(
  db: D1Database,
  candidate: DatasetCandidate,
  jurisdictionId: string,
): D1PreparedStatement[] {
  // Discovery writes review candidates only. It never writes the sources
  // table and never promotes any candidate to a connected state. Automated
  // portal classification is persisted with network access disabled and can
  // refresh only metadata that has not already received a human review.
  return [
    db.prepare(
      `INSERT INTO dataset_candidates (
        id, catalog, publisher, jurisdiction_name, title, description,
        source_url, api_url, source_class, status, portal_family,
        portal_confidence, portal_classifier_version, portal_evidence,
        portal_network_access_status, portal_review_status,
        portal_connection_state, classified_at, discovered_at
      ) VALUES (
        ?, 'data.gov', ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?,
        'unverified', 'not-connected', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT(catalog, source_url) DO UPDATE SET
        publisher=excluded.publisher,
        jurisdiction_name=CASE
          WHEN dataset_candidates.jurisdiction_name IS NULL THEN excluded.jurisdiction_name
          WHEN dataset_candidates.jurisdiction_name=excluded.jurisdiction_name THEN dataset_candidates.jurisdiction_name
          ELSE 'Multiple jurisdictions'
        END,
        title=excluded.title,
        description=excluded.description,
        api_url=excluded.api_url,
        source_class=excluded.source_class,
        portal_family=CASE
          WHEN dataset_candidates.portal_review_status IN ('verified', 'rejected')
            THEN dataset_candidates.portal_family
          ELSE excluded.portal_family
        END,
        portal_confidence=CASE
          WHEN dataset_candidates.portal_review_status IN ('verified', 'rejected')
            THEN dataset_candidates.portal_confidence
          ELSE excluded.portal_confidence
        END,
        portal_classifier_version=CASE
          WHEN dataset_candidates.portal_review_status IN ('verified', 'rejected')
            THEN dataset_candidates.portal_classifier_version
          ELSE excluded.portal_classifier_version
        END,
        portal_evidence=CASE
          WHEN dataset_candidates.portal_review_status IN ('verified', 'rejected')
            THEN dataset_candidates.portal_evidence
          ELSE excluded.portal_evidence
        END,
        portal_network_access_status=CASE
          WHEN dataset_candidates.portal_review_status='verified'
            THEN dataset_candidates.portal_network_access_status
          ELSE 'disabled-until-reviewed'
        END,
        portal_review_status=CASE
          WHEN dataset_candidates.portal_review_status IN ('verified', 'rejected')
            THEN dataset_candidates.portal_review_status
          ELSE 'unverified'
        END,
        portal_connection_state=CASE
          WHEN dataset_candidates.portal_review_status='verified'
            THEN dataset_candidates.portal_connection_state
          ELSE 'not-connected'
        END,
        classified_at=CASE
          WHEN dataset_candidates.portal_review_status IN ('verified', 'rejected')
            THEN dataset_candidates.classified_at
          ELSE excluded.classified_at
        END,
        status=CASE
          WHEN dataset_candidates.status='verified' THEN 'verified'
          WHEN dataset_candidates.status='rejected' THEN 'rejected'
          ELSE 'candidate'
        END,
        last_verified_at=CASE
          WHEN dataset_candidates.status='verified' THEN dataset_candidates.last_verified_at
          ELSE NULL
        END`,
    ).bind(
      candidate.id,
      candidate.publisher,
      candidate.jurisdictionName,
      candidate.title,
      candidate.description,
      candidate.sourceUrl,
      candidate.apiUrl,
      candidate.sourceClass,
      candidate.portalReview.family,
      candidate.portalReview.confidence,
      candidate.portalReview.classifierVersion,
      JSON.stringify(candidate.portalReview.evidence),
      candidate.portalReview.networkAccessStatus,
    ),
    db.prepare(
      `INSERT INTO dataset_candidate_jurisdictions (
        candidate_id, jurisdiction_id, match_method, confidence,
        evidence_url, verification_status, observed_at, created_at, updated_at
      )
       SELECT id, ?, 'catalog-query-candidate', 0.5, ?, 'unverified',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM dataset_candidates
      WHERE catalog='data.gov' AND source_url=?
       ON CONFLICT(candidate_id, jurisdiction_id) DO UPDATE SET
        match_method=CASE
          WHEN dataset_candidate_jurisdictions.verification_status='unverified'
            THEN excluded.match_method
          ELSE dataset_candidate_jurisdictions.match_method
        END,
        confidence=CASE
          WHEN dataset_candidate_jurisdictions.verification_status='unverified'
            THEN excluded.confidence
          ELSE dataset_candidate_jurisdictions.confidence
        END,
        evidence_url=CASE
          WHEN dataset_candidate_jurisdictions.verification_status='unverified'
            THEN excluded.evidence_url
          ELSE dataset_candidate_jurisdictions.evidence_url
        END,
        observed_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP`,
    ).bind(jurisdictionId, candidate.apiUrl, candidate.sourceUrl),
  ];
}

async function seedDiscoveryJobs(
  db: D1Database,
  now: string,
  limit: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO jurisdiction_discovery_jobs (
        id, jurisdiction_id, status, priority, required_source_classes,
        completed_source_classes, source_candidates_found, connected_sources,
        loaded_projects, indexed_documents, attempt_count, next_run_at,
        created_at, updated_at
      )
      SELECT
        'discovery:' || jurisdictions.id,
        jurisdictions.id,
        'queued',
        CASE
          WHEN jurisdictions.population >= 1000000 THEN 100
          WHEN jurisdictions.population >= 100000 THEN 50
          WHEN jurisdictions.population >= 10000 THEN 20
          ELSE 0
        END,
        ?, '[]', 0, 0, 0, 0, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM jurisdictions
      WHERE jurisdictions.active=1
        AND NOT EXISTS (
          SELECT 1 FROM jurisdiction_discovery_jobs jobs
          WHERE jobs.jurisdiction_id=jurisdictions.id
        )
      ORDER BY
        jurisdictions.population IS NULL,
        jurisdictions.population DESC,
        jurisdictions.id
      LIMIT ?`,
    )
    .bind(JSON.stringify(REQUIRED_SOURCE_CLASSES), now, limit)
    .run();
}

async function leaseDueJobs(
  db: D1Database,
  leaseOwner: string,
  now: string,
  leaseExpiresAt: string,
  limit: number,
): Promise<LeasedJob[]> {
  await db
    .prepare(
      `UPDATE jurisdiction_discovery_jobs
       SET status='running',
           connector_family='data-gov-catalog',
           current_source_class=COALESCE(current_source_class, 'planning'),
           lease_owner=?,
           lease_expires_at=?,
           last_started_at=?,
           attempt_count=attempt_count + 1,
           updated_at=CURRENT_TIMESTAMP
       WHERE id IN (
         SELECT id
         FROM jurisdiction_discovery_jobs
         WHERE next_run_at <= ?
           AND (
             (status IN ('queued', 'retry', 'complete')
               AND (lease_expires_at IS NULL OR lease_expires_at < ?))
             OR (status='running' AND lease_expires_at < ?)
           )
         ORDER BY ${DISCOVERY_JOB_LEASE_ORDER_SQL}
         LIMIT ?
       )`,
    )
    .bind(leaseOwner, leaseExpiresAt, now, now, now, now, limit)
    .run();

  const result = await db
    .prepare(
      `SELECT
         jobs.id,
         jobs.jurisdiction_id AS jurisdictionId,
         jurisdictions.name AS jurisdictionName,
         jurisdictions.government_type AS governmentType,
         jurisdictions.state,
         jobs.required_source_classes AS requiredSourceClasses,
         jobs.completed_source_classes AS completedSourceClasses,
         jobs.cursor,
         jobs.attempt_count AS attemptCount,
         jobs.source_candidates_found AS sourceCandidatesFound
       FROM jurisdiction_discovery_jobs jobs
       JOIN jurisdictions ON jurisdictions.id=jobs.jurisdiction_id
       WHERE jobs.lease_owner=?
       ORDER BY jobs.priority DESC, jobs.next_run_at, jobs.id`,
    )
    .bind(leaseOwner)
    .all<LeasedJob>();
  return result.results ?? [];
}

function failureDelay(cursor: DiscoveryCursor, error: unknown): number {
  const failureCount = finiteNonnegative(cursor.failureCount) + 1;
  const exponential = Math.min(
    MAX_RETRY_MS,
    BASE_RETRY_MS * 2 ** Math.min(failureCount - 1, 6),
  );
  return error instanceof CatalogRequestError && error.retryAfterMs !== undefined
    ? Math.max(exponential, error.retryAfterMs)
    : exponential;
}

async function recordFailure(
  db: D1Database,
  job: LeasedJob,
  leaseOwner: string,
  cursor: DiscoveryCursor,
  error: unknown,
): Promise<void> {
  const finishedAt = new Date().toISOString();
  const nextRunAt = new Date(Date.now() + failureDelay(cursor, error)).toISOString();
  const message = error instanceof Error ? error.message : "Unknown jurisdiction discovery error";
  const failureCursor: DiscoveryCursor = {
    ...cursor,
    failureCount: finiteNonnegative(cursor.failureCount) + 1,
    lastErrorAt: finishedAt,
  };
  await db
    .prepare(
      `UPDATE jurisdiction_discovery_jobs
       SET status='retry',
           cursor=?,
           next_run_at=?,
           last_finished_at=?,
           error=?,
           lease_owner=NULL,
           lease_expires_at=NULL,
           current_source_class=?,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND lease_owner=?`,
    )
    .bind(
      JSON.stringify(failureCursor),
      nextRunAt,
      finishedAt,
      truncate(message, 2_000),
      sourceClassFromCursor(failureCursor.sourceClass),
      job.id,
      leaseOwner,
    )
    .run();
}

async function recordSuccess(
  db: D1Database,
  jobId: string,
  jurisdictionId: string,
  leaseOwner: string,
  cursor: DiscoveryCursor,
  query: string,
  sourceClass: RequiredSourceClass,
  requiredClasses: RequiredSourceClass[],
  completedClasses: RequiredSourceClass[],
  page: CatalogPage,
  candidates: DatasetCandidate[],
): Promise<"complete" | "queued"> {
  const finishedAt = new Date().toISOString();
  const resultsSeen = finiteNonnegative(cursor.resultsSeen) + page.results.length;
  const hasMore = page.results.length > 0 && Boolean(page.after);
  const bounded = hasMore && resultsSeen >= MAX_RESULTS_PER_SCAN;
  const classComplete = !hasMore || bounded;
  const nextCompletedClasses = classComplete
    ? [...new Set([...completedClasses, sourceClass])]
    : completedClasses;
  const complete = requiredClasses.every((item) => nextCompletedClasses.includes(item));
  const nextSourceClass = complete
    ? null
    : classComplete
      ? (requiredClasses.find((item) => !nextCompletedClasses.includes(item)) ?? sourceClass)
      : sourceClass;
  const scanCandidateCount = finiteNonnegative(cursor.scanCandidateCount) + candidates.length;
  const nextRunAt = new Date(
    Date.now() + (complete ? SUCCESS_RECHECK_MS : PAGE_REQUEUE_MS),
  ).toISOString();
  const truncatedSourceClasses = Array.isArray(cursor.truncatedSourceClasses)
    ? cursor.truncatedSourceClasses.filter((item): item is string => typeof item === "string")
    : [];
  if (bounded && !truncatedSourceClasses.includes(sourceClass)) {
    truncatedSourceClasses.push(sourceClass);
  }
  const successCursor: DiscoveryCursor = complete
    ? {
        sourceClass: requiredClasses[0],
        resultsSeen: 0,
        scanCandidateCount: 0,
        lastScanCandidateCount: scanCandidateCount,
        failureCount: 0,
        lastCatalogUrl: page.requestUrl,
        lastCompletedAt: finishedAt,
        truncatedSourceClasses,
        catalogProvider: page.provider,
      }
    : {
        sourceClass: nextSourceClass ?? undefined,
        after: classComplete ? undefined : (page.after ?? undefined),
        query: classComplete ? undefined : query,
        resultsSeen: classComplete ? 0 : resultsSeen,
        scanCandidateCount,
        failureCount: 0,
        lastCatalogUrl: page.requestUrl,
        lastCompletedAt: cursor.lastCompletedAt,
        truncatedSourceClasses,
        catalogProvider: page.provider,
      };

  const statements = candidates.flatMap((candidate) =>
    candidateStatements(db, candidate, jurisdictionId),
  );
  statements.push(
    db
      .prepare(
        `UPDATE jurisdiction_discovery_jobs
         SET status=?,
             required_source_classes=?,
             completed_source_classes=?,
             source_candidates_found=?,
             cursor=?,
             next_run_at=?,
             last_finished_at=?,
             last_success_at=?,
             error=NULL,
             lease_owner=NULL,
             lease_expires_at=NULL,
             current_source_class=?,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=? AND lease_owner=?`,
      )
      .bind(
        complete ? "complete" : "queued",
        JSON.stringify(requiredClasses),
        JSON.stringify(nextCompletedClasses),
        scanCandidateCount,
        JSON.stringify(successCursor),
        nextRunAt,
        finishedAt,
        finishedAt,
        nextSourceClass,
        jobId,
        leaseOwner,
      ),
  );
  await db.batch(statements);
  return complete ? "complete" : "queued";
}

export async function runJurisdictionDiscovery(
  env: JurisdictionDiscoveryEnv,
  options: JurisdictionDiscoveryOptions = {},
): Promise<JurisdictionDiscoveryResult> {
  const trigger = options.trigger ?? "scheduled";
  const batchSize = boundedBatchSize(options.batchSize);
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  const apiKey = env.DATA_GOV_API_KEY?.trim();
  const catalogProvider: CatalogProvider = apiKey ? "gsa-v4" : "catalog-public";
  if (!apiKey) {
    warnings.push(
      "DATA_GOV_API_KEY is not configured; discovery is using the bounded official public Data.gov catalog search fallback.",
    );
  }
  const leaseOwner = `jurisdiction-discovery:${trigger}:${crypto.randomUUID()}`;
  const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();

  // Seed only a small bounded queue slice. Future invocations continue walking
  // the registry without creating a 97k-row write burst.
  await seedDiscoveryJobs(env.DB, startedAt, batchSize * 4);
  const jobs = await leaseDueJobs(
    env.DB,
    leaseOwner,
    startedAt,
    leaseExpiresAt,
    batchSize,
  );
  if (!jobs.length) {
    return {
      trigger,
      status: "skipped",
      leasedJobs: 0,
      completedJobs: 0,
      requeuedJobs: 0,
      failedJobs: 0,
      candidates: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      warnings: [...warnings, "No jurisdiction discovery jobs were due."],
    };
  }

  let completedJobs = 0;
  let requeuedJobs = 0;
  let failedJobs = 0;
  let candidateCount = 0;

  for (const [index, job] of jobs.entries()) {
    if (index > 0) await delay(REQUEST_SPACING_MS);
    const cursor = parseCursor(job.cursor);
    const requiredClasses = requiredClassesForJob(job);
    let completedClasses = completedClassesForJob(job, requiredClasses);
    const startingNewScan = requiredClasses.every((item) => completedClasses.includes(item));
    if (startingNewScan) completedClasses = [];
    const cursorSourceClass = sourceClassFromCursor(cursor.sourceClass);
    const sourceClass =
      (!startingNewScan &&
      cursorSourceClass &&
      requiredClasses.includes(cursorSourceClass) &&
      !completedClasses.includes(cursorSourceClass)
        ? cursorSourceClass
        : requiredClasses.find((item) => !completedClasses.includes(item))) ?? requiredClasses[0];
    const query = catalogQuery(job, sourceClass);
    const continuingPage =
      !startingNewScan &&
      cursor.catalogProvider === catalogProvider &&
      cursor.sourceClass === sourceClass &&
      cursor.query === query;
    const requestCursor: DiscoveryCursor = {
      sourceClass,
      query,
      catalogProvider,
      after: continuingPage ? stringValue(cursor.after) ?? undefined : undefined,
      resultsSeen: continuingPage
        ? Math.min(finiteNonnegative(cursor.resultsSeen), MAX_RESULTS_PER_SCAN)
        : 0,
      scanCandidateCount: startingNewScan
        ? 0
        : Math.max(
            finiteNonnegative(cursor.scanCandidateCount),
            completedClasses.length ? finiteNonnegative(job.sourceCandidatesFound) : 0,
          ),
      failureCount: finiteNonnegative(cursor.failureCount),
      lastCompletedAt: cursor.lastCompletedAt,
      truncatedSourceClasses: startingNewScan ? [] : cursor.truncatedSourceClasses,
    };
    try {
      const page = await fetchCatalogPage(
        apiKey,
        job,
        query,
        stringValue(requestCursor.after),
      );
      const candidates = await candidatesFromPage(page, job, query, sourceClass);
      const status = await recordSuccess(
        env.DB,
        job.id,
        job.jurisdictionId,
        leaseOwner,
        requestCursor,
        query,
        sourceClass,
        requiredClasses,
        completedClasses,
        page,
        candidates,
      );
      candidateCount += candidates.length;
      if (status === "complete") completedJobs += 1;
      else requeuedJobs += 1;
    } catch (error) {
      failedJobs += 1;
      const message = error instanceof Error ? error.message : "Unknown discovery error";
      warnings.push(`${job.jurisdictionName}: ${message}`);
      try {
        await recordFailure(env.DB, job, leaseOwner, requestCursor, error);
      } catch (recordError) {
        const recordMessage = recordError instanceof Error ? recordError.message : "Unknown D1 error";
        warnings.push(
          `${job.jurisdictionName}: failure bookkeeping also failed (${recordMessage}). The lease will expire automatically.`,
        );
      }
    }
  }

  return {
    trigger,
    status: failedJobs ? "partial" : "complete",
    leasedJobs: jobs.length,
    completedJobs,
    requeuedJobs,
    failedJobs,
    candidates: candidateCount,
    startedAt,
    finishedAt: new Date().toISOString(),
    warnings,
  };
}
