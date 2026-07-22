import { Link, useSearchParams } from "react-router-dom";

import { queryString } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { Pagination } from "../components/Pagination";
import { QuerySearchForm } from "../components/QuerySearchForm";
import { ListSkeleton } from "../components/Skeleton";
import { useApi } from "../hooks/useApi";
import type { DocumentRecord, PageMeta } from "../types";

interface DocumentsResponse {
  documents: DocumentRecord[];
  meta: PageMeta;
}

export function DocumentsPage() {
  const [params, setParams] = useSearchParams();
  const activeQuery = params.get("q") ?? "";
  const projectId = params.get("project") ?? "";
  const page = Math.max(Number(params.get("page") ?? 1) || 1, 1);

  const { data, error, loading, refreshing, refetch } = useApi<DocumentsResponse>(
    `/api/documents/search${queryString({ q: activeQuery, projectId, page, limit: 25 })}`,
  );

  const runSearch = (nextQuery: string) => {
    const next = new URLSearchParams();
    if (nextQuery) next.set("q", nextQuery);
    if (projectId) next.set("project", projectId);
    setParams(next);
  };

  const matched = data?.meta.matchedProjects ?? data?.meta.total ?? data?.documents.length ?? 0;

  return (
    <main className="route-page page-width">
      <header className="route-heading">
        <p className="eyebrow">Official document routes</p>
        <h1>Plans and specifications</h1>
        <p>Every item stays attached to its originating project and access requirement.</p>
      </header>

      <QuerySearchForm
        key={activeQuery}
        label="Document or project"
        placeholder="plans, specifications, addendum"
        initialQuery={activeQuery}
        onSearch={runSearch}
      />

      {projectId && (
        <div className="filter-chips">
          <span>Applied</span>
          <span className="chip">
            <small>Project</small>
            {projectId}
            <button type="button" aria-label="Remove project filter" onClick={() => setParams(activeQuery ? { q: activeQuery } : {})}>
              ×
            </button>
          </span>
        </div>
      )}

      <AsyncState loading={loading} error={error} onRetry={refetch} skeleton={<ListSkeleton count={6} />}>
        {data && (
          <section className="results-section">
            <div className="results-toolbar">
              <p aria-live="polite">
                <strong>{matched.toLocaleString()}</strong> document{matched === 1 ? "" : "s"}
                {refreshing && <span className="results-refreshing"> · updating…</span>}
              </p>
            </div>

            {data.documents.length ? (
              <div className={`document-list ${refreshing ? "is-refreshing" : ""}`}>
                {data.documents.map((document) => (
                  <article className="document-row" key={document.id}>
                    <div>
                      <div className="document-row-meta">
                        <span className="stage-badge">{document.kind || "document"}</span>
                        <span className={`due-badge ${document.access === "free-account" ? "due-soon" : ""}`}>
                          {document.access === "free-account" ? "Account required" : "Public access"}
                        </span>
                        {document.indexStatus === "indexed" && <span className="due-badge">Text indexed</span>}
                      </div>
                      <h2>{document.name}</h2>
                      <p>{document.projectTitle}</p>
                    </div>
                    <div className="document-row-actions">
                      <a className="button button-primary" href={document.url} target="_blank" rel="noreferrer">
                        Open official route ↗
                      </a>
                      <Link to={`/bid-desk?project=${encodeURIComponent(document.projectId)}`}>Project workspace</Link>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-panel">
                <h2>No documents match this search</h2>
                <p>
                  {activeQuery || projectId
                    ? "Try a broader term, or clear the search to browse every connected document route."
                    : "No document routes have been published by the connected sources yet."}
                </p>
                {(activeQuery || projectId) && (
                  <button className="button button-primary" type="button" onClick={() => runSearch("")}>
                    Clear search
                  </button>
                )}
              </div>
            )}

            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              pageSize={data.meta.pageSize}
              totalItems={matched}
              onPageChange={(nextPage) => {
                const next = new URLSearchParams(params);
                next.set("page", String(nextPage));
                setParams(next);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            />
          </section>
        )}
      </AsyncState>
    </main>
  );
}
