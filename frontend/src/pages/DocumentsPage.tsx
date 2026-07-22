import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { queryString } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { Pagination } from "../components/Pagination";
import { useApi } from "../hooks/useApi";
import type { DocumentRecord, PageMeta } from "../types";

export function DocumentsPage() {
  const [params, setParams] = useSearchParams();
  const activeQuery = params.get("q") ?? "";
  const projectId = params.get("project") ?? "";
  const page = Number(params.get("page") ?? 1);
  const [query, setQuery] = useState(activeQuery);
  const { data, error, loading } = useApi<{ documents: DocumentRecord[]; meta: PageMeta }>(
    `/api/documents/search${queryString({ q: activeQuery, projectId, page, limit: 25 })}`,
  );

  return (
    <main className="route-page page-width">
      <header className="route-heading">
        <p className="eyebrow">OFFICIAL DOCUMENT ROUTES</p>
        <h1>Plans and specifications</h1>
        <p>Every item stays attached to its originating project and access requirement.</p>
      </header>
      <form className="simple-search" onSubmit={(event) => { event.preventDefault(); setParams(query ? { q: query } : {}); }}>
        <label><span>Document or project</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="plans, specifications, addendum" /></label>
        <button className="button button-primary">Search</button>
      </form>
      <AsyncState loading={loading} error={error}>
        {data && (
          <>
            <div className="document-list">
              {data.documents.map((document) => (
                <article className="document-row" key={document.id}>
                  <div>
                    <span>{document.kind}</span>
                    <h2>{document.name}</h2>
                    <p>{document.projectTitle}</p>
                  </div>
                  <div className="document-row-actions">
                    <small>{document.access === "free-account" ? "Account required" : "Public access"}</small>
                    <a className="button button-primary" href={document.url} target="_blank" rel="noreferrer">Open official route ↗</a>
                    <Link to={`/bid-desk?project=${encodeURIComponent(document.projectId)}`}>Project workspace</Link>
                  </div>
                </article>
              ))}
            </div>
            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              onPageChange={(nextPage) => {
                const next = new URLSearchParams(params);
                next.set("page", String(nextPage));
                setParams(next);
              }}
            />
          </>
        )}
      </AsyncState>
    </main>
  );
}
