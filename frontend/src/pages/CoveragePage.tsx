import { useMemo, useState } from "react";

import { AsyncState } from "../components/AsyncState";
import { MetricCard } from "../components/MetricCard";
import { useApi } from "../hooks/useApi";
import type { CoverageResponse } from "../types";

function statusLabel(value: string): string {
  return value.replace("not-connected", "Not connected").replace("identified", "Identified").replace("partial", "Partial");
}

export function CoveragePage() {
  const { data, error, loading } = useApi<CoverageResponse>("/api/coverage");
  const [query, setQuery] = useState("");
  const states = useMemo(() => {
    if (!data) return [];
    const normalized = query.trim().toLowerCase();
    return data.coverage.states.filter((state) => !normalized || state.name.toLowerCase().includes(normalized) || state.code.toLowerCase() === normalized);
  }, [data, query]);

  return (
    <main className="route-page page-width">
      <header className="route-heading">
        <p className="eyebrow">CONNECTION LEDGER</p>
        <h1>National coverage</h1>
        <p>Coverage is measured source by source. Identification is not the same as an active, current connection.</p>
      </header>
      <AsyncState loading={loading} error={error}>
        {data && (
          <>
            <div className="notice-panel"><strong>Coverage truth:</strong> {data.coverage.statement}</div>
            <section className="metric-grid">
              <MetricCard label="Registry rows" value={data.coverage.registryRowsAvailable.toLocaleString()} detail="Authoritative government universe" />
              <MetricCard label="Loaded projects" value={data.coverage.loadedProjectRecords.toLocaleString()} detail="Current connected snapshot" />
              <MetricCard label="Connected groups" value={data.coverage.connectedSourceGroups} detail={`${data.coverage.identifiedSourceGroups} identified`} />
              <MetricCard label="Nationally complete" value={data.coverage.nationallyComplete ? "Yes" : "No"} detail="No overclaiming" />
            </section>
            <section className="section">
              <div className="section-heading">
                <div><p className="eyebrow">STATE / DC MATRIX</p><h2>Connected lifecycle sources</h2></div>
                <label className="inline-filter"><span>Filter</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="State or code" /></label>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>State</th><th>Projects</th><th>Procurement</th><th>DOT bids</th><th>Permits</th><th>Planning</th></tr></thead>
                  <tbody>
                    {states.map((state) => (
                      <tr key={state.code}>
                        <th scope="row"><span>{state.code}</span> {state.name}</th>
                        <td>{state.loadedProjects.toLocaleString()}</td>
                        <td><a href={state.procurementUrl} target="_blank" rel="noreferrer">{statusLabel(state.procurement)}</a></td>
                        <td><a href={state.dotBiddingUrl} target="_blank" rel="noreferrer">{statusLabel(state.dotBidding)}</a></td>
                        <td>{statusLabel(state.permits)}</td>
                        <td>{statusLabel(state.planning)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </AsyncState>
    </main>
  );
}
