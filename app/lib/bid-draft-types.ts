import type { ProjectParticipant, ProjectRecord } from "./types";

export const BID_DRAFT_READINESS_KEYS = [
  "documents",
  "scope",
  "pricing",
  "terms",
  "authority",
] as const;

export const BID_DRAFT_PIPELINE_STAGES = [
  "research",
  "qualify",
  "estimate",
  "package",
  "approval",
  "delivered",
] as const;

export type BidDraftReadinessKey = (typeof BID_DRAFT_READINESS_KEYS)[number];
export type BidDraftPipelineStage = (typeof BID_DRAFT_PIPELINE_STAGES)[number];

export interface PersistedQuoteLineItem {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
}

export interface PersistedBidDraft {
  quoteNumber: string;
  packageName: string;
  scope: string;
  exclusions: string;
  leadTime: string;
  validity: string;
  lineItems: PersistedQuoteLineItem[];
  messageSubject: string;
  messageBody: string;
  readiness: Record<BidDraftReadinessKey, boolean>;
}

export interface PersistedBidRecipient {
  clientId: string;
  participantName: string;
  role: ProjectParticipant["role"];
  channel: string;
  verificationSourceUrl?: string;
  verified: boolean;
}

export interface BidDraftProjectSnapshot {
  id: string;
  canonicalKey: string;
  title: string;
  summary: string;
  stage: ProjectRecord["stage"];
  status: string;
  agency: string;
  ownerName?: string;
  architectName?: string;
  engineerName?: string;
  address?: string;
  city?: string;
  county?: string;
  state?: string;
  postalCode?: string;
  estimatedValue?: number;
  postedAt?: string;
  bidDate?: string;
  awardDate?: string;
  sourceId: string;
  sourceUrl: string;
}

export interface SaveBidDraftRequest {
  project: BidDraftProjectSnapshot;
  draft: PersistedBidDraft;
  pipelineStage: BidDraftPipelineStage;
  recipients: PersistedBidRecipient[];
}

export interface SavedBidDraftRecord {
  projectId: string;
  packageId: string;
  opportunityId: string;
  savedAt: string;
  savedBy: string;
  pipelineStage: BidDraftPipelineStage;
  draft: PersistedBidDraft;
  recipients: PersistedBidRecipient[];
  notice: string;
}
