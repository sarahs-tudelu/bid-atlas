"use client";

import { useEffect, useState, type FormEvent } from "react";
import { allStateOptions } from "./lib/national-coverage";

type JurisdictionRow = {
  id: string;
  name: string;
  city?: string | null;
  governmentType: string;
  registryKind: string;
  state?: string | null;
  website?: string | null;
  sourceUrl?: string | null;
  workerStatus: string;
  workerAttemptCount: number;
  sourceCandidatesFound: number;
  connectedSources: number;
  loadedProjects: number;
  publicDocuments: number;
  connectedSourceClasses: number;
  requiredSourceClasses: number;
  metricsRefreshedAt?: string | null;
  connectionState: "connected" | "partial" | "not-connected";
};

type JurisdictionResponse = {
  total: number;
  totalPages: number;
  jurisdictions: JurisdictionRow[];
  registry: {
    importedRowsExpected: number;
    independentLocalGovernments: number;
    incorporatedPlaceSeeds: number;
    citySeedIncludesDistrictOfColumbia: boolean;
    ambiguousWithinStateNames: number;
    usingFallbackSeeds?: boolean;
  };
};

function connectionLabel(value: JurisdictionRow["connectionState"]): string {
  if (value === "connected") return "Required adapters active";
  if (value === "partial") return "Some adapters active";
  return "No active adapter";
}

function workerLabel(value: string): string {
  if (value === "queued") return "Queued";
  if (value === "running") return "Discovering";
  if (value === "candidates-found") return "Candidates found";
  if (value === "connected") return "Monitoring";
  if (value === "retry") return "Retry scheduled";
  if (value === "awaiting-official-registry-match") return "Needs Census-ID match";
  if (value === "not-seeded") return "Not queued";
  return value.replaceAll("-", " ");
}

function assessmentLabel(value?: string | null): string {
  if (!value) return "No assessment recorded";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= 86_400_000) {
    return "No assessment recorded";
  }
  return `Metrics refreshed ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(timestamp))} UTC`;
}

export function JurisdictionExplorer() {
  const [draftQuery, setDraftQuery] = useState("");
  const [draftState, setDraftState] = useState("all");
  const [query, setQuery] = useState("");
  const [state, setState] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [requestVersion, setRequestVersion] = useState(0);
  const [data, setData] = useState<JurisdictionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      q: query,
      state,
      page: String(page),
      limit: String(pageSize),
    });

    fetch(`/api/jurisdictions?${params}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Coverage lookup failed with status ${response.status}`);
        return (await response.json()) as JurisdictionResponse;
      })
      .then((nextData) => {
        setData(nextData);
        setError("");
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Coverage lookup failed");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [page, pageSize, query, requestVersion, state]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    setPage(1);
    setQuery(draftQuery.trim());
    setState(draftState);
    setRequestVersion((value) => value + 1);
  };

  const totalPages = Math.max(1, data?.totalPages ?? 1);

  return (
    <section className="jurisdiction-explorer" aria-labelledby="jurisdiction-explorer-title">
      <header className="jurisdiction-explorer__head">
        <div>
          <p className="eyebrow">CITY + PUBLIC-OWNER COVERAGE</p>
          <h2 id="jurisdiction-explorer-title">
            Every registry jurisdiction gets its own coverage row.
          </h2>
        </div>
        <p>
          Active registry rows receive resumable discovery jobs. Adapter status changes only after a
          verified public-source adapter is running; it does not claim every project in that jurisdiction.
        </p>
      </header>

      <form className="jurisdiction-explorer__search" onSubmit={submit} role="search">
        <label>
          <span>City, public owner, or jurisdiction</span>
          <input
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="Example: Birmingham, Seattle, Jefferson County"
          />
        </label>
        <label>
          <span>State</span>
          <select value={draftState} onChange={(event) => setDraftState(event.target.value)}>
            <option value="all">All states + DC</option>
            {allStateOptions().map(([code, name]) => (
              <option value={code} key={code}>{code} — {name}</option>
            ))}
          </select>
        </label>
        <button type="submit">Search coverage</button>
      </form>

      {data && (
        <div className="jurisdiction-explorer__facts">
          <div><strong>{data.total.toLocaleString("en-US")}</strong><span>matching jurisdiction rows</span></div>
          <div><strong>{data.registry.incorporatedPlaceSeeds.toLocaleString("en-US")}</strong><span>supplemental place seeds in the supplied file</span></div>
          <div><strong>{data.registry.importedRowsExpected.toLocaleString("en-US")}</strong><span>official government/agency registry target</span></div>
          <div><strong>{data.registry.ambiguousWithinStateNames}</strong><span>same-state names requiring Census IDs</span></div>
        </div>
      )}

      {data?.registry.usingFallbackSeeds && (
        <p className="jurisdiction-explorer__notice" role="status">
          Showing the supplied incorporated-place seed list while the official 97,241-row Census
          registry is not loaded in this environment. These rows are discovery targets, not active source adapters.
        </p>
      )}
      {error && <p className="jurisdiction-explorer__error" role="alert">{error}</p>}

      <div className="jurisdiction-explorer__toolbar">
        <span>
          {loading ? "Loading coverage…" : `Page ${page.toLocaleString("en-US")} of ${totalPages.toLocaleString("en-US")}`}
        </span>
        <label>
          Rows per page
          <select
            value={pageSize}
            onChange={(event) => {
              setLoading(true);
              setError("");
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
        </label>
      </div>

      <div className="jurisdiction-explorer__table-wrap">
        <table>
          <thead>
            <tr>
              <th>Jurisdiction</th>
              <th>Source adapter status</th>
              <th>Discovery job</th>
              <th>Source classes</th>
              <th>Projects</th>
              <th>Documents</th>
            </tr>
          </thead>
          <tbody>
            {data?.jurisdictions.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  <strong>{row.name}</strong>
                  <span>{row.state ?? "—"} · {row.governmentType}</span>
                </th>
                <td>
                  <span className={`jurisdiction-state jurisdiction-state--${row.connectionState}`}>
                    {connectionLabel(row.connectionState)}
                  </span>
                  <span>{assessmentLabel(row.metricsRefreshedAt)}</span>
                </td>
                <td>
                  <strong>{workerLabel(row.workerStatus)}</strong>
                  <span>{row.sourceCandidatesFound} candidates · {row.workerAttemptCount} runs</span>
                </td>
                <td>{row.connectedSourceClasses}/{row.requiredSourceClasses}</td>
                <td>{row.loadedProjects.toLocaleString("en-US")}</td>
                <td>{row.publicDocuments.toLocaleString("en-US")}</td>
              </tr>
            ))}
            {!loading && data?.jurisdictions.length === 0 && (
              <tr><td colSpan={6}>No jurisdiction rows match this search.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <nav className="jurisdiction-explorer__pagination" aria-label="Jurisdiction result pages">
        <button type="button" disabled={page <= 1 || loading} onClick={() => { setLoading(true); setPage(1); }}>First</button>
        <button type="button" disabled={page <= 1 || loading} onClick={() => { setLoading(true); setPage((value) => Math.max(1, value - 1)); }}>Previous</button>
        <span>{data?.total.toLocaleString("en-US") ?? "0"} rows</span>
        <button type="button" disabled={page >= totalPages || loading} onClick={() => { setLoading(true); setPage((value) => Math.min(totalPages, value + 1)); }}>Next</button>
        <button type="button" disabled={page >= totalPages || loading} onClick={() => { setLoading(true); setPage(totalPages); }}>Last</button>
      </nav>
    </section>
  );
}
