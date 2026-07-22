import { assessBidReadiness, type BidReadinessReason } from "./bid-readiness";
import type { ProjectLeadFilter, ProjectRecord } from "./types";

export type ProjectLeadReason =
  | BidReadinessReason
  | "missing-owner"
  | "missing-contractor";

export function projectLeadReasons(
  project: ProjectRecord,
  now = new Date(),
): ProjectLeadReason[] {
  const reasons: ProjectLeadReason[] = [...assessBidReadiness(project, now).reasons];
  if (!project.participants.some((participant) => participant.role === "owner")) {
    reasons.push("missing-owner");
  }
  if (!project.participants.some((participant) => participant.role === "contractor")) {
    reasons.push("missing-contractor");
  }
  return reasons;
}

export function projectMatchesLeadFilter(
  project: ProjectRecord,
  filter: ProjectLeadFilter | undefined,
  now = new Date(),
): boolean {
  if (!filter || filter === "all") return true;
  const readiness = assessBidReadiness(project, now);
  if (filter === "partial") return !readiness.ready;
  if (filter === "missing-owner") {
    return !project.participants.some((participant) => participant.role === "owner");
  }
  if (filter === "missing-contractor") {
    return !project.participants.some((participant) => participant.role === "contractor");
  }
  if (filter === "missing-documents") {
    return readiness.reasons.includes("missing-bid-documents");
  }
  if (filter === "missing-deadline") {
    return readiness.reasons.includes("missing-deadline");
  }
  return ["planning", "design", "permitting"].includes(project.stage);
}
