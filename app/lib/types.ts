import type { BidDateTimeZone } from "./deadline-time";

export type ProjectStage =
  | "planning"
  | "design"
  | "permitting"
  | "bidding"
  | "bid-opened"
  | "awarded"
  | "construction"
  | "completed"
  | "cancelled"
  | "unclassified";

export type ProjectFreshness =
  | "new"
  | "current"
  | "stale"
  | "closed"
  | "inactive"
  | "unclassified";

export type FreshnessFilter =
  | ProjectFreshness
  | "actionable"
  | "closed-or-inactive"
  | "all";

export type SourceStatus =
  | "live"
  | "credential-required"
  | "degraded"
  | "registry";

export type SourceClass =
  | "planning"
  | "permits"
  | "procurement"
  | "documents"
  | "bid-results"
  | "awards"
  | "capital-plans"
  | "registry";

export interface ProjectDocument {
  name: string;
  kind:
    | "agenda"
    | "permit"
    | "plans"
    | "specifications"
    | "addendum"
    | "bid-tab"
    | "award"
    | "source-record";
  url: string;
  access: "public" | "free-account";
  indexStatus?:
    | "metadata-only"
    | "queued"
    | "text-indexed"
    | "account-gated"
    | "not-public";
}

export interface ProjectParticipant {
  name: string;
  role:
    | "owner"
    | "agency"
    | "architect"
    | "engineer"
    | "bidder"
    | "plan-holder"
    | "contractor";
  participantType?: "person" | "organization";
  organization?: string;
  email?: string;
  phone?: string;
  sourceUrl?: string;
}

export interface ProjectRecord {
  id: string;
  sourceId: string;
  sourceRecordId: string;
  title: string;
  summary: string;
  stage: ProjectStage;
  status: string;
  agency: string;
  address?: string;
  city?: string;
  county?: string;
  state?: string;
  postalCode?: string;
  value?: number;
  postedAt?: string;
  bidDate?: string;
  /** IANA timezone used to interpret a source-published floating bid deadline. */
  bidDateTimeZone?: BidDateTimeZone;
  updatedAt: string;
  sourceName: string;
  sourceUrl: string;
  provenance: "live-api" | "live-public-page";
  confidence: "official" | "inferred";
  documents: ProjectDocument[];
  participants: ProjectParticipant[];
  searchableFields?: string[];
  documentTextIndexed?: boolean;
}

export interface SourceRecord {
  id: string;
  name: string;
  owner: string;
  level: "federal" | "state" | "local" | "registry";
  sourceClass: SourceClass;
  stages: ProjectStage[];
  status: SourceStatus;
  access: "open" | "free-key";
  cadence: string;
  recordCount: number;
  /** What the upstream total actually counts when it is not a project total. */
  recordCountUnit?: "records" | "rows" | "projects";
  loadedCount?: number;
  snapshotComplete?: boolean;
  lastChecked: string;
  url: string;
  jurisdiction: string;
  note: string;
}

export interface SourcePageRecord {
  offset: number;
  recordsRead: number;
  nextOffset: number;
  hasMore: boolean;
  currentCursor: SourceCursorRecord;
  nextCursor: SourceCursorRecord;
}

export interface SourceCursorRecord {
  offset: number;
  refreshAfter?: boolean;
  matchedRecords?: number;
  lastRecordUniqueId?: string | number;
  lastRecordSortValue?: string | number;
  windowStart?: string;
  windowEnd?: string;
}

export type CoverageState =
  | "connected"
  | "partial"
  | "identified"
  | "credential-required"
  | "not-public"
  | "not-connected";

export interface StateCoverageRecord {
  code: string;
  name: string;
  procurementUrl: string;
  dotBiddingUrl: string;
  procurement: CoverageState;
  dotBidding: CoverageState;
  permits: CoverageState;
  planning: CoverageState;
  loadedProjects: number;
}

export interface CoverageSummary {
  asOf: string;
  nationallyComplete: false;
  localGovernmentUniverse: number;
  registryRowsAvailable: number;
  dependentAgencyRowsAvailable: number;
  statesAndDistrict: number;
  connectedSourceGroups: number;
  identifiedSourceGroups: number;
  loadedProjectRecords: number;
  documentTextIndexedProjects: number;
  denominatorSourceUrl: string;
  statement: string;
  states: StateCoverageRecord[];
}

export type SearchMatch = "all" | "any" | "phrase";

export type BidDueFilter = "all" | "today" | "7-days" | "14-days";

export type ProjectReadinessFilter = "bid-ready" | "all";

export interface ProjectSearchOptions {
  keywords: string[];
  location?: string;
  match: SearchMatch;
  stage?: ProjectStage | "all";
  state?: string;
  freshness?: FreshnessFilter;
  due?: BidDueFilter;
  /** The primary queue admits only official, current bids with usable documents. */
  readiness?: ProjectReadinessFilter;
  /** Completed and cancelled records are archived from actionable search by default. */
  includeArchived?: boolean;
}

export interface SearchResultMeta {
  terms: string[];
  location?: string;
  match: SearchMatch;
  freshness?: FreshnessFilter;
  due?: BidDueFilter;
  readiness?: ProjectReadinessFilter;
  includeArchived?: boolean;
  searchedProjects: number;
  matchedProjects: number;
  sourceReportedMatches?: number;
  sourceQueryableRecords?: number;
  resultLimitReached?: boolean;
  metadataIndexedProjects: number;
  documentTextIndexedProjects: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  returnedProjects?: number;
  nationallyComplete: false;
  notice: string;
}

export interface ProjectInventorySummary {
  mode: "persisted-and-live" | "live-fallback";
  totalProjects: number;
  stageCounts: Record<ProjectStage, number>;
  stateCounts: Record<string, number>;
  sourceCounts: Record<string, number>;
  documentTextIndexedProjects: number;
  contractorOrganizations: number;
  refreshedAt?: string;
}

export interface ProjectFeed {
  generatedAt: string;
  projects: ProjectRecord[];
  sources: SourceRecord[];
  sourcePages?: Record<string, SourcePageRecord>;
  warnings: string[];
  coverage: CoverageSummary;
  inventory?: ProjectInventorySummary;
}
