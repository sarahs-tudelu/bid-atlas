export const PROJECT_RESEARCH_STATUSES = [
  "queued",
  "running",
  "complete",
  "partial",
  "failed",
] as const;

export type ProjectResearchJobStatus = (typeof PROJECT_RESEARCH_STATUSES)[number];
export type ProjectResearchStatus = "not-researched" | ProjectResearchJobStatus;
export type ProjectResearchVisibility = "workspace" | "public";

export type ResearchProvenance = {
  sourceUrl: string;
  sourceId?: string;
  sourceLabel?: string;
  retrievedAt: string;
  method: "official-page" | "official-api" | "official-document-link";
  strategy: "generic-official-page" | "caltrans-contract-detail" | "configured-exact-record";
};

type ResearchFindingBase = {
  id: string;
  sourceUrl: string;
  sourceId?: string;
  sourceLabel?: string;
  evidence: string;
  observedAt: string;
  confidence: number;
  provenance: ResearchProvenance;
};

export type ResearchContactFinding = ResearchFindingBase & {
  kind: "contact";
  role?: string;
  displayName?: string;
  organization?: string;
  email?: string;
  phone?: string;
};

export type ResearchDocumentFinding = ResearchFindingBase & {
  kind: "document";
  name: string;
  documentType: "plans" | "specifications" | "addenda" | "drawings" | "cad" | "bid-form" | "other";
  url: string;
  access: "public-link";
  textExtractionStatus: "awaiting-extractor";
};

export type ResearchScopeFinding = ResearchFindingBase & {
  kind: "scope";
  factType: "work-description" | "location" | "license" | "quantity-item" | "scope-clause";
  value: string;
};

export type ResearchLifecycleFinding = ResearchFindingBase & {
  kind: "lifecycle";
  stage?: string;
  officialStatus: string;
  terminal: boolean;
  terminalBasis: "official-status-field" | "none";
};

export type ResearchGap = {
  id: string;
  gapType: "contact" | "documents" | "scope" | "lifecycle" | "source-unavailable";
  status: "open";
  message: string;
  nextAction?: string;
};

export type PlanExtractionHandoff = {
  id: string;
  findingId?: string;
  handoffType: "plan-text-extraction";
  status: "awaiting-extractor" | "processing" | "complete" | "failed";
  sourceUrl: string;
  detail: string;
  requestedAt: string;
  updatedAt: string;
};

export type ResearchSourceAttempt = {
  id: string;
  sourceId?: string;
  sourceUrl: string;
  finalUrl?: string;
  status: "complete" | "failed" | "skipped";
  httpStatus?: number;
  contentType?: string;
  bytesRead: number;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  completedAt: string;
};

/** Stable response consumed by Bid Desk and project detail pages. */
export type ProjectResearchRecord = {
  projectId: string;
  status: ProjectResearchStatus;
  visibility: ProjectResearchVisibility;
  requestedAt?: string;
  startedAt?: string;
  completedAt?: string;
  freshUntil?: string;
  nextRetryAt?: string;
  attempt: number;
  maxAttempts: number;
  cached: boolean;
  contacts: ResearchContactFinding[];
  documents: ResearchDocumentFinding[];
  scopeFacts: ResearchScopeFinding[];
  lifecycle: ResearchLifecycleFinding[];
  gaps: ResearchGap[];
  extractionHandoffs: PlanExtractionHandoff[];
  sources: ResearchSourceAttempt[];
  notice: string;
};

export type ResearchFinding =
  | ResearchContactFinding
  | ResearchDocumentFinding
  | ResearchScopeFinding
  | ResearchLifecycleFinding;

export type OfficialResearchSource = {
  sourceId?: string;
  sourceLabel: string;
  url: string;
  strategy: "generic-official-page" | "caltrans-contract-detail" | "configured-exact-record";
  allowedHosts: string[];
};

export type ResearchRunOutput = {
  findings: ResearchFinding[];
  gaps: Omit<ResearchGap, "id">[];
  handoffs: Omit<PlanExtractionHandoff, "id" | "requestedAt" | "updatedAt">[];
  attempts: Omit<ResearchSourceAttempt, "id">[];
};
