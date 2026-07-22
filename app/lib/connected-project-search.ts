import { searchPersistedProjects } from "../../db/search-repository";
import {
  compareConnectedProjects,
  connectedProjectMergeWindow,
  mergeConnectedProjectPage,
} from "./connected-project-pagination";
import { fetchSeattlePermitSearchUniverse } from "./connectors";
import { mergeProjectRecords } from "./project-records";
import { normalizeStateCode } from "./national-coverage";
import { searchProjects } from "./search";
import { fetchNycCityRecordCurrentConstructionSolicitations } from "./socrata-city-connectors";
import type {
  ProjectFeed,
  ProjectRecord,
  ProjectSearchOptions,
  SearchResultMeta,
} from "./types";

export type ConnectedSearchMeta = SearchResultMeta & {
  searchMode: "persisted-and-live" | "live-fallback";
  persistedIndexAvailable: boolean;
  persistedMatchedProjects: number;
  persistedReturnedProjects: number;
  liveFallbackMatchedProjects: number;
  liveFallbackMetadataProjects: number;
  sourceQueryableRecords?: number;
};

export interface ConnectedProjectSearchResult {
  projects: ProjectRecord[];
  meta: ConnectedSearchMeta;
  sourceSearches: Array<{
    sourceId: string;
    sourceReportedMatches?: number;
    searchedSourceRecords?: number;
  }>;
  warnings: string[];
}

function dedupeProjects(projects: readonly ProjectRecord[]): ProjectRecord[] {
  const byId = new Map<string, ProjectRecord>();
  for (const project of projects) {
    const existing = byId.get(project.id);
    byId.set(project.id, existing ? mergeProjectRecords(existing, project) : project);
  }
  return Array.from(byId.values()).sort(compareConnectedProjects);
}

const DEDICATED_REMOTE_SEARCH_SOURCE_IDS = new Set([
  "seattle-building-permits",
  "nyc-city-record-construction-procurement",
]);

function sourceJurisdictionState(jurisdiction: string): string | undefined {
  for (const part of jurisdiction.split(",").map((value) => value.trim()).reverse()) {
    const state = normalizeStateCode(part);
    if (state) return state;
  }
  return undefined;
}

