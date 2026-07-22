import { useMemo, useState } from "react";

import { AsyncState } from "../components/AsyncState";
import { MetricCard } from "../components/MetricCard";
import { SourceWarnings } from "../components/SourceWarnings";
import { useApi } from "../hooks/useApi";
import { formatCount } from "../lib/format";
import type { CoverageResponse, CoverageState } from "../types";

const STATUS_LABELS: Record<string, string> = {
  connected: "Connected",
  partial: "Partial",
  identified: "Identified",
  "not-connected": "Not connected",
};

function statusClass(value: string): string {
  if (value === "connected") return "status-connected";
  if (value === "partial") return "status-partial";
  return "status-none";
}

function StatusPill({ value }: { value: string }) {
  return <span className={`status-pill ${statusClass(value)}`}>{STATUS_LABELS[value] ?? value}</span>;
}

type SortKey = "name" | "loadedProjects";

export function CoveragePage() {
  const { data, error, loading, refetch } = useApi<CoverageResponse>("/api/coverage");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "name", descending: false });

  const states = useMemo(() => {
    if (!data) return [] as CoverageState[];
    const normalized = query.trim().toLowerCase();
    const filtered = data.coverage.states.filter(
      (state) => !normalized || state.name.toLowerCase().includes(normalized) || state.code.toLowerCase() === normalized,
    );
    const direction = sort.descending ? -1 : 1;
    return [...filtered].sort((left, right) =>
      sort.key === "loadedProjects"
        ? (left.loadedProjects - right.loadedProjects) * direction
        : left.name.localeCompare(right.name) * direction,
    );
  }, [data, query, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((current) => ({ key, descending: current.key === key ? !current.descending : key === "loadedProjects" }));

  const sortIndicator = (key: SortKey) => (sort.key === key ? (sort.descending ? "▾" : "▴") : "");

  return (
    <main className="route-page page-width">
      <header className="route-heading">
        <p className="eyebrow">Connection ledger</p>
        <h1>National coverage</h1>
        <p>Coverage is measured source by source. Identification is not the same as an active, current connection.</p>
      </header>

      <AsyncState loading={loading} error={error} onRetry={refetch}>
        {data && (
          <>
            <div className="notice-panel">
              <strong>Coverage truth:</strong> {data.coverage.statement}
            </div>
            <SourceWarnings warnings={data.warnings} />

            <section className="metric-grid" aria-label="Coverage totals">
              <MetricCard
                label="Registry rows"
                value={formatCount(data.coverage.registryRowsAvailable)}
                detail="Authoritative government universe"
              />
              <MetricCard
                label="Loaded projects"
                value={formatCount(data.coverage.loadedProjectRecords)}
                detail="Current connected snapshot"
              />
              <MetricCard
                label="Connected groups"
                value={formatCount(data.coverage.connectedSourceGroups)}
                detail={`${formatCount(data.coverage.identifiedSourceGroups)} identified`}
              />
              <MetricCard
                label="Nationally complete"
                value={data.coverage.nationallyComplete ? "Yes" : "No"}
                detail="No overclaiming"
              />
            </section>

            <section className="section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">State / DC matrix</p>
                  <h2>Connected lifecycle sources</h2>
                </div>
                <label className="inline-filter">
                  <span>Filter</span>
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="State or code"
                  />
                </label>
              </div>

              <p className="results-toolbar" aria-live="polite">
                <strong>{states.length}</strong> of {data.coverage.states.length} states shown
              </p>

              {states.length ? (
                <div className="table-wrap">
                  <table>
                    <caption className="visually-hidden">Connected lifecycle sources by state</caption>
                    <thead>
                      <tr>
                        <th scope="col" aria-sort={sort.key === "name" ? (sort.descending ? "descending" : "ascending") : "none"}>
                          <button className="sort-button" type="button" onClick={() => toggleSort("name")}>
                            State <span aria-hidden="true">{sortIndicator("name")}</span>
                          </button>
                        </th>
                        <th
                          scope="col"
                          aria-sort={sort.key === "loadedProjects" ? (sort.descending ? "descending" : "ascending") : "none"}
                        >
                          <button className="sort-button" type="button" onClick={() => toggleSort("loadedProjects")}>
                            Projects <span aria-hidden="true">{sortIndicator("loadedProjects")}</span>
                          </button>
                        </th>
                        <th scope="col">Procurement</th>
                        <th scope="col">DOT bids</th>
                        <th scope="col">Federal canopy</th>
                        <th scope="col">Permits</th>
                        <th scope="col">Planning</th>
                      </tr>
                    </thead>
                    <tbody>
                      {states.map((state) => (
                        <tr key={state.code}>
                          <th scope="row">
                            <span>{state.code}</span> {state.name}
                          </th>
                          <td>{formatCount(state.loadedProjects)}</td>
                          <td>
                            <a href={state.procurementUrl} target="_blank" rel="noreferrer">
                              <StatusPill value={state.procurement} />
                            </a>
                          </td>
                          <td>
                            <a href={state.dotBiddingUrl} target="_blank" rel="noreferrer">
                              <StatusPill value={state.dotBidding} />
                            </a>
                          </td>
                          <td>
                            {state.federalProcurement ? (
                              <a href="https://sam.gov/search/?index=opp" target="_blank" rel="noreferrer">
                                <StatusPill value={state.federalProcurement} />
                              </a>
                            ) : <StatusPill value="not-connected" />}
                          </td>
                          <td>
                            <StatusPill value={state.permits} />
                          </td>
                          <td>
                            <StatusPill value={state.planning} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-panel">
                  <h2>No state matches “{query}”</h2>
                  <p>Search by full state name or two-letter code.</p>
                  <button className="button button-primary" type="button" onClick={() => setQuery("")}>
                    Clear filter
                  </button>
                </div>
              )}
            </section>
          </>
        )}
      </AsyncState>
    </main>
  );
}
