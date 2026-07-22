interface ConnectedProjectOrderRecord {
  id: string;
  stage: string;
  bidDate?: string;
  updatedAt: string;
}

const STAGE_ORDER: Record<string, number> = {
  bidding: 0,
  "bid-opened": 1,
  design: 2,
  planning: 3,
  permitting: 4,
  awarded: 5,
  construction: 6,
  completed: 7,
  cancelled: 8,
  unclassified: 9,
};

export function compareConnectedProjects(
  left: ConnectedProjectOrderRecord,
  right: ConnectedProjectOrderRecord,
): number {
  const stageDifference = (STAGE_ORDER[left.stage] ?? 10) - (STAGE_ORDER[right.stage] ?? 10);
  if (stageDifference !== 0) return stageDifference;
  if (left.stage === "bidding") {
    const leftDeadline = Date.parse(left.bidDate ?? "");
    const rightDeadline = Date.parse(right.bidDate ?? "");
    const leftHasDeadline = Number.isFinite(leftDeadline);
    const rightHasDeadline = Number.isFinite(rightDeadline);
    if (leftHasDeadline !== rightHasDeadline) return leftHasDeadline ? -1 : 1;
    if (leftHasDeadline && rightHasDeadline && leftDeadline !== rightDeadline) {
      return leftDeadline - rightDeadline;
    }
  }
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

export function connectedProjectMergeWindow(
  globalOffset: number,
  pageSize: number,
  eligibleLiveProjectCount: number,
): { offset: number; limit: number } {
  // A global page can move earlier by at most the number of matching live
  // candidates. Keep that bounded live-sized prefix in the persisted query;
  // never materialize the full persisted result set.
  const offset = Math.max(0, globalOffset - eligibleLiveProjectCount);
  return { offset, limit: globalOffset + pageSize - offset };
}

export function mergeConnectedProjectPage<T extends ConnectedProjectOrderRecord>(
  persistedWindow: readonly T[],
  liveProjects: readonly T[],
  globalOffset: number,
  persistedWindowOffset: number,
  pageSize: number,
  mergeDuplicate: (existing: T, incoming: T) => T = (existing, incoming) => ({
    ...existing,
    ...incoming,
  }),
): T[] {
  const byId = new Map<string, T>();
  for (const project of [...persistedWindow, ...liveProjects]) {
    const existing = byId.get(project.id);
    byId.set(project.id, existing ? mergeDuplicate(existing, project) : project);
  }
  const localOffset = Math.max(0, globalOffset - persistedWindowOffset);
  return Array.from(byId.values())
    .sort(compareConnectedProjects)
    .slice(localOffset, localOffset + pageSize);
}
