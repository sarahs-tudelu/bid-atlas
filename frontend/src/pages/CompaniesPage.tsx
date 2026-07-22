import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { queryString } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { Pagination } from "../components/Pagination";
import { useApi } from "../hooks/useApi";
import type { Company, PageMeta } from "../types";

export function CompaniesPage() {
  const [params, setParams] = useSearchParams();
  const activeQuery = params.get("q") ?? "";
  const [query, setQuery] = useState(activeQuery);
  const page = Number(params.get("page") ?? 1);
  const { data, error, loading } = useApi<{ companies: Company[]; meta: PageMeta }>(
    `/api/companies${queryString({ q: activeQuery, page, limit: 25 })}`,
  );

  const setPage = (nextPage: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(nextPage));
    setParams(next);
  };

  return (
    <main className="route-page page-width">
      <header className="route-heading">
        <p className="eyebrow">SOURCE-PUBLISHED ORGANIZATIONS</p>
        <h1>Company intelligence</h1>
        <p>Owners, contractors, developers, and design firms named literally in connected public records.</p>
      </header>
      <form className="simple-search" onSubmit={(event) => { event.preventDefault(); setParams(query ? { q: query } : {}); }}>
        <label><span>Company name</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search organizations" /></label>
        <button className="button button-primary">Search</button>
      </form>
      <AsyncState loading={loading} error={error}>
        {data && (
          <>
            <div className="company-grid">
              {data.companies.map((company) => (
                <article className="company-card" key={`${company.name}:${company.role}`}>
                  <span className="stage-badge">{company.role}</span>
                  <h2>{company.name}</h2>
                  <p>{company.projectCount} connected project{company.projectCount === 1 ? "" : "s"}</p>
                  <small>{company.states.join(" · ") || "State not published"}</small>
                  <ul>
                    {company.projects.map((project) => (
                      <li key={project.id}><Link to={`/bid-desk?project=${encodeURIComponent(project.id)}`}>{project.title}</Link></li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
            <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onPageChange={setPage} />
          </>
        )}
      </AsyncState>
    </main>
  );
}