export async function queryConnectedProjects(
  feed: ProjectFeed,
  options: ProjectSearchOptions,
  page: number,
  pageSize: number,
  allowPageClamp = true,
): Promise<ConnectedProjectSearchResult> {
  const offset = (page - 1) * pageSize;
  const liveEligibilityOptions: ProjectSearchOptions = { ...options, keywords: [] };
  const warnings = [...feed.warnings];
  let sourceReportedMatchTotal = 0;
  let sourceQueryableRecordTotal = 0;
  let sourceResultLimited = false;
  const remoteSourceProjects: ProjectRecord[] = [];
  const sourceSearches: ConnectedProjectSearchResult["sourceSearches"] = [];

  const hasRemoteSearchFilters =
    options.keywords.length > 0 ||
    Boolean(options.location?.trim()) ||
    Boolean(options.stage && options.stage !== "all") ||
    Boolean(options.state && options.state !== "all") ||
    Boolean(options.freshness && options.freshness !== "all") ||
    Boolean(options.due && options.due !== "all");
  // Fetch deterministic, unfiltered remote windows for each requested state.
  // Search facets are applied below after live/persisted deduplication, so a
  // facet cannot silently change the source universe or its paging boundary.
  const wantsSeattle = options.state === "all" || options.state === "WA";
  const wantsNycCityRecord = options.state === "all" || options.state === "NY";
  const [seattleOutcome, nycOutcome] = await Promise.allSettled([
    wantsSeattle ? fetchSeattlePermitSearchUniverse(1_000) : Promise.resolve(null),
    wantsNycCityRecord
      ? fetchNycCityRecordCurrentConstructionSolicitations()
      : Promise.resolve(null),
  ]);

  const boundedLiveSources = feed.sources.flatMap((source) => {
    const jurisdictionState = sourceJurisdictionState(source.jurisdiction);
    if (
      source.status !== "live" ||
      source.level === "registry" ||
      DEDICATED_REMOTE_SEARCH_SOURCE_IDS.has(source.id) ||
      (options.state &&
        options.state !== "all" &&
        jurisdictionState !== undefined &&
        jurisdictionState !== options.state.toUpperCase())
    ) {
      return [];
    }
    const projectsInLiveFeed = feed.projects.filter(
      (project) => project.sourceId === source.id,
    ).length;
    const rawLoadedCount = source.loadedCount ?? projectsInLiveFeed;
    const loadedCount = Number.isFinite(rawLoadedCount)
      ? Math.max(0, Math.trunc(rawLoadedCount))
      : projectsInLiveFeed;
    if (source.recordCount <= loadedCount) return [];
    sourceResultLimited = true;
    sourceReportedMatchTotal += source.recordCount;
    sourceQueryableRecordTotal += loadedCount;
    sourceSearches.push({
      sourceId: source.id,
      sourceReportedMatches: hasRemoteSearchFilters ? undefined : source.recordCount,
      searchedSourceRecords: loadedCount,
    });
    return [{ name: source.name, reported: source.recordCount, loaded: loadedCount }];
  });
  if (boundedLiveSources.length > 0) {
    const examples = boundedLiveSources
      .slice(0, 4)
      .map((source) => `${source.name} (${source.loaded.toLocaleString("en-US")} loaded of ${source.reported.toLocaleString("en-US")} reported)`)
      .join("; ");
    warnings.push(
      `Live search is using partial source windows for ${examples}${boundedLiveSources.length > 4 ? ` and ${boundedLiveSources.length - 4} more` : ""}. Persisted ingestion can supply older loaded rows, but the displayed live Last loaded page is not the end of those public sources.`,
    );
  }

  if (seattleOutcome.status === "fulfilled" && seattleOutcome.value) {
    const sourceSearch = seattleOutcome.value;
    const resultLimited = sourceSearch.sourceReportedMatches > sourceSearch.projects.length;
    sourceResultLimited ||= resultLimited;
    sourceReportedMatchTotal += sourceSearch.sourceReportedMatches;
    sourceQueryableRecordTotal += sourceSearch.projects.length;
    remoteSourceProjects.push(...sourceSearch.projects);
    sourceSearches.push({
      sourceId: sourceSearch.sourceId,
      sourceReportedMatches: hasRemoteSearchFilters
        ? undefined
        : sourceSearch.sourceReportedMatches,
      searchedSourceRecords: sourceSearch.projects.length,
    });
    if (resultLimited) {
      warnings.push(
        "Seattle search facets are applied locally to the same bounded 1,000-record remote universe. Older source rows remain available through persisted ingestion and are not represented as a complete live result set.",
      );
    }
  } else if (seattleOutcome.status === "rejected") {
    warnings.push(
      `Seattle remote search universe: ${seattleOutcome.reason instanceof Error ? seattleOutcome.reason.message : "Unknown search error"}`,
    );
  }

  if (nycOutcome.status === "fulfilled" && nycOutcome.value) {
    const sourceSearch = nycOutcome.value;
    sourceResultLimited ||= sourceSearch.resultLimitReached;
    sourceReportedMatchTotal += sourceSearch.sourceReportedMatches;
    sourceQueryableRecordTotal += sourceSearch.returnedProjects;
    remoteSourceProjects.push(...sourceSearch.projects);
    sourceSearches.push({
      sourceId: sourceSearch.sourceId,
      sourceReportedMatches: hasRemoteSearchFilters
        ? undefined
        : sourceSearch.sourceReportedMatches,
      searchedSourceRecords: sourceSearch.returnedProjects,
    });
    if (sourceSearch.resultLimitReached) {
      warnings.push(
        "NYC City Record search facets are applied locally to the same bounded 500-record current procurement-solicitation universe. Additional current solicitations remain at the official source and are not represented as a complete live result set.",
      );
    }
  } else if (nycOutcome.status === "rejected") {
    warnings.push(
      `NYC City Record current solicitation universe: ${nycOutcome.reason instanceof Error ? nycOutcome.reason.message : "Unknown search error"}`,
    );
  }

  const sourceReportedMatches =
    sourceSearches.length > 0 && !hasRemoteSearchFilters
      ? sourceReportedMatchTotal
      : undefined;
  const sourceQueryableRecords =
    sourceSearches.length > 0 ? sourceQueryableRecordTotal : undefined;

  // Every observed live ID overrides its persisted copy before any filter or
  // count is evaluated. This prevents a stale stored stage, location, status,
  // or freshness value from leaking into a different search facet.
  const observedLiveProjects = dedupeProjects([...feed.projects, ...remoteSourceProjects]);
  const eligibleLiveProjects = searchProjects(observedLiveProjects, liveEligibilityOptions);
  const liveMetadataMatches = searchProjects(observedLiveProjects, options);
  const persistedWindow = connectedProjectMergeWindow(
    offset,
    pageSize,
    eligibleLiveProjects.length,
  );
  const persistedSearch = await searchPersistedProjects(
    options,
    eligibleLiveProjects.map((project) => project.id),
    {
      offset: persistedWindow.offset,
      limit: persistedWindow.limit,
      excludeProjectIds: observedLiveProjects.map((project) => project.id),
      allowLiveMergeWindow: true,
    },
  );
  if (!persistedSearch.available && persistedSearch.reason === "query-failed") {
    warnings.push(`Persisted search unavailable; using live fallback: ${persistedSearch.error}`);
  }
  if (persistedSearch.available) {
    warnings.push(
      "Live records override stored copies when the current connector window observes the same source ID. Records outside that window reflect the last successful ingestion and can lag a later source transition; verify the official record before bidding.",
    );
  }

  const persistedProjects = persistedSearch.available ? persistedSearch.projects : [];
  const documentMatchedLiveIds = new Set(
    persistedSearch.available ? persistedSearch.documentMatchedCandidateIds : [],
  );
  const documentIndexedLiveIds = new Set(
    persistedSearch.available ? persistedSearch.documentIndexedCandidateIds : [],
  );
  const metadataMatchIds = new Set(liveMetadataMatches.map((project) => project.id));
  const liveProjects = dedupeProjects(
    eligibleLiveProjects.flatMap((project) => {
      if (!metadataMatchIds.has(project.id) && !documentMatchedLiveIds.has(project.id)) return [];
      return [
        documentIndexedLiveIds.has(project.id)
          ? { ...project, documentTextIndexed: true }
          : project,
      ];
    }),
  );
  const fallbackProjects = liveProjects;
  const persistedMatchedProjects = persistedSearch.available
    ? persistedSearch.matchedProjectCount
    : 0;
  const projects = persistedSearch.available
    ? mergeConnectedProjectPage(
        persistedProjects,
        fallbackProjects,
        offset,
        persistedSearch.offset,
        pageSize,
        mergeProjectRecords,
      )
    : fallbackProjects.slice(offset, offset + pageSize);
  const liveProjectIds = new Set(fallbackProjects.map((project) => project.id));
  const persistedReturnedProjects = projects.filter(
    (project) => !liveProjectIds.has(project.id),
  ).length;

  const liveFallbackMatchedProjects = fallbackProjects.length;
  const matchedProjects = persistedMatchedProjects + liveFallbackMatchedProjects;
  const totalPages = Math.max(1, Math.ceil(matchedProjects / pageSize));
  if (allowPageClamp && page > totalPages) {
    return queryConnectedProjects(feed, options, totalPages, pageSize, false);
  }
  const searchedProjects = persistedSearch.available
    ? persistedSearch.eligibleMetadataProjects + eligibleLiveProjects.length
    : eligibleLiveProjects.length;
  const liveDocumentTextIndexedProjects = eligibleLiveProjects.filter(
    (project) => project.documentTextIndexed || documentIndexedLiveIds.has(project.id),
  ).length;
  const documentTextIndexedProjects = persistedSearch.available
    ? persistedSearch.eligibleDocumentTextProjects +
      liveDocumentTextIndexedProjects
    : eligibleLiveProjects.filter((project) => project.documentTextIndexed).length;

  return {
    projects,
    meta: {
      terms: options.keywords,
      location: options.location || undefined,
      match: options.match,
      freshness: options.freshness,
      due: options.due,
      readiness: options.readiness,
      leadFilter: options.leadFilter,
      includeArchived: Boolean(options.includeArchived),
      searchedProjects,
      matchedProjects,
      sourceReportedMatches,
      resultLimitReached: sourceResultLimited,
      metadataIndexedProjects: searchedProjects,
      documentTextIndexedProjects,
      nationallyComplete: false,
      searchMode: persistedSearch.available ? "persisted-and-live" : "live-fallback",
      persistedIndexAvailable: persistedSearch.available,
      persistedMatchedProjects,
      persistedReturnedProjects,
      liveFallbackMatchedProjects,
      liveFallbackMetadataProjects: eligibleLiveProjects.length,
      sourceQueryableRecords,
      page,
      pageSize,
      totalPages,
      returnedProjects: projects.length,
      notice:
        `${options.includeArchived ? "Results include active, completed, and cancelled queryable public-source records." : "Results cover active and queryable public-source records only."} The search combines the persisted index with live source fallbacks without claiming national completeness. Awarded and construction-stage projects remain active; old dates and passed bid deadlines do not archive a project. Public plan/specification text is searched only after a document is lawfully retrieved and successfully extracted; metadata-only documents can still contain unsearched product details.`,
    },
    sourceSearches,
    warnings,
  };
}
