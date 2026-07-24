import { useState, type FormEvent } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import { queryString } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { Pagination } from "../components/Pagination";
import { QuerySearchForm } from "../components/QuerySearchForm";
import { CardGridSkeleton } from "../components/Skeleton";
import { useApi } from "../hooks/useApi";
import { telephoneHref } from "../lib/contacts";
import { projectWorkspaceHref } from "../lib/projectNavigation";
import type {
  Company,
  PageMeta,
  PartnerDirectoryResponse,
  PartnerOrganization,
  ProductType,
} from "../types";

interface CompaniesResponse {
  companies: Company[];
  meta: PageMeta;
}

const VISIBLE_PROJECTS = 4;
const PRODUCT_LABELS: Record<ProductType, string> = {
  canopies: "Canopies",
  pergolas: "Pergolas",
  "partition-walls": "Partition walls",
};
const ORGANIZATION_TYPES = new Set(["all", "architect", "developer", "owner", "installer"]);
const DIRECTORY_PRODUCTS = new Set(["all", ...Object.keys(PRODUCT_LABELS)]);
const ORGANIZATION_LABELS = {
  architect: "Design firm",
  developer: "Developer",
  owner: "Project owner",
  installer: "Installer partner",
} as const;

function CompanyCard({ company, returnTo }: { company: Company; returnTo: string }) {
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
              <Link to={projectWorkspaceHref(project.id, returnTo)}>{project.title}</Link>
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
                <Link to={projectWorkspaceHref(project.id, returnTo)}>{project.title}</Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

function ConnectedCompanies() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const activeQuery = params.get("q") ?? "";
  const page = Math.max(Number(params.get("page") ?? 1) || 1, 1);

  const { data, error, loading, refreshing, refetch } = useApi<CompaniesResponse>(
    `/api/companies${queryString({ q: activeQuery, page, limit: 25 })}`,
  );

  const matched = data?.meta.total ?? data?.meta.matchedProjects ?? data?.companies.length ?? 0;

  return (
    <>
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
                  <CompanyCard
                    key={`${company.name}:${company.role}`}
                    company={company}
                    returnTo={`${location.pathname}${location.search}`}
                  />
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
    </>
  );
}

function PartnerCard({ organization }: { organization: PartnerOrganization }) {
  const location = [organization.city, organization.state, organization.postalCode].filter(Boolean).join(", ");

  return (
    <article className="company-card partner-card">
      <div className="partner-card-heading">
        <div className="partner-card-badges">
          <span className="stage-badge">
            {organization.practiceType || ORGANIZATION_LABELS[organization.organizationType]}
          </span>
          {organization.priorityRank ? (
            <span className="priority-badge">Priority #{organization.priorityRank}</span>
          ) : null}
        </div>
        <small>Verified {organization.verifiedAt}</small>
      </div>
      <h2>{organization.name}</h2>
      <p>{location}</p>

      <div className="partner-scope-list" aria-label="Relevant product scopes">
        {organization.productTypes.map((product) => (
          <span key={product}>{PRODUCT_LABELS[product]}</span>
        ))}
      </div>

      <section className="partner-fit">
        <h3>Why this could fit</h3>
        <ul>
          {organization.fitReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </section>

      <section className="partner-contact">
        <span>Published contact</span>
        <strong>{organization.contactName}</strong>
        <small>{organization.contactRole}</small>
        <div>
          {organization.email ? (
            <span className="partner-contact-value">{organization.email}</span>
          ) : organization.phone ? (
            <a href={telephoneHref(organization.phone)}>{organization.phone}</a>
          ) : null}
        </div>
      </section>

      <div className="partner-actions">
        {organization.email ? (
          <Link
            className="button button-small button-primary"
            to={`/outreach?project=${encodeURIComponent(`prospect:${organization.id}`)}`}
          >
            Email outreach
          </Link>
        ) : (
          <a className="button button-small button-primary" href={telephoneHref(organization.phone)}>
            Call {organization.phone}
          </a>
        )}
        <a className="button button-small button-quiet" href={organization.websiteUrl} target="_blank" rel="noreferrer">
          Website
        </a>
        <a className="button button-small button-quiet" href={organization.sourceUrl} target="_blank" rel="noreferrer">
          Verify source
        </a>
        {organization.fitSourceUrl && organization.fitSourceUrl !== organization.sourceUrl && (
          <a className="partner-evidence-link" href={organization.fitSourceUrl} target="_blank" rel="noreferrer">
            Fit evidence
          </a>
        )}
      </div>
    </article>
  );
}

interface DirectoryFiltersProps {
  initialQuery: string;
  organizationType: string;
  product: string;
  hasFilters: boolean;
  onFilter: (key: "q" | "type" | "product", value: string) => void;
  onClear: () => void;
}

function DirectoryFilters({
  initialQuery,
  organizationType,
  product,
  hasFilters,
  onFilter,
  onClear,
}: DirectoryFiltersProps) {
  const [query, setQuery] = useState(initialQuery);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onFilter("q", query.trim());
  };

  return (
    <form className="directory-filter-bar" role="search" onSubmit={submit}>
      <label className="directory-query">
        <span>Organization, sector, or city</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the tri-state directory"
        />
      </label>
      <label>
        <span>Organization type</span>
        <select value={organizationType} onChange={(event) => onFilter("type", event.target.value)}>
          <option value="all">All partner types</option>
          <option value="architect">Design firms only</option>
          <option value="developer">Developers only</option>
          <option value="owner">Project owners only</option>
          <option value="installer">Installer partners only</option>
        </select>
      </label>
      <label>
        <span>Product scope</span>
        <select value={product} onChange={(event) => onFilter("product", event.target.value)}>
          <option value="all">All product scopes</option>
          <option value="canopies">Canopies</option>
          <option value="pergolas">Pergolas</option>
          <option value="partition-walls">Partition walls</option>
        </select>
      </label>
      <button className="button button-primary" type="submit">
        Search
      </button>
      {hasFilters && (
        <button className="button button-quiet" type="button" onClick={onClear}>
          Clear
        </button>
      )}
    </form>
  );
}

