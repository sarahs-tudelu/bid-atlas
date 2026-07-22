"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { actionableBidDocuments } from "./lib/bid-readiness";
import { formatBidDeadline } from "./lib/deadline-time";
import type {
  BidDueFilter,
  ProjectRecord,
  SearchResultMeta,
} from "./lib/types";

export interface BidQueueInitialState {
  keywords: string;
  location: string;
  due: BidDueFilter;
}

interface BidQueueClientProps {
  mode: "home" | "projects";
  initialSearchPage: {
    projects: ProjectRecord[];
    meta: SearchResultMeta;
  };
  initialSearchState: BidQueueInitialState;
}

const DUE_LABELS: Record<BidDueFilter, string> = {
  all: "All open bids",
  today: "Due today",
  "7-days": "Next 7 days",
  "14-days": "Next 14 days",
};

function projectLocation(project: ProjectRecord): string {
  const locality = [project.city, project.county].filter(Boolean).join(", ");
  const region = [project.state, project.postalCode].filter(Boolean).join(" ");
  return [project.address, locality, region].filter(Boolean).join(" - ") || "Location published in bid record";
}

function deadlineLabel(project: ProjectRecord): string {
  return formatBidDeadline(project.bidDate, project.bidDateTimeZone);
}

function documentRouteLabel(document: ProjectRecord["documents"][number]): string {
  if (document.access === "free-account") return "Official portal sign-in required";
  if (document.indexStatus === "text-indexed") return "Indexed official file";
  try {
    const pathname = new URL(document.url).pathname.toLowerCase();
    if (/\.(?:pdf|zip|dwg|dxf|dgn|rvt|ifc|docx?|xlsx?)$/.test(pathname)) {
      return "Official file";
    }
  } catch {
    return "Official document route";
  }
  return "Official bid document page";
}

function searchParams(
  state: BidQueueInitialState,
  page: number,
  pageSize: number,
): URLSearchParams {
  const params = new URLSearchParams({
    keywords: state.keywords.trim(),
    location: state.location.trim(),
    match: "all",
    stage: "all",
    freshness: "actionable",
    due: state.due,
    readiness: "bid-ready",
    page: String(page),
    limit: String(pageSize),
  });
  if (!params.get("keywords")) params.delete("keywords");
  if (!params.get("location")) params.delete("location");
  if (state.due === "all") params.delete("due");
  params.delete("stage");
  params.delete("freshness");
  params.delete("readiness");
  if (page === 1) params.delete("page");
  if (pageSize === 10) params.delete("limit");
  return params;
}

function requestParams(
  state: BidQueueInitialState,
  page: number,
  pageSize: number,
): URLSearchParams {
  const params = searchParams(state, page, pageSize);
  params.set("readiness", "bid-ready");
  params.set("freshness", "actionable");
  params.set("page", String(page));
  params.set("limit", String(pageSize));
  return params;
}

function bidDeskUrl(project: ProjectRecord, action: "view" | "download"): string {
  return (
    "/bid-desk?project=" +
    encodeURIComponent(project.id) +
    "&drawings=" +
    action +
    "#project-drawings"
  );
}

