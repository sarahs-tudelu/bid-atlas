import {
  calendarDateInTimeZone,
  dateOnlyBidDeadline,
  DEFAULT_BID_DATE_TIME_ZONE,
} from "./deadline-time";
import type { ProjectDocument, ProjectRecord } from "./types";

export type BidReadinessReason =
  | "not-bidding"
  | "not-official"
  | "missing-official-source"
  | "missing-bid-facts"
  | "missing-location"
  | "missing-deadline"
  | "deadline-passed"
  | "missing-bid-documents";

export interface BidReadinessAssessment {
  ready: boolean;
  reasons: BidReadinessReason[];
  documents: ProjectDocument[];
}

const BID_DOCUMENT_KINDS = new Set<ProjectDocument["kind"]>([
  "plans",
  "specifications",
  "addendum",
]);

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function actionableBidDocuments(
  project: ProjectRecord,
): ProjectDocument[] {
  return project.documents.filter(
    (document) =>
      BID_DOCUMENT_KINDS.has(document.kind) &&
      document.indexStatus !== "not-public" &&
      isHttpsUrl(document.url),
  );
}

function hasPublishedBidFacts(project: ProjectRecord): boolean {
  return Boolean(
    project.title.trim() &&
      project.summary.trim() &&
      project.agency.trim() &&
      project.sourceRecordId.trim() &&
      project.status.trim(),
  );
}

function hasPublishedLocation(project: ProjectRecord): boolean {
  return Boolean(
    project.address?.trim() ||
      project.city?.trim() ||
      project.county?.trim() ||
      project.state?.trim(),
  );
}

export function assessBidReadiness(
  project: ProjectRecord,
  now = new Date(),
): BidReadinessAssessment {
  const reasons: BidReadinessReason[] = [];
  const documents = actionableBidDocuments(project);
  if (project.stage !== "bidding") reasons.push("not-bidding");
  if (project.confidence !== "official") reasons.push("not-official");
  if (!isHttpsUrl(project.sourceUrl)) reasons.push("missing-official-source");
  if (!hasPublishedBidFacts(project)) reasons.push("missing-bid-facts");
  if (!hasPublishedLocation(project)) reasons.push("missing-location");

  const deadline = new Date(project.bidDate ?? "");
  if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= 86_400_000) {
    reasons.push("missing-deadline");
  } else {
    const dateOnlyDay = dateOnlyBidDeadline(project.bidDate);
    const hasPublishedTime = !dateOnlyDay;
    const timeZone = project.bidDateTimeZone ?? DEFAULT_BID_DATE_TIME_ZONE;
    const dueDay = dateOnlyDay ?? calendarDateInTimeZone(deadline, timeZone);
    const currentDay = calendarDateInTimeZone(now, timeZone);
    if (
      (hasPublishedTime && deadline.getTime() < now.getTime()) ||
      (!hasPublishedTime && dueDay < currentDay)
    ) reasons.push("deadline-passed");
  }
  if (documents.length === 0) reasons.push("missing-bid-documents");

  return {
    ready: reasons.length === 0,
    reasons,
    documents,
  };
}

export function isBidReadyProject(
  project: ProjectRecord,
  now = new Date(),
): boolean {
  return assessBidReadiness(project, now).ready;
}
