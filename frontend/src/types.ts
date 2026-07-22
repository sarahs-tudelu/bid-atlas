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

export interface ProjectDocument {
  name: string;
  kind: string;
  url: string;
  access?: string;
  indexStatus?: string;
}

export interface ProjectParticipant {
  name?: string;
  role?: string;
  participantType?: string;
  organization?: string;
  email?: string;
  phone?: string;
  sourceUrl?: string;
}

export interface Project {
  id: string;
  sourceId: string;
  sourceRecordId: string;
  title: string;
  summary?: string;
  stage: ProjectStage;
  status?: string;
  agency?: string;
  address?: string;
  city?: string;
  county?: string;
  state?: string;
  postalCode?: string;
  value?: number;
  postedAt?: string;
  updatedAt?: string;
  bidDate?: string;
  bidDateTimeZone?: string;
  sourceName?: string;
  sourceUrl: string;
  documents?: ProjectDocument[];
  participants?: ProjectParticipant[];
  documentTextIndexed?: boolean;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  totalPages: number;
  matchedProjects?: number;
  returnedProjects?: number;
  total?: number;
  snapshotGeneratedAt?: string;
  sourceMode?: string;
  warnings?: string[];
}

export interface SearchResponse {
  projects: Project[];
  meta: PageMeta;
}

export interface CoverageState {
  code: string;
  name: string;
  procurement: string;
  dotBidding: string;
  permits: string;
  planning: string;
  loadedProjects: number;
  procurementUrl: string;
  dotBiddingUrl: string;
}

export interface CoverageResponse {
  coverage: {
    asOf: string;
    nationallyComplete: boolean;
    localGovernmentUniverse: number;
    registryRowsAvailable: number;
    statesAndDistrict: number;
    connectedSourceGroups: number;
    identifiedSourceGroups: number;
    loadedProjectRecords: number;
    statement: string;
    states: CoverageState[];
  };
  inventory: {
    totalProjects: number;
    stageCounts: Record<string, number>;
    stateCounts: Record<string, number>;
    contractorOrganizations: number;
    refreshedAt: string;
  };
  sources: Source[];
  warnings: string[];
}

export interface Source {
  id: string;
  name: string;
  owner: string;
  sourceClass: string;
  status: string;
  jurisdiction: string;
  loadedCount?: number;
  recordCount?: number;
  lastChecked?: string;
  url: string;
}

export interface DashboardResponse {
  generatedAt: string;
  projects: Project[];
  sources: Source[];
  coverage: CoverageResponse["coverage"];
  inventory: CoverageResponse["inventory"];
  warnings: string[];
}

export interface Company {
  name: string;
  role: string;
  projectCount: number;
  states: string[];
  projects: Array<{ id: string; title: string }>;
}

export interface DocumentRecord extends ProjectDocument {
  id: string;
  projectId: string;
  projectTitle: string;
}
