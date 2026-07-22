import type { Metadata } from "next";
import { BidQueueClient } from "../BidQueueClient";
import { getChatGPTUser } from "../chatgpt-auth";
import { queryConnectedProjects } from "../lib/connected-project-search";
import { getDashboardFeed } from "../lib/dashboard-feed";
import { resolveIntegrationCredential } from "../lib/integration-credentials";
import { allStateOptions, normalizeStateCode } from "../lib/national-coverage";
import { isArchivedProjectStage } from "../lib/project-lifecycle";
import { parseKeywordInput } from "../lib/search";
import type { BidDueFilter, FreshnessFilter, ProjectStage, SearchMatch } from "../lib/types";

export const metadata: Metadata = {
  title: "Open construction bids — BidAtlas",
  description:
    "Search qualified open construction bids by product, trade, scope, location, and deadline.",
};

export const dynamic = "force-dynamic";

interface ProjectsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const PROJECT_STAGES = new Set<ProjectStage>([
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
]);
const SEARCH_MATCHES = new Set<SearchMatch>(["all", "any", "phrase"]);
const DUE_FILTERS = new Set<BidDueFilter>(["all", "today", "7-days", "14-days"]);
const FRESHNESS_FILTERS = new Set<FreshnessFilter>([
  "all",
  "actionable",
  "new",
  "current",
  "stale",
  "closed-or-inactive",
  "unclassified",
]);
const STATE_CODES = new Set(allStateOptions().map(([code]) => code));

function firstParam(params: Record<string, string | string[] | undefined>, name: string, max: number) {
  const value = params[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim().slice(0, max) ?? "";
}

function positiveInt(value: string, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(parsed)));
}

export default async function ProjectsPage({ searchParams }: ProjectsPageProps) {
  const params = await searchParams;
  const user = await getChatGPTUser();
  const samCredential = await resolveIntegrationCredential(
    user?.email.toLowerCase(),
    "sam",
  );
  const feed = await getDashboardFeed({ samApiKey: samCredential?.apiKey });
  const keywords = firstParam(params, "keywords", 300);
  const location = firstParam(params, "location", 200);
  const rawMatch = firstParam(params, "match", 20) as SearchMatch;
  const rawStage = firstParam(params, "stage", 30) as ProjectStage | "all";
  const rawState = firstParam(params, "state", 40);
  const rawFreshness = firstParam(params, "freshness", 30) as FreshnessFilter;
  const rawDue = firstParam(params, "due", 20) as BidDueFilter;
  const requestedIncludeArchived = firstParam(params, "includeArchived", 8) === "1";
  const match = SEARCH_MATCHES.has(rawMatch) ? rawMatch : "all";
  const stage = rawStage === "all" || PROJECT_STAGES.has(rawStage) ? rawStage : "all";
  const normalizedState = normalizeStateCode(rawState);
  const state = normalizedState && STATE_CODES.has(normalizedState) ? normalizedState : "all";
  const includeArchived =
    requestedIncludeArchived || (stage !== "all" && isArchivedProjectStage(stage));
  const freshness = FRESHNESS_FILTERS.has(rawFreshness)
    ? rawFreshness
    : includeArchived
      ? "all"
      : "actionable";
  const due = DUE_FILTERS.has(rawDue) ? rawDue : "all";
  const page = positiveInt(firstParam(params, "page", 12), 1, 1_000_000);
  const requestedLimit = positiveInt(firstParam(params, "limit", 3), 10, 50);
  const pageSize = [10, 25, 50].includes(requestedLimit) ? requestedLimit : 10;
  const initialSearchPage = await queryConnectedProjects(
    feed,
    {
      keywords: parseKeywordInput(keywords),
      location,
      match,
      stage,
      state,
      freshness,
      due,
      includeArchived,
      readiness: "bid-ready",
    },
    page,
    pageSize,
  );
  return (
    <BidQueueClient
      mode="projects"
      initialSearchPage={initialSearchPage}
      initialSearchState={{ keywords, location, due }}
    />
  );
}
