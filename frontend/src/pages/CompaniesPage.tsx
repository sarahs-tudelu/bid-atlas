import { Link, useSearchParams } from "react-router-dom";

import { queryString } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { Pagination } from "../components/Pagination";
import { QuerySearchForm } from "../components/QuerySearchForm";
import { CardGridSkeleton } from "../components/Skeleton";
import { useApi } from "../hooks/useApi";
import type { Company, PageMeta } from "../types";

interface CompaniesResponse {
  companies: Company[];
  meta: PageMeta;
}

const VISIBLE_PROJECTS = 4;

function CompanyCard({ company }: { company: Company }) {
  const projects = company.projects ?? [];
  const visible = projects.slice(0, VISIBLE_PROJECTS);
  const overflow = projects.slice(VISIBLE_PROJECTS);

  return (
    <article className="company-card">
      <span className="stage-badge">{company.role}</span>
      <h2>{company.name}</h2>
      <p>
        {company.projectCount.toLocaleString()} connected project{company.projectCount === 1 ? "" : "s"}
      </p>
      <small>{company.states?.join(" · ") || "State not published"}</small>

      {visible.length > 0 && (
        <ul>
          {visible.map((project) => (
            <li key={project.id}>
              <Link to={`/bid-desk?project=${encodeURIComponent(project.id)}`}>{project.title}</Link>
            </li>
          ))}
        </ul>
      )}

      {overflow.length > 0 && (
        <details>
          <summary>
            Show {overflow.length} more project{overflow.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {overflow.map((project) => (
              <li key={project.id}>
                <Link to={`/bid-desk?project=${encodeURIComponent(project.id)}`}>{project.title}</Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

export function CompaniesPage() {
  const [params, setParams] = useSearchParams();
  const activeQuery = params.get("q") ?? "";
  const page = Math.max(Number(params.get("page") ?? 1) || 1, 1);

  const { data, error, loading, refreshing, refetch } = useApi<CompaniesResponse>(
    `/api/companies${queryString({ q: activeQuery, page, limit: 25 })}`,
  );

  const matched = data?.meta.total ?? data?.meta.matchedProjects ?? data?.companies.length ?? 0;

  return (
    <main className="route-page page-width">
      <header className="route-heading">
        <p className="eyebrow">Source-published organizations</p>
        <h1>Company intelligence</h1>
        <p>Owners, contractors, developers, and design firms named literally in connected public records.</p>
      </header>

      <QuerySearchForm
        key={activeQuery}
        label="Company name"
        placeholder="Search organizations"
        initialQuery={activeQuery}
        onSearch={(query) => setParams(query ? { q: query } : {})}
      />

      <AsyncState loading={loading} error={error} onRetry={refetch} skeleton={<CardGridSkeleton count={6} />}>
        {data && (
          <section className="results-section">
            <div className="results-toolbar">
              <p aria-live="polite">
                <strong>{matched.toLocaleString()}</strong> organization{matched === 1 ? "" : "s"}
                {refreshing && <span className="results-refreshing"> · updating…</span>}
              </p>
            </div>

            {data.companies.length ? (
              <div className={`company-grid ${refreshing ? "is-refreshing" : ""}`}>
                {data.companies.map((company) => (
                  <CompanyCard key={`${company.name}:${company.role}`} company={company} />
                ))}
              </div>
            ) : (
              <div className="empty-panel">
                <h2>No organizations match this search</h2>
                <p>Only companies named literally in a connected public record appear here.</p>
                {activeQuery && (
                  <button className="button button-primary" type="button" onClick={() => setParams({})}>
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
