import type { Metadata } from "next";
import Link from "next/link";
import { getChatGPTUser } from "../chatgpt-auth";
import { queryConnectedProjects } from "../lib/connected-project-search";
import { getDashboardFeed } from "../lib/dashboard-feed";
import { formatBidDeadline } from "../lib/deadline-time";
import { resolveIntegrationCredential } from "../lib/integration-credentials";
import { allStateOptions, normalizeStateCode } from "../lib/national-coverage";
import { projectLeadReasons, type ProjectLeadReason } from "../lib/project-leads";
import { parseKeywordInput } from "../lib/search";
import type {
  ProjectLeadFilter,
  ProjectRecord,
  ProjectStage,
} from "../lib/types";
import styles from "./leads.module.css";

export const metadata: Metadata = {
  title: "Connected project leads — BidAtlas",
  description:
    "Review connected permit, planning, construction, and incomplete bid records without weakening the qualified Open bids queue.",
};

export const dynamic = "force-dynamic";

interface LeadsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const STAGES: ProjectStage[] = [
  "planning",
  "design",
  "permitting",
  "bidding",
  "bid-opened",
  "awarded",
  "construction",
  "completed",
  "cancelled",
  "unclassified",
];

const STAGE_LABELS: Record<ProjectStage, string> = {
  planning: "Planning",
  design: "Design / review",
  permitting: "Permitting",
  bidding: "Bidding",
  "bid-opened": "Bid opened",
  awarded: "Awarded",
  construction: "Construction",
  completed: "Completed",
  cancelled: "Cancelled",
  unclassified: "Unclassified",
};

const LEAD_FILTERS: Array<[ProjectLeadFilter, string]> = [
  ["partial", "Not bid-ready"],
  ["all", "All connected records"],
  ["missing-owner", "Missing named owner"],
  ["missing-contractor", "Missing general contractor"],
  ["missing-documents", "Missing bid documents"],
  ["missing-deadline", "Missing bid deadline"],
  ["early-stage", "Planning, design, or permitting"],
];

const REASON_LABELS: Record<ProjectLeadReason, string> = {
  "not-bidding": "Not an active bidding-stage record",
  "not-official": "Official confidence not established",
  "missing-official-source": "Official HTTPS source missing",
  "missing-bid-facts": "Bid facts incomplete",
  "missing-location": "Location missing",
  "missing-deadline": "Bid deadline missing",
  "deadline-passed": "Bid deadline passed",
  "missing-bid-documents": "Plans or specifications missing",
  "missing-owner": "Named business owner missing",
  "missing-contractor": "Named general contractor missing",
};

function firstParam(
  params: Record<string, string | string[] | undefined>,
  name: string,
  maximum: number,
): string {
  const value = params[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) ?? "";
}

function positiveInt(value: string, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(parsed)));
}

function projectLocation(project: ProjectRecord): string {
  return [
    project.address,
    [project.city, project.county].filter(Boolean).join(", "),
    [project.state, project.postalCode].filter(Boolean).join(" "),
  ].filter(Boolean).join(" · ") || "Location not published";
}

function money(value?: number): string {
  if (value === undefined) return "Value not published";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function dateLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() > 86_400_000
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(parsed)
    : "Activity date not published";
}

function pageHref(
  params: {
    keywords: string;
    location: string;
    state: string;
    stage: ProjectStage | "all";
    leadFilter: ProjectLeadFilter;
    includeArchived: boolean;
    pageSize: number;
  },
  page: number,
): string {
  const query = new URLSearchParams();
  if (params.keywords) query.set("keywords", params.keywords);
  if (params.location) query.set("location", params.location);
  if (params.state !== "all") query.set("state", params.state);
  if (params.stage !== "all") query.set("stage", params.stage);
  if (params.leadFilter !== "partial") query.set("leadFilter", params.leadFilter);
  if (params.includeArchived) query.set("includeArchived", "1");
  if (params.pageSize !== 25) query.set("limit", String(params.pageSize));
  if (page > 1) query.set("page", String(page));
  return `/leads${query.size ? `?${query}` : ""}`;
}

