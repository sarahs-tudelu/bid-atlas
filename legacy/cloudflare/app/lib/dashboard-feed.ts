import { getPersistedInventorySnapshot } from "../../db/search-repository";
import { getProjectFeed } from "./connectors";
import { normalizeStateCode } from "./national-coverage";
import type {
  ProjectFeed,
  ProjectInventorySummary,
  ProjectRecord,
  ProjectStage,
} from "./types";

const PROJECT_STAGES: ProjectStage[] = [
  "planning",
  "design",
  "permitting",
  "bidding",
  "bid-opened",
  "awarded",
  "construction",
  "completed",
  "cancelled",
  "unclassified",
];

function emptyStageCounts(): Record<ProjectStage, number> {
  return Object.fromEntries(PROJECT_STAGES.map((stage) => [stage, 0])) as Record<
    ProjectStage,
    number
  >;
}

function normalizedOrganizationName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function contractorOrganizationKeys(projects: readonly ProjectRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const project of projects) {
    for (const participant of project.participants) {
      if (participant.role === "contractor" || participant.role === "bidder") {
        const key = normalizedOrganizationName(participant.name);
        if (key) keys.add(key);
      }
    }
  }
  return keys;
}

function liveInventory(projects: readonly ProjectRecord[], generatedAt: string): ProjectInventorySummary {
  const stageCounts = emptyStageCounts();
  const stateCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  let documentTextIndexedProjects = 0;
  const contractorOrganizations = contractorOrganizationKeys(projects);
  for (const project of projects) {
    stageCounts[project.stage] += 1;
    const state = normalizeStateCode(project.state);
    if (state) stateCounts[state] = (stateCounts[state] ?? 0) + 1;
    sourceCounts[project.sourceId] = (sourceCounts[project.sourceId] ?? 0) + 1;
    if (project.documentTextIndexed) documentTextIndexedProjects += 1;
  }
  return {
    mode: "live-fallback",
    totalProjects: projects.length,
    stageCounts,
    stateCounts,
    sourceCounts,
    documentTextIndexedProjects,
    contractorOrganizations: contractorOrganizations.size,
    refreshedAt: generatedAt,
  };
}

function addLiveProjects(
  inventory: ProjectInventorySummary,
  liveOnlyProjects: readonly ProjectRecord[],
  allLiveProjects: readonly ProjectRecord[],
  existingCandidates: readonly {
    id: string;
    stage: ProjectStage;
    state?: string;
  }[],
  existingContractorKeys: ReadonlySet<string>,
): ProjectInventorySummary {
  const stageCounts = { ...inventory.stageCounts };
  const stateCounts = { ...inventory.stateCounts };
  const sourceCounts = { ...inventory.sourceCounts };
  let documentTextIndexedProjects = inventory.documentTextIndexedProjects;
  const novelContractorKeys = contractorOrganizationKeys(allLiveProjects);
  for (const key of existingContractorKeys) novelContractorKeys.delete(key);

  // A live connector record is the current view of the same source identity.
  // Replace stale persisted stage/state facets before adding genuinely new IDs.
  const liveById = new Map(allLiveProjects.map((project) => [project.id, project]));
  for (const persistedProject of existingCandidates) {
    const liveProject = liveById.get(persistedProject.id);
    if (!liveProject) continue;
    if (persistedProject.stage !== liveProject.stage) {
      stageCounts[persistedProject.stage] = Math.max(
        0,
        stageCounts[persistedProject.stage] - 1,
      );
      stageCounts[liveProject.stage] += 1;
    }
    const persistedState = normalizeStateCode(persistedProject.state);
    const liveState = normalizeStateCode(liveProject.state);
    if (persistedState !== liveState) {
      if (persistedState) {
        stateCounts[persistedState] = Math.max(0, (stateCounts[persistedState] ?? 0) - 1);
        if (stateCounts[persistedState] === 0) delete stateCounts[persistedState];
      }
      if (liveState) stateCounts[liveState] = (stateCounts[liveState] ?? 0) + 1;
    }
  }

  for (const project of liveOnlyProjects) {
    stageCounts[project.stage] += 1;
    const state = normalizeStateCode(project.state);
    if (state) stateCounts[state] = (stateCounts[state] ?? 0) + 1;
    sourceCounts[project.sourceId] = (sourceCounts[project.sourceId] ?? 0) + 1;
    if (project.documentTextIndexed) documentTextIndexedProjects += 1;
  }
  return {
    ...inventory,
    totalProjects: inventory.totalProjects + liveOnlyProjects.length,
    stageCounts,
    stateCounts,
    sourceCounts,
    documentTextIndexedProjects,
    contractorOrganizations:
      inventory.contractorOrganizations + novelContractorKeys.size,
  };
}

export async function getDashboardFeed(
  options: { samApiKey?: string } = {},
): Promise<ProjectFeed> {
  const feed = await getProjectFeed({ samApiKey: options.samApiKey });
  const liveContractorKeys = contractorOrganizationKeys(feed.projects);
  const persisted = await getPersistedInventorySnapshot(
    feed.projects.map((project) => project.id),
    [...liveContractorKeys],
  );

  if (!persisted.available) {
    return {
      ...feed,
      warnings:
        persisted.reason === "query-failed"
          ? [
              ...feed.warnings,
              `Persisted inventory unavailable; using the live connector window: ${persisted.error}`,
            ]
          : feed.warnings,
      inventory: liveInventory(feed.projects, feed.generatedAt),
    };
  }

  const persistedIds = new Set(persisted.existingCandidateIds);
  const liveOnlyProjects = feed.projects.filter((project) => !persistedIds.has(project.id));
  const inventory = addLiveProjects(
    {
      mode: "persisted-and-live",
      totalProjects: persisted.totalProjects,
      stageCounts: persisted.stageCounts,
      stateCounts: persisted.stateCounts,
      sourceCounts: persisted.sourceCounts,
      documentTextIndexedProjects: persisted.documentTextIndexedProjects,
      contractorOrganizations: persisted.contractorOrganizations,
      refreshedAt: persisted.refreshedAt ?? feed.generatedAt,
    },
    liveOnlyProjects,
    feed.projects,
    persisted.existingCandidates,
    new Set(persisted.existingContractorOrganizationKeys),
  );

  return {
    ...feed,
    inventory,
    sources: feed.sources.map((source) => ({
      ...source,
      loadedCount:
        source.id === "census-government-units"
          ? persisted.jurisdictionRows
          : inventory.sourceCounts[source.id] ?? 0,
    })),
    coverage: {
      ...feed.coverage,
      asOf: inventory.refreshedAt ?? feed.coverage.asOf,
      loadedProjectRecords: inventory.totalProjects,
      documentTextIndexedProjects: inventory.documentTextIndexedProjects,
      states: feed.coverage.states.map((state) => ({
        ...state,
        loadedProjects: inventory.stateCounts[state.code] ?? 0,
      })),
    },
  };
}