export function BidQueueClient({
  mode,
  initialSearchPage,
  initialSearchState,
}: BidQueueClientProps) {
  const [keywords, setKeywords] = useState(initialSearchState.keywords);
  const [location, setLocation] = useState(initialSearchState.location);
  const [due, setDue] = useState(initialSearchState.due);
  const [projects, setProjects] = useState(initialSearchPage.projects);
  const [meta, setMeta] = useState(initialSearchPage.meta);
  const [pageSize, setPageSize] = useState(initialSearchPage.meta.pageSize ?? 10);
  const [page, setPage] = useState(initialSearchPage.meta.page ?? 1);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const currentState = (
    overrides: Partial<BidQueueInitialState> = {},
  ): BidQueueInitialState => ({
    keywords: overrides.keywords ?? keywords,
    location: overrides.location ?? location,
    due: overrides.due ?? due,
  });

  const navigateFromHome = (
    nextState: BidQueueInitialState,
    nextPage = 1,
    nextPageSize = pageSize,
  ) => {
    const params = searchParams(nextState, nextPage, nextPageSize);
    window.location.assign("/projects" + (params.size ? "?" + params.toString() : ""));
  };

  const fetchPage = async (
    nextPage: number,
    nextPageSize = pageSize,
    overrides: Partial<BidQueueInitialState> = {},
  ) => {
    const nextState = currentState(overrides);
    if (mode === "home") {
      navigateFromHome(nextState, nextPage, nextPageSize);
      return;
    }
    const activeRequest = ++requestId.current;
    setSearching(true);
    setError("");
    try {
      const params = requestParams(nextState, nextPage, nextPageSize);
      const response = await fetch("/api/search?" + params.toString(), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error("Search is temporarily unavailable.");
      }
      const body = (await response.json()) as {
        projects: ProjectRecord[];
        meta: SearchResultMeta;
      };
      if (requestId.current !== activeRequest) return;
      setProjects(body.projects);
      setMeta(body.meta);
      setPage(body.meta.page ?? nextPage);
      setPageSize(body.meta.pageSize ?? nextPageSize);
      const canonical = searchParams(
        nextState,
        body.meta.page ?? nextPage,
        body.meta.pageSize ?? nextPageSize,
      );
      window.history.replaceState(
        null,
        "",
        "/projects" + (canonical.size ? "?" + canonical.toString() : ""),
      );
    } catch (cause) {
      if (requestId.current !== activeRequest) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Search is temporarily unavailable.",
      );
    } finally {
      if (requestId.current === activeRequest) setSearching(false);
    }
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void fetchPage(1);
  };

  const chooseDue = (nextDue: BidDueFilter) => {
    setDue(nextDue);
    void fetchPage(1, pageSize, { due: nextDue });
  };

  const totalPages = Math.max(1, meta.totalPages ?? 1);
  const activePage = Math.min(meta.page ?? page, totalPages);
  const firstResult =
    meta.matchedProjects === 0 ? 0 : (activePage - 1) * pageSize + 1;
  const lastResult = Math.min(activePage * pageSize, meta.matchedProjects);

  return (
    <main className="bid-queue-route">
      <header className="topbar bid-queue-topbar">
        <Link className="brand" href="/" aria-label="BidAtlas home">
          <span className="brand-mark" aria-hidden="true">BA</span>
          <span>BidAtlas</span>
        </Link>
        <nav aria-label="Primary navigation">
          <Link className="topbar-link-active" href="/projects">Open bids</Link>
          <Link href="/companies">Companies</Link>
          <Link href="/bid-desk">Bid Desk</Link>
          <Link href="/coverage">Sources</Link>
          <Link href="/source-monitor">Monitor</Link>
        </nav>
      </header>

      <section className="bid-queue-hero">
        <p className="eyebrow">VERIFIED OPEN BIDS</p>
        <h1>Projects you can actually bid.</h1>
        <p>
          Every result has an official notice, a current due date, a published
          scope and location, and a real plans or specifications route.
        </p>
        <form className="bid-queue-search" role="search" onSubmit={submitSearch}>
          <label>
            <span>Product, trade, or scope</span>
            <input
              value={keywords}
              onChange={(event) => setKeywords(event.target.value)}
              placeholder="canopy, partition wall, lighting"
            />
          </label>
          <label>
            <span>Location</span>
            <input
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="city, county, ZIP, or state"
            />
          </label>
          <button type="submit" disabled={searching}>
            {searching ? "Searching..." : "Search open bids"}
          </button>
        </form>
        <div className="bid-queue-due" role="group" aria-label="Bid deadline">
          {(Object.keys(DUE_LABELS) as BidDueFilter[]).map((option) => (
            <button
              type="button"
              key={option}
              className={due === option ? "active" : undefined}
              aria-pressed={due === option}
              disabled={searching}
              onClick={() => chooseDue(option)}
            >
              {DUE_LABELS[option]}
            </button>
          ))}
        </div>
      </section>

      <section className="bid-queue-results" aria-labelledby="bid-queue-title">
        <header className="bid-queue-results__header">
          <div>
            <p className="eyebrow">BID QUEUE</p>
            <h2 id="bid-queue-title">
              {meta.matchedProjects.toLocaleString("en-US")} qualified open bids
            </h2>
          </div>
          <p>Permits, expired bids, inferred leads, and documentless notices are excluded.</p>
        </header>

        {error && <div className="search-error" role="alert">{error}</div>}

        <div className="bid-opportunity-list">
          {projects.map((project) => {
            const documents = actionableBidDocuments(project);
            return (
              <article className="bid-opportunity-card" key={project.id}>
                <div className="bid-opportunity-card__body">
                  <div className="bid-opportunity-card__due">
                    <span>Bid due</span>
                    <strong>{deadlineLabel(project)}</strong>
                  </div>
                  <p className="bid-opportunity-card__location">
                    {projectLocation(project)}
                  </p>
                  <h3>{project.title}</h3>
                  <p className="bid-opportunity-card__identity">
                    {project.agency} - Solicitation {project.sourceRecordId}
                  </p>
                  <p className="bid-opportunity-card__scope">{project.summary}</p>
                  <div className="bid-opportunity-card__documents">
                    <strong>Plans and bid documents</strong>
                    {documents.slice(0, 3).map((document) => (
                      <a
                        href={document.url}
                        target="_blank"
                        rel="noreferrer"
                        key={document.kind + ":" + document.url}
                      >
                        <span>{document.name}</span>
                        <small>{documentRouteLabel(document)}</small>
                      </a>
                    ))}
                  </div>
                </div>
                <div className="bid-opportunity-card__actions">
                  <Link className="bid-opportunity-card__primary" href={bidDeskUrl(project, "view")}>
                    View bid and plans
                  </Link>
                  <Link href={bidDeskUrl(project, "download")}>Download package</Link>
                  <a href={project.sourceUrl} target="_blank" rel="noreferrer">
                    Open official bid
                  </a>
                </div>
              </article>
            );
          })}
        </div>

        {projects.length === 0 && !searching && (
          <div className="bid-queue-empty">
            <strong>No qualified open bids match this search.</strong>
            <p>
              BidAtlas did not pad the result with permit records, expired
              opportunities, or notices without usable bid documents.
            </p>
          </div>
        )}

        {meta.matchedProjects > 0 && (
          <nav className="bid-queue-pagination" aria-label="Bid result pages">
            <p>
              Showing {firstResult.toLocaleString("en-US")}-
              {lastResult.toLocaleString("en-US")} of{" "}
              {meta.matchedProjects.toLocaleString("en-US")}
            </p>
            <label>
              <span>Per page</span>
              <select
                value={pageSize}
                disabled={searching}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setPageSize(next);
                  void fetchPage(1, next);
                }}
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
              </select>
            </label>
            <div>
              <button
                type="button"
                disabled={activePage <= 1 || searching}
                onClick={() => void fetchPage(activePage - 1)}
              >
                Previous
              </button>
              <span>Page {activePage} of {totalPages}</span>
              <button
                type="button"
                disabled={activePage >= totalPages || searching}
                onClick={() => void fetchPage(activePage + 1)}
              >
                Next
              </button>
            </div>
          </nav>
        )}

        <p className="bid-queue-truth">
          Connected official sources only. This queue is deliberately smaller
          than the raw public-record index and is not yet nationally complete.
        </p>
      </section>
    </main>
  );
}
