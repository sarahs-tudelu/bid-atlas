import { queryConnectedProjects } from "../../lib/connected-project-search";
import { getProjectFeed } from "../../lib/connectors";
import { resolveIntegrationCredential } from "../../lib/integration-credentials";
import { getDocumentActor } from "../../lib/project-documents/http";
import { normalizeStateCode } from "../../lib/national-coverage";
import { isArchivedProjectStage } from "../../lib/project-lifecycle";
import { parseKeywordInput } from "../../lib/search";
import type {
  BidDueFilter,
  FreshnessFilter,
  ProjectSearchOptions,
  ProjectReadinessFilter,
  ProjectStage,
  SearchMatch,
} from "../../lib/types";

export const dynamic = "force-dynamic";

const VALID_MATCHES = new Set<SearchMatch>(["all", "any", "phrase"]);
const VALID_DUE_FILTERS = new Set<BidDueFilter>(["all", "today", "7-days", "14-days"]);
const VALID_READINESS = new Set<ProjectReadinessFilter>(["bid-ready", "all"]);
const VALID_PAGE_SIZES = new Set([10, 25, 50]);
const VALID_STAGES = new Set<ProjectStage>([
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
const VALID_FRESHNESS = new Set<FreshnessFilter>([
  "all",
  "actionable",
  "new",
  "current",
  "stale",
  "closed-or-inactive",
  "closed",
  "inactive",
  "unclassified",
]);

function positiveInteger(value: string | null, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requestedPageSize(value: string | null): number {
  const parsed = positiveInteger(value, 10);
  return VALID_PAGE_SIZES.has(parsed) ? parsed : 10;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const keywords = parseKeywordInput(url.searchParams.get("keywords") ?? "");
  const requestedMatch = url.searchParams.get("match") as SearchMatch | null;
  const match = requestedMatch && VALID_MATCHES.has(requestedMatch) ? requestedMatch : "all";
  const requestedStage = url.searchParams.get("stage") as ProjectStage | null;
  const stage = requestedStage && VALID_STAGES.has(requestedStage) ? requestedStage : "all";
  const requestedFreshness = url.searchParams.get("freshness") as FreshnessFilter | null;
  const freshness =
    requestedFreshness && VALID_FRESHNESS.has(requestedFreshness)
      ? requestedFreshness
      : "all";
  const requestedDue = url.searchParams.get("due") as BidDueFilter | null;
  const due = requestedDue && VALID_DUE_FILTERS.has(requestedDue) ? requestedDue : "all";
  const requestedReadiness = url.searchParams.get("readiness") as ProjectReadinessFilter | null;
  const readiness =
    requestedReadiness && VALID_READINESS.has(requestedReadiness)
      ? requestedReadiness : "all";
  const location = (url.searchParams.get("location") ?? "").trim().slice(0, 160);
  const rawState = (url.searchParams.get("state") ?? "all").trim();
  const state = rawState.toLowerCase() === "all" ? "all" : normalizeStateCode(rawState) ?? "all";
  const includeArchived =
    url.searchParams.get("includeArchived") === "1" || isArchivedProjectStage(stage);
  const pageSize = requestedPageSize(url.searchParams.get("limit"));
  const parsedPage = positiveInteger(url.searchParams.get("page"), 1);
  const page = parsedPage <= Math.floor(Number.MAX_SAFE_INTEGER / pageSize) ? parsedPage : 1;
  const actor = await getDocumentActor(request);
  const samCredential = await resolveIntegrationCredential(
    actor?.kind === "workspace-user" ? actor.id : null,
    "sam",
  );
  const feed = await getProjectFeed({ samApiKey: samCredential?.apiKey });
  const options: ProjectSearchOptions = {
    keywords,
    location,
    match,
    stage,
    state,
    freshness,
    due,
    includeArchived,
    readiness,
  };
  const result = await queryConnectedProjects(feed, options, page, pageSize);

  return Response.json(
    {
      projects: result.projects,
      meta: result.meta,
      sourceSearches: result.sourceSearches,
      coverage: feed.coverage,
      warnings: result.warnings,
    },
    {
      headers: {
        "Cache-Control":
          samCredential?.scope === "personal"
            ? "private, no-store"
            : "public, max-age=0, s-maxage=300",
      },
    },
  );
}