function PartnerDirectory() {
  const [params, setParams] = useSearchParams();
  const activeQuery = params.get("q") ?? "";
  const requestedType = params.get("type") ?? "all";
  const requestedProduct = params.get("product") ?? "all";
  const organizationType = ORGANIZATION_TYPES.has(requestedType) ? requestedType : "all";
  const product = DIRECTORY_PRODUCTS.has(requestedProduct) ? requestedProduct : "all";
  const page = Math.max(Number(params.get("page") ?? 1) || 1, 1);

  const { data, error, loading, refreshing, refetch } = useApi<PartnerDirectoryResponse>(
    `/api/partner-directory${queryString({
      q: activeQuery,
      type: organizationType,
      product,
      page,
      limit: 25,
    })}`,
  );

  const updateFilter = (key: "q" | "type" | "product", value: string) => {
    const next = new URLSearchParams(params);
    next.set("view", "directory");
    next.delete("page");
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    setParams(next);
  };

  const clearFilters = () => {
    setParams({ view: "directory" });
  };

  const total = data?.meta.total ?? data?.organizations.length ?? 0;
  const hasFilters = Boolean(activeQuery || organizationType !== "all" || product !== "all");

  return (
    <>
      <DirectoryFilters
        key={activeQuery}
        initialQuery={activeQuery}
        organizationType={organizationType}
        product={product}
        hasFilters={hasFilters}
        onFilter={updateFilter}
        onClear={clearFilters}
      />

      <p className="directory-method-note">
        Contact-only directory. Every entry has a phone number or email published by the organization or an
        official government source. Scope alignment is research guidance, not an active-project claim or endorsement.
      </p>

      <AsyncState loading={loading} error={error} onRetry={refetch} skeleton={<CardGridSkeleton count={6} />}>
        {data && (
          <section className="results-section">
            <div className="results-toolbar">
              <p aria-live="polite">
                <strong>{total.toLocaleString()}</strong> match{total === 1 ? "" : "es"}
                {" · "}
                {data.summary.architects} design firms · {data.summary.developers} developers ·{" "}
                {data.summary.owners} owners · {data.summary.installers} installers
                {refreshing && <span className="results-refreshing"> · updating…</span>}
              </p>
              <small>Contacts verified {data.meta.verifiedAt}</small>
            </div>

            {data.organizations.length ? (
              <div className={`company-grid partner-grid ${refreshing ? "is-refreshing" : ""}`}>
                {data.organizations.map((organization) => (
                  <PartnerCard key={organization.id} organization={organization} />
                ))}
              </div>
            ) : (
              <div className="empty-panel">
                <h2>No contactable organizations match these filters</h2>
                <p>Try another product scope or clear the organization search.</p>
                <button className="button button-primary" type="button" onClick={clearFilters}>
                  Clear filters
                </button>
              </div>
            )}

            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              pageSize={data.meta.pageSize}
              totalItems={total}
              onPageChange={(nextPage) => {
                const next = new URLSearchParams(params);
                next.set("view", "directory");
                next.set("page", String(nextPage));
                setParams(next);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            />
          </section>
        )}
      </AsyncState>
    </>
  );
}

export function CompaniesPage() {
  const [params] = useSearchParams();
  const directoryView = params.get("view") === "directory";

  return (
    <main className="route-page page-width">
      <header className="route-heading">
        <p className="eyebrow">Organizations and potential partners</p>
        <h1>Company intelligence</h1>
        <p>
          Explore companies named in project records or a researched tri-state directory of design firms,
          developers, project owners, and installer partners with published contact information.
        </p>
      </header>

      <nav className="company-view-switch" aria-label="Company intelligence views">
        <Link className={`button ${directoryView ? "button-quiet" : "button-primary"}`} to="/companies">
          Connected project companies
        </Link>
        <Link
          className={`button ${directoryView ? "button-primary" : "button-quiet"}`}
          to="/companies?view=directory"
        >
          Tri-state prospects
        </Link>
      </nav>

      {directoryView ? <PartnerDirectory /> : <ConnectedCompanies />}
    </main>
  );
}
