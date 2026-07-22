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

export interface CanopyFit {
  score: number;
  band: "high" | "possible" | "low";
  reasons: string[];
}

export interface SearchPreset {
  id: string;
  label: string;
  description: string;
  minimumScore: number;
  states: string[];
}

export interface OutreachContact {
  name: string;
  email: string;
  phone: string;
  role: string;
}

export interface AuthUser {
  email: string;
  name: string;
  picture: string;
  gmailConnected: boolean;
}

export interface GmailMessageSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface GmailThreadSummary {
  threadId: string;
  messages: GmailMessageSummary[];
}

export interface OutreachDraft {
  projectId: string;
  projectTitle: string;
  sourceRecordId: string;
  to: string;
  contactName: string;
  subject: string;
  body: string;
  status: "draft" | "sent";
  contacts: OutreachContact[];
  canopyFit: CanopyFit;
  updatedAt?: string;
  sentAt?: string;
  sentBy?: string;
  senderMode: "marketing" | "employee";
  senderEmail: string;
  replyOwnerEmail: string;
  replyOwnerName: string;
  deliveryProvider?: "instantly:test-email" | "gmail";
  gmailMessageId?: string;
  gmailThreadId?: string;
  emailHistory?: GmailThreadSummary[];
  historySyncedAt?: string;
  generation?: {
    provider: "template" | "anthropic";
    model?: string;
  };
}

export interface OutreachConfig {
  defaultSenderMode: "marketing";
  marketing: { configured: boolean; email: string; name: string };
  employee: { email: string; name: string };
  salesReplyOwners: Array<{ email: string; name: string }>;
  defaultReplyOwnerEmail: string;
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
  canopyFit?: CanopyFit;
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
  federalProcurement?: string;
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
    federalConnectedStates?: number;
    federalExpectedStates?: number;
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
    sourceProjectCount?: number;
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
