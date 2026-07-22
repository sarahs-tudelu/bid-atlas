import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { queryString } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { Pagination } from "../components/Pagination";
import { ProjectCard } from "../components/ProjectCard";
import { ProjectSearch, type ProjectSearchValues } from "../components/ProjectSearch";
import { useApi } from "../hooks/useApi";
import type { SearchResponse } from "../types";

interface ProjectResultsPageProps {
  mode: "bids" | "leads";
}

function valuesFromParams(params: URLSearchParams): ProjectSearchValues {
  return {
    keywords: params.get("keywords") ?? "",
    location: params.get("location") ?? "",
    state: params.get("state") ?? "all",
    stage: params.get("stage") ?? "all",
    due: params.get("due") ?? "all",
  };
}

export function ProjectResultsPage({ mode }: ProjectResultsPageProps) {
  const [params, setParams] = useSearchParams();
  const [draftValues, setDraftValues] = useState(() => valuesFromParams(params));
  const page = Math.max(Number(params.get("page") ?? 1), 1);
  const pageSize = Number(params.get("limit") ?? 10);
  const activeValues = valuesFromParams(params);

  const path = `/api/search${queryString({
    ...activeValues,
    readiness: mode === "bids" ? "bid-ready" : "all",
    freshness: mode === "bids" ? "actionable" : "all",
    includeArchived: false,
    page,
    limit: pageSize,
  })}`;
  const { data, error, loading } = useApi<SearchResponse>(path);

  const applySearch = () => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(draftValues)) {
      if (value && value !== "all") next.set(key, value);
    }
    if (pageSize !== 10) next.set("limit", String(pageSize));
    setParams(next);
  };

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
        <p className="eyebrow">{mode === "bids" ? "CURRENT SOLICITATIONS" : "CONNECTED PROJECT PIPELINE"}</p>
        <h1>{mode === "bids" ? "Open construction bids" : "Project leads"}</h1>
        <p>
          {mode === "bids"
            ? "Only bidding-stage records with a current deadline and an official plans or specifications route."
            : "Explore planning, design, permitting, award, and construction records without weakening the open-bid gate."}
        </p>
      </header>

      <ProjectSearch values={draftValues} showStage={mode === "leads"} onChange={setDraftValues} onSubmit={applySearch} />

      <AsyncState loading={loading} error={error}>
        {data && (
          <section className="results-section">
            <div className="results-toolbar">
              <p><strong>{(data.meta.matchedProjects ?? 0).toLocaleString()}</strong> matching records</p>
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
              <div className="project-grid">
                {data.projects.map((project) => <ProjectCard key={project.id} project={project} />)}
              </div>
            ) : (
              <div className="empty-panel">
                <h2>No records match these filters</h2>
                <p>Try a broader location, another stage, or fewer keywords.</p>
              </div>
            )}
            <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onPageChange={changePage} />
          </section>
        )}
      </AsyncState>
    </main>
  );
}
