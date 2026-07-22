import { useSearchParams } from "react-router-dom";

import { queryString } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { FilterChips } from "../components/FilterChips";
import { Pagination } from "../components/Pagination";
import { ProjectCard } from "../components/ProjectCard";
import { ProjectGridSkeleton } from "../components/Skeleton";
import { SourceWarnings } from "../components/SourceWarnings";
import { EMPTY_SEARCH, ProjectSearch, type ProjectSearchValues } from "../components/ProjectSearch";
import { useApi } from "../hooks/useApi";
import type { SearchPreset, SearchResponse } from "../types";

interface ProjectResultsPageProps {
  mode: "bids" | "leads";
}

interface PresetResponse {
  presets: SearchPreset[];
}

function valuesFromParams(params: URLSearchParams): ProjectSearchValues {
  return {
    keywords: params.get("keywords") ?? "",
    location: params.get("location") ?? "",
    state: params.get("state") ?? "all",
    stage: params.get("stage") ?? "all",
    due: params.get("due") ?? "all",
    profile: params.get("profile") ?? "all",
  };
}

export function ProjectResultsPage({ mode }: ProjectResultsPageProps) {
  const [params, setParams] = useSearchParams();
  const activeValues = valuesFromParams(params);
  const activeSignature = JSON.stringify(activeValues);
  const page = Math.max(Number(params.get("page") ?? 1), 1);
  const pageSize = Number(params.get("limit") ?? 10);
  const { data: presetData } = useApi<PresetResponse>("/api/search-presets");

  const path = `/api/search${queryString({
    ...activeValues,
    readiness: mode === "bids" ? "bid-ready" : "all",
    freshness: mode === "bids" ? "actionable" : "all",
    includeArchived: false,
    page,
    limit: pageSize,
  })}`;
  const { data, error, loading, refreshing, refetch } = useApi<SearchResponse>(path);

  const replaceSearch = (values: ProjectSearchValues) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value && value !== "all") next.set(key, value);
    }
    if (pageSize !== 10) next.set("limit", String(pageSize));
    setParams(next);
  };

  const resetSearch = () => replaceSearch(EMPTY_SEARCH);

  const removeFilter = (field: keyof ProjectSearchValues) => {
    const resetValue = field === "keywords" || field === "location" ? "" : "all";
    replaceSearch({ ...activeValues, [field]: resetValue });
  };

  const matched = data?.meta.matchedProjects ?? data?.meta.total ?? data?.projects.length ?? 0;
  const presetLabels = Object.fromEntries((presetData?.presets ?? []).map((preset) => [preset.id, preset.label]));

  const changePage = (nextPage: number) => {
    const next = new URLSearchParams(params);
    if (nextPage === 1) next.delete("page");
    else next.set("page", String(nextPage));
    setParams(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <main className="route-page page-width">
      <header className="route-heading">
        <p className="eyebrow">{mode === "bids" ? "Current solicitations" : "Connected project pipeline"}</p>
        <h1>{mode === "bids" ? "Open construction bids" : "Project leads"}</h1>
        <p>
          {mode === "bids"
            ? "Only bidding-stage records with a current deadline and an official plans or specifications route."
            : "Explore planning, design, permitting, award, and construction records without weakening the open-bid gate."}
        </p>
      </header>

      {presetData?.presets.length ? (
        <section className="preset-strip" aria-label="Canopy search profiles">
          <div>
            <strong>Canopy opportunity profiles</strong>
            <span>Reusable searches tuned for Tudelu's architectural canopy work.</span>
          </div>
          <div className="preset-list">
            {presetData.presets.map((preset) => (
              <button
                className={activeValues.profile === preset.id ? "preset-button active" : "preset-button"}
                key={preset.id}
                type="button"
                title={preset.description}
                onClick={() => replaceSearch({ ...EMPTY_SEARCH, profile: preset.id })}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <ProjectSearch
        key={activeSignature}
        initialValues={activeValues}
        showStage={mode === "leads"}
        onSubmit={replaceSearch}
        onReset={resetSearch}
      />
      <FilterChips
        values={activeValues}
        hidden={[mode === "bids" ? "stage" : "due"]}
        presetLabels={presetLabels}
        onRemove={removeFilter}
      />

      <AsyncState loading={loading} error={error} onRetry={refetch} skeleton={<ProjectGridSkeleton count={4} />}>
        {data && (
          <section className="results-section">
            <SourceWarnings warnings={data.meta.warnings} />
            <div className="results-toolbar">
              <p aria-live="polite">
                <strong>{matched.toLocaleString()}</strong> matching record{matched === 1 ? "" : "s"}
                {refreshing && <span className="results-refreshing"> · updating…</span>}
              </p>
              <label>
                Results per page
                <select
                  value={data.meta.pageSize}
                  onChange={(event) => {
                    const next = new URLSearchParams(params);
                    next.set("limit", event.target.value);
                    next.delete("page");
                    setParams(next);
                  }}
                >
                  <option value="10">10</option>
                  <option value="25">25</option>
                  <option value="50">50</option>
                </select>
              </label>
            </div>
            {data.projects.length ? (
              <div className={refreshing ? "project-grid is-refreshing" : "project-grid"}>
                {data.projects.map((project) => <ProjectCard key={project.id} project={project} />)}
              </div>
            ) : (
              <div className="empty-panel">
                <h2>No records match these filters</h2>
                <p>
                  Try a broader location, another stage, or fewer keywords. Every filter you clear widens the connected
                  set.
                </p>
                <button className="button button-primary" type="button" onClick={resetSearch}>
                  Clear all filters
                </button>
              </div>
            )}
            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              pageSize={data.meta.pageSize}
              totalItems={matched}
              onPageChange={changePage}
            />
          </section>
        )}
      </AsyncState>
    </main>
  );
}