export default async function LeadsPage({ searchParams }: LeadsPageProps) {
  const params = await searchParams;
  const keywords = firstParam(params, "keywords", 300);
  const location = firstParam(params, "location", 160);
  const rawState = firstParam(params, "state", 40);
  const normalizedState = normalizeStateCode(rawState);
  const state = normalizedState ? normalizedState : "all";
  const rawStage = firstParam(params, "stage", 30) as ProjectStage | "all";
  const stage = rawStage === "all" || STAGES.includes(rawStage as ProjectStage)
    ? rawStage
    : "all";
  const rawLeadFilter = firstParam(params, "leadFilter", 40) as ProjectLeadFilter;
  const leadFilter = LEAD_FILTERS.some(([value]) => value === rawLeadFilter)
    ? rawLeadFilter
    : "partial";
  const includeArchived =
    firstParam(params, "includeArchived", 8) === "1" ||
    stage === "completed" ||
    stage === "cancelled";
  const page = positiveInt(firstParam(params, "page", 12), 1, 1_000_000);
  const requestedLimit = positiveInt(firstParam(params, "limit", 3), 25, 50);
  const pageSize = [10, 25, 50].includes(requestedLimit) ? requestedLimit : 25;

  const user = await getChatGPTUser();
  const samCredential = await resolveIntegrationCredential(
    user?.email.toLowerCase(),
    "sam",
  );
  const feed = await getDashboardFeed({ samApiKey: samCredential?.apiKey });
  const search = await queryConnectedProjects(
    feed,
    {
      keywords: parseKeywordInput(keywords),
      location,
      match: "all",
      stage,
      state,
      freshness: "all",
      due: "all",
      readiness: "all",
      leadFilter,
      includeArchived,
    },
    page,
    pageSize,
  );

  const activePage = search.meta.page ?? page;
  const totalPages = Math.max(1, search.meta.totalPages ?? 1);
  const firstResult = search.meta.matchedProjects === 0
    ? 0
    : (activePage - 1) * pageSize + 1;
  const lastResult = Math.min(activePage * pageSize, search.meta.matchedProjects);
  const hrefParams = {
    keywords,
    location,
    state,
    stage,
    leadFilter,
    includeArchived,
    pageSize,
  };

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/" aria-label="BidAtlas home">
          <span aria-hidden="true">BA</span>
          <strong>BidAtlas</strong>
        </Link>
        <nav aria-label="Primary navigation">
          <Link href="/projects">Open bids</Link>
          <span aria-current="page">Project Leads</span>
          <Link href="/companies">Companies</Link>
          <Link href="/bid-desk">Bid Desk</Link>
          <Link href="/coverage">Coverage</Link>
          <Link href="/source-monitor">Source Monitor</Link>
        </nav>
      </header>

      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>CONNECTED PROJECT LEADS</p>
          <h1>See the projects before they become clean bid packages.</h1>
          <p>
            Review permit, planning, design, construction, expired, and incomplete
            procurement records separately from Open bids. Every card remains tied to
            the public source that produced it.
          </p>
        </div>
        <aside>
          <strong>Open bids stays strict</strong>
          <p>
            Moving partial records here keeps the bidding queue trustworthy while making
            early opportunities and missing evidence visible for research.
          </p>
          <Link href="/projects">View qualified Open bids</Link>
        </aside>
      </section>

      <section className={styles.searchPanel} aria-labelledby="lead-search-title">
        <header>
          <div>
            <p className={styles.eyebrow}>LEAD FILTERS</p>
            <h2 id="lead-search-title">Search every connected record</h2>
          </div>
          <p>Filters submit directly to the server and produce a shareable URL.</p>
        </header>
        <form method="get" action="/leads">
          <label className={styles.wide}>
            <span>Product, trade, company, or scope</span>
            <input name="keywords" defaultValue={keywords} maxLength={300} placeholder="roofing, storefront, Turner Construction" />
          </label>
          <label className={styles.wide}>
            <span>Location</span>
            <input name="location" defaultValue={location} maxLength={160} placeholder="city, county, ZIP, or state" />
          </label>
          <label>
            <span>Lead condition</span>
            <select name="leadFilter" defaultValue={leadFilter}>
              {LEAD_FILTERS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>Project stage</span>
            <select name="stage" defaultValue={stage}>
              <option value="all">All stages</option>
              {STAGES.map((value) => <option value={value} key={value}>{STAGE_LABELS[value]}</option>)}
            </select>
          </label>
          <label>
            <span>State</span>
            <select name="state" defaultValue={state}>
              <option value="all">All connected states</option>
              {allStateOptions().map(([code, name]) => <option value={code} key={code}>{code} — {name}</option>)}
            </select>
          </label>
          <label>
            <span>Results per page</span>
            <select name="limit" defaultValue={pageSize}>
              <option value="10">10</option>
              <option value="25">25</option>
              <option value="50">50</option>
            </select>
          </label>
          <label className={styles.archiveToggle}>
            <input type="checkbox" name="includeArchived" value="1" defaultChecked={includeArchived} />
            <span><strong>Include completed and cancelled</strong><small>Archived lifecycle records are hidden by default.</small></span>
          </label>
          <button type="submit">Search project leads</button>
        </form>
      </section>

      <section className={styles.pipelineNotes} aria-label="Lead pipeline visibility">
        <article>
          <span>Indexed</span>
          <strong>Connected project records</strong>
          <p>These appear below as soon as a source row is normalized and stored.</p>
        </article>
        <article>
          <span>Needs review</span>
          <strong>Company-posted opportunities</strong>
          <p>Incomplete monitored postings stay in the private review queue.</p>
          <Link href="/source-monitor">Open Source Monitor</Link>
        </article>
        <article>
          <span>Not loaded yet</span>
          <strong>Remaining source pages</strong>
          <p>A partial source window cannot list rows that ingestion has not reached yet.</p>
          <Link href="/coverage">Audit source coverage</Link>
        </article>
      </section>

      <section className={styles.results} aria-labelledby="lead-results-title">
        <header>
          <div>
            <p className={styles.eyebrow}>LEAD INVENTORY</p>
            <h2 id="lead-results-title">{search.meta.matchedProjects.toLocaleString("en-US")} connected project leads</h2>
          </div>
          <p>
            Showing {firstResult.toLocaleString("en-US")}–{lastResult.toLocaleString("en-US")}.
            Results are evidence-backed but may not be ready to bid.
          </p>
        </header>

        {search.meta.resultLimitReached ? (
          <div className={styles.warning} role="status">
            One or more live sources expose more rows than the current query window. Older
            materialized records are included, but this is not a complete source census yet.
          </div>
        ) : null}

        <div className={styles.leadList}>
          {search.projects.map((project) => {
            const reasons = projectLeadReasons(project);
            const owner = project.participants.find((participant) => participant.role === "owner");
            const contractor = project.participants.find((participant) => participant.role === "contractor");
            return (
              <article className={styles.leadCard} key={project.id}>
                <div className={styles.cardMain}>
                  <div className={styles.badges}>
                    <span>{STAGE_LABELS[project.stage]}</span>
                    <span>{project.confidence === "official" ? "Official record" : "Inferred signal"}</span>
                    <span>{project.state ?? "State pending"}</span>
                  </div>
                  <h3>{project.title}</h3>
                  <p className={styles.identity}>{project.agency} · {project.sourceRecordId}</p>
                  <p className={styles.summary}>{project.summary || "Published scope is incomplete."}</p>
                  <dl className={styles.facts}>
                    <div><dt>Location</dt><dd>{projectLocation(project)}</dd></div>
                    <div><dt>Published value</dt><dd>{money(project.value)}</dd></div>
                    <div><dt>Bid deadline</dt><dd>{project.bidDate ? formatBidDeadline(project.bidDate, project.bidDateTimeZone) : "Not published"}</dd></div>
                    <div><dt>Last source activity</dt><dd>{dateLabel(project.updatedAt)}</dd></div>
                    <div><dt>Named owner</dt><dd>{owner?.name ?? "Not published"}</dd></div>
                    <div><dt>Named GC</dt><dd>{contractor?.name ?? "Not published"}</dd></div>
                  </dl>
                  <div className={styles.gaps}>
                    <strong>Why this record needs research</strong>
                    <div>
                      {reasons.length
                        ? reasons.map((reason) => <span key={reason}>{REASON_LABELS[reason]}</span>)
                        : <span>Bid-ready record included by the selected filter</span>}
                    </div>
                  </div>
                </div>
                <aside className={styles.cardActions}>
                  <Link href={`/bid-desk?project=${encodeURIComponent(project.id)}`}>Research in Bid Desk</Link>
                  <a href={project.sourceUrl} target="_blank" rel="noreferrer">Open official evidence</a>
                  <small>{project.sourceName}</small>
                </aside>
              </article>
            );
          })}
        </div>

        {search.projects.length === 0 ? (
          <div className={styles.empty}>
            <strong>No connected records match these filters.</strong>
            <p>Broaden the lead condition, location, or stage. A no-match result does not prove the project does not exist outside connected source windows.</p>
          </div>
        ) : null}

        {search.meta.matchedProjects > 0 ? (
          <nav className={styles.pagination} aria-label="Project lead result pages">
            <span>Page {activePage} of {totalPages}</span>
            <div>
              {activePage > 1 ? <Link href={pageHref(hrefParams, activePage - 1)}>Previous</Link> : <span>Previous</span>}
              {activePage < totalPages ? <Link href={pageHref(hrefParams, activePage + 1)}>Next</Link> : <span>Next</span>}
            </div>
          </nav>
        ) : null}

        <p className={styles.truthNote}>
          Connected public records only. “Partial” describes the current evidence available to
          BidAtlas; it is not proof that the underlying public agency or project has no additional information.
        </p>
      </section>
    </main>
  );
}
