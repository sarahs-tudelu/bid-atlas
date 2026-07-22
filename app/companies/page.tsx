import type { Metadata } from "next";
import Link from "next/link";
import {
  searchRegionalCompanies,
  type RegionalCompanyRole,
  type RegionalCompanyState,
} from "../lib/regional-company-intelligence";
import styles from "./companies.module.css";

export const metadata: Metadata = {
  title: "NY/NJ owners and contractors — BidAtlas",
  description:
    "Find organization-valued private owners and contractors attached to official New York and New Jersey construction records.",
};

export const dynamic = "force-dynamic";

interface CompaniesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(
  params: Record<string, string | string[] | undefined>,
  name: string,
  maximum: number,
): string {
  const value = params[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) ?? "";
}

function dateLabel(value?: string): string {
  if (!value) return "Not published";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(parsed)
    : value;
}

export default async function CompaniesPage({ searchParams }: CompaniesPageProps) {
  const params = await searchParams;
  const query = firstParam(params, "q", 100);
  const rawRole = firstParam(params, "role", 20);
  const rawState = firstParam(params, "state", 10).toUpperCase();
  const role: RegionalCompanyRole | "all" =
    rawRole === "owner" || rawRole === "contractor" ? rawRole : "all";
  const state: RegionalCompanyState | "all" =
    rawState === "NY" || rawState === "NJ" ? rawState : "all";
  const result = await searchRegionalCompanies(query, role, state);

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/" aria-label="BidAtlas home">
          <span aria-hidden="true">BA</span>
          <strong>BidAtlas</strong>
        </Link>
        <nav aria-label="Primary navigation">
          <Link href="/projects">Projects</Link>
          <span aria-current="page">Companies</span>
          <Link href="/bid-desk">Bid Desk</Link>
          <Link href="/coverage">Coverage</Link>
          <Link href="/source-monitor">Source Monitor</Link>
        </nav>
      </header>

      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>NY / NJ COMPANY EVIDENCE</p>
          <h1>Find the private owner or contractor attached to the record.</h1>
          <p>
            Search organization names already observed on official project records, then
            check the same business against public New York contractor and license registries.
            Person-only residential identities are not published here.
          </p>
        </div>
        <aside>
          <strong>Evidence rules</strong>
          <span>Owner must be a published business name</span>
          <span>GC must have an explicit permit role</span>
          <span>Every relationship links to its public record</span>
          <span>Applicant does not automatically mean contractor</span>
        </aside>
      </section>

      <section className={styles.searchPanel} aria-labelledby="company-search-title">
        <div>
          <p className={styles.eyebrow}>COMPANY SEARCH</p>
          <h2 id="company-search-title">Project roles and official registrations</h2>
        </div>
        <form method="get" action="/companies">
          <label className={styles.queryField}>
            <span>Company name</span>
            <input
              name="q"
              defaultValue={query}
              maxLength={100}
              placeholder="Example: Turner Construction"
            />
          </label>
          <label>
            <span>Project role</span>
            <select name="role" defaultValue={role}>
              <option value="all">Owners and contractors</option>
              <option value="owner">Private owners</option>
              <option value="contractor">General contractors</option>
            </select>
          </label>
          <label>
            <span>Project state</span>
            <select name="state" defaultValue={state}>
              <option value="all">New York and New Jersey</option>
              <option value="NY">New York</option>
              <option value="NJ">New Jersey</option>
            </select>
          </label>
          <button type="submit">Search public evidence</button>
        </form>
        <p className={styles.searchNote}>
          This is a server-submitted search, so it works without client-side scripting.
          Registry verification runs only after at least two company-name characters are entered.
        </p>
      </section>

      <section className={styles.workflow} aria-label="Regional public-source workflow">
        <article>
          <span>01</span>
          <div>
            <strong>Discover NYC work</strong>
            <p>DOB NOW filings identify projects and organization-valued private owners.</p>
          </div>
        </article>
        <article>
          <span>02</span>
          <div>
            <strong>Confirm the NYC GC</strong>
            <p>Approved permits contribute a contractor only when DOB publishes the permittee license type as GC.</p>
          </div>
        </article>
        <article>
          <span>03</span>
          <div>
            <strong>Discover NJ permit activity</strong>
            <p>The statewide feed supplies municipality, permit number, cost, use, block, and lot.</p>
          </div>
        </article>
        <article>
          <span>04</span>
          <div>
            <strong>Request the NJ permit record</strong>
            <p>The issuing municipality remains the public source for the address, business owner, contractor, and work description.</p>
          </div>
        </article>
      </section>

      <section className={styles.results} aria-labelledby="indexed-title">
        <header>
          <div>
            <p className={styles.eyebrow}>PROJECT-ROLE EVIDENCE</p>
            <h2 id="indexed-title">
              {result.indexed.length} {query ? "matching" : "recent"} owner or contractor organizations
            </h2>
          </div>
          <p>Relationships below come from ingested project records, not a purchased contact list.</p>
        </header>
        <div className={styles.companyGrid}>
          {result.indexed.map((company) => (
            <article className={styles.companyCard} key={`${company.id}:${company.role}`}>
              <div className={styles.companyMeta}>
                <span>{company.role === "contractor" ? "General contractor" : "Private owner"}</span>
                {company.state ? <span>{company.state}</span> : null}
              </div>
              <h3>{company.name}</h3>
              <ul>
                {company.projects.map((project) => (
                  <li key={project.id}>
                    <div>
                      <strong>{project.title}</strong>
                      <span>
                        {[project.city, project.state, project.sourceName].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    <div>
                      <Link href={`/bid-desk?project=${encodeURIComponent(project.id)}`}>Bid Desk</Link>
                      <a href={project.sourceUrl} target="_blank" rel="noreferrer">Evidence</a>
                    </div>
                  </li>
                ))}
              </ul>
            </article>
          ))}
          {result.indexed.length === 0 ? (
            <div className={styles.empty}>
              <strong>No matching organization-role evidence is indexed yet.</strong>
              <p>
                Try a broader business name or state. New connectors populate this list as their
                official source pages are ingested.
              </p>
            </div>
          ) : null}
        </div>
      </section>

      {query.length >= 2 ? (
        <section className={styles.registry} aria-labelledby="registry-title">
          <header>
            <div>
              <p className={styles.eyebrow}>INDEPENDENT VERIFICATION</p>
              <h2 id="registry-title">{result.registryMatches.length} official New York registry matches</h2>
            </div>
            <p>A registry match verifies the business record; it does not by itself prove a role on a specific project.</p>
          </header>
          {result.registryWarnings.map((warning) => (
            <p className={styles.warning} key={warning}>{warning}</p>
          ))}
          <div className={styles.registryGrid}>
            {result.registryMatches.map((match) => (
              <article key={`${match.registry}:${match.identifier}`}>
                <span>{match.registry}</span>
                <h3>{match.businessName}</h3>
                {match.alternateName ? <p>DBA {match.alternateName}</p> : null}
                <dl>
                  <div><dt>Identifier</dt><dd>{match.identifier}</dd></div>
                  <div><dt>Status</dt><dd>{match.status}</dd></div>
                  <div><dt>Type</dt><dd>{match.licenseType ?? "Not published"}</dd></div>
                  <div><dt>Expires</dt><dd>{dateLabel(match.expiresAt)}</dd></div>
                  <div><dt>Location</dt><dd>{[match.city, match.state].filter(Boolean).join(", ") || "Not published"}</dd></div>
                  <div><dt>Public phone</dt><dd>{match.phone ?? "Not published"}</dd></div>
                </dl>
                <a href={match.sourceUrl} target="_blank" rel="noreferrer">Open official registry row</a>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className={styles.njGap}>
        <div>
          <p className={styles.eyebrow}>NEW JERSEY HANDOFF</p>
          <h2>Why NJ owner and GC names need one municipal step</h2>
          <p>
            The state permit dataset does not publish address, owner, contractor, or work-description
            fields. Use the permit number, block, lot, municipality, and county from BidAtlas to request
            the underlying permit from the issuing construction office. Verify any returned residential
            contractor business separately before outreach.
          </p>
        </div>
        <div className={styles.njLinks}>
          <a href="https://www.nj.gov/dca/codes/publications/pdf_ora/muniroster.pdf" target="_blank" rel="noreferrer">
            Municipal construction office directory
          </a>
          <a href="https://newjersey.mylicense.com/verification/" target="_blank" rel="noreferrer">
            NJ contractor registration verification
          </a>
          <a href="https://data.nj.gov/d/w9se-dmra" target="_blank" rel="noreferrer">
            NJ construction permit data
          </a>
        </div>
      </section>
    </main>
  );
}
