"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { BidDesk } from "./BidDesk";
import { DocumentsClient } from "./DocumentsClient";
import { JurisdictionExplorer } from "./JurisdictionExplorer";
import { allStateOptions } from "./lib/national-coverage";
import { matchedProjectTerms, parseKeywordInput, searchProjects } from "./lib/search";
import { formatBidDeadline } from "./lib/deadline-time";
import {
  classifyProjectFreshness,
  participantHasPublishedName,
  publishedParticipantName,
} from "./lib/outreach-intelligence";
import { isArchivedProjectStage } from "./lib/project-lifecycle";
import {
  REGISTRATION_FIELDS_REQUIRING_OWNER_CONFIRMATION,
  TUDELU_PUBLIC_PROFILE,
} from "./lib/company-profile";
import type {
  BidDueFilter,
  CoverageState,
  FreshnessFilter,
  ProjectFeed,
  ProjectRecord,
  ProjectStage,
  SearchMatch,
  SearchResultMeta,
  SourceRecord,
} from "./lib/types";

const stageLabels: Record<ProjectStage, string> = {
  planning: "Early planning",
  design: "Design / plan review",
  permitting: "Permitting",
  bidding: "Bidding / solicitation",
  "bid-opened": "Bids opened",
  awarded: "Awarded",
  construction: "Construction",
  completed: "Completed / closed",
  cancelled: "Cancelled / inactive",
  unclassified: "Unclassified source status",
};

const stageOrder: ProjectStage[] = [
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

export type DashboardView = "overview" | "projects" | "documents" | "bid-desk" | "coverage";

interface DashboardClientProps {
  feed: ProjectFeed;
  view?: DashboardView;
  initialProjectId?: string;
  initialDrawingAction?: "view" | "download";
  initialDocumentProjectId?: string;
  initialDocumentSourceId?: string;
  initialDocumentSearch?: {
    query: string;
    documentType: string;
    processingStatus: string;
    publicOnly: boolean;
    page: number;
    pageSize: number;
  };
  initialSearchPage?: {
    projects: ProjectRecord[];
    meta: SearchResultMeta;
  };
  initialSearchState?: {
    keywords: string;
    location: string;
    match: SearchMatch;
    stage: ProjectStage | "all";
    state: string;
    freshness: FreshnessFilter;
    due: BidDueFilter;
    includeArchived: boolean;
  };
}

interface SearchRequestOverrides {
  keywords?: string;
  location?: string;
  match?: SearchMatch;
  stage?: ProjectStage | "all";
  state?: string;
  freshness?: FreshnessFilter;
  due?: BidDueFilter;
  includeArchived?: boolean;
}

const freshnessLabels: Record<FreshnessFilter, string> = {
  all: "All ages and statuses (including stale)",
  actionable: "Actionable (new or current)",
  new: "New",
  current: "Current",
  stale: "Stale — verify",
  "closed-or-inactive": "Closed or inactive",
  closed: "Closed opportunity",
  inactive: "Inactive",
  unclassified: "Unclassified",
};

const dueLabels: Record<BidDueFilter, string> = {
  all: "All published deadlines",
  today: "Due today",
  "7-days": "Due in the next 7 days",
  "14-days": "Due in the next 14 days",
};

function money(value?: number): string {
  if (value === undefined) return "Value not published";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toLocaleString()}`;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function shortDate(value?: string): string {
  if (!value) return "Not published";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= 86_400_000) return "Not published";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(timestamp),
  );
}

function publishedEmail(value?: string): string | undefined {
  const email = value?.trim();
  return email && email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
    ? email
    : undefined;
}

function publishedPhone(value?: string): string | undefined {
  const phone = value?.trim();
  return phone && phone.length <= 80 && phone.replace(/\D/g, "").length >= 10
    ? phone
    : undefined;
}

function location(project: ProjectRecord): string {
  const locality = [
    project.city,
    project.county && !project.city ? `${project.county} County` : undefined,
    project.state,
    project.postalCode,
  ]
    .filter(Boolean)
    .join(", ");
  return [project.address, locality].filter(Boolean).join(" - ") || "Location in source record";
}

function sourceStatusLabel(source: SourceRecord): string {
  if (source.status === "credential-required") return "Free key needed";
  if (source.status === "degraded") return "Retrying";
  if (source.status === "registry") {
    if (source.snapshotComplete) return "Registry snapshot verified";
    return (source.loadedCount ?? 0) > 0
      ? "Registry imported; active-row discovery queued"
      : "Registry import pending";
  }
  return source.snapshotComplete ? "Complete snapshot" : "Live partial window";
}

function projectRecordLane(source: SourceRecord | undefined): string {
  if (!source) return "Public-source record";
  if (source.sourceClass === "permits") return "Building permit / plan review";
  if (source.sourceClass === "planning" || source.sourceClass === "capital-plans") {
    return "Planning / development record";
  }
  if (source.sourceClass === "procurement") return "Public bid / solicitation";
  if (source.sourceClass === "awards" || source.sourceClass === "bid-results") {
    return "Award / bid result";
  }
  if (source.sourceClass === "documents") return "Project document record";
  return "Public-source record";
}

function publishedParticipantHeading(participants: ProjectRecord["participants"]): {
  title: string;
  detail: string;
} {
  const namedParticipants = participants.filter(participantHasPublishedName);
  const namedDirectChannels = namedParticipants.filter(
    (participant) => publishedEmail(participant.email) || publishedPhone(participant.phone),
  ).length;
  const unnamedDirectChannels = participants.filter(
    (participant) =>
      !participantHasPublishedName(participant) &&
      Boolean(publishedEmail(participant.email) || publishedPhone(participant.phone)),
  ).length;
  if (namedDirectChannels > 0) {
    return {
      title: "Named contacts with published direct channels",
      detail: `${namedDirectChannels.toLocaleString("en-US")} named contact${namedDirectChannels === 1 ? " has" : "s have"} an email or phone in the official record${unnamedDirectChannels ? `; ${unnamedDirectChannels.toLocaleString("en-US")} additional channel${unnamedDirectChannels === 1 ? " has" : "s have"} no published name` : ""}`,
    };
  }
  if (unnamedDirectChannels > 0) {
    return {
      title: "Published contact channels — names missing",
      detail: `${unnamedDirectChannels.toLocaleString("en-US")} email or phone route${unnamedDirectChannels === 1 ? " is" : "s are"} published without a named person or organization`,
    };
  }
  if (namedParticipants.length > 0 && namedParticipants.every((participant) => participant.role === "agency")) {
    return {
      title: "Publishing agency only — no direct contact",
      detail: "Agency participant is named; no email or phone is published",
    };
  }
  if (namedParticipants.length > 0) {
    return {
      title: "Named project participants — no direct contact",
      detail: "Names are from the official record; email and phone are missing",
    };
  }
  return {
    title: "No published project contacts",
    detail: "Not in the current source record",
  };
}

function coverageLabel(status: CoverageState): string {
  if (status === "connected") return "Required adapters active";
  if (status === "partial") return "Some adapters active";
  if (status === "identified") return "Source identified";
  if (status === "credential-required") return "Key/account";
  if (status === "not-public") return "Not public";
  return "Gap";
}

export function DashboardClient({
  feed,
  view = "overview",
  initialProjectId,
  initialDrawingAction,
  initialDocumentProjectId,
  initialDocumentSourceId,
  initialDocumentSearch,
  initialSearchPage,
  initialSearchState,
}: DashboardClientProps) {
  const [keywordInput, setKeywordInput] = useState(initialSearchState?.keywords ?? "");
  const [locationQuery, setLocationQuery] = useState(initialSearchState?.location ?? "");
  const [match, setMatch] = useState<SearchMatch>(initialSearchState?.match ?? "all");
  const [stage, setStage] = useState<ProjectStage | "all">(initialSearchState?.stage ?? "all");
  const [state, setState] = useState(initialSearchState?.state ?? "all");
  const [freshness, setFreshness] = useState<FreshnessFilter>(
    initialSearchState?.freshness ?? (view === "projects" ? "actionable" : "all"),
  );
  const [due, setDue] = useState<BidDueFilter>(initialSearchState?.due ?? "all");
  const [includeArchived, setIncludeArchived] = useState(
    initialSearchState?.includeArchived ?? false,
  );
  const [serverResults, setServerResults] = useState<ProjectRecord[] | null>(
    initialSearchPage?.projects ?? null,
  );
  const [serverSearchMeta, setServerSearchMeta] = useState<SearchResultMeta | null>(
    initialSearchPage?.meta ?? null,
  );
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [pageSize, setPageSize] = useState(initialSearchPage?.meta.pageSize ?? 10);
  const [currentPage, setCurrentPage] = useState(initialSearchPage?.meta.page ?? 1);
  const searchRequestId = useRef(0);
  const [selectedBidProjectId, setSelectedBidProjectId] = useState<string | undefined>(
    () =>
      feed.projects.some((project) => project.id === initialProjectId)
        ? initialProjectId
        : feed.projects.find((project) => project.stage === "bidding")?.id ?? feed.projects[0]?.id,
  );

  const keywordTerms = useMemo(() => parseKeywordInput(keywordInput), [keywordInput]);
  const filtered = useMemo(
    () =>
      searchProjects(feed.projects, {
        keywords: keywordTerms,
        location: locationQuery,
        match,
        stage,
        state,
        freshness,
        due,
        includeArchived,
      }),
    [feed.projects, keywordTerms, locationQuery, match, stage, state, freshness, due, includeArchived],
  );

  const stageCounts = useMemo(
    () =>
      feed.inventory?.stageCounts ??
      (Object.fromEntries(
        stageOrder.map((stageName) => [
          stageName,
          feed.projects.filter((project) => project.stage === stageName).length,
        ]),
      ) as Record<ProjectStage, number>),
    [feed.inventory?.stageCounts, feed.projects],
  );

  const liveSources = feed.sources.filter((source) => source.status === "live").length;
  const allLoadedProjects = feed.inventory?.totalProjects ?? feed.projects.length;
  const activeLoadedProjects = Math.max(
    0,
    allLoadedProjects - (stageCounts.completed ?? 0) - (stageCounts.cancelled ?? 0),
  );
  const visibleLoadedProjects = includeArchived ? allLoadedProjects : activeLoadedProjects;
  const displayedProjects = serverResults ?? filtered;
  const serverPaged = serverResults !== null && serverSearchMeta !== null;
  const totalProjectMatches = serverPaged
    ? serverSearchMeta.matchedProjects
    : displayedProjects.length;
  const totalPages = serverPaged
    ? Math.max(1, serverSearchMeta.totalPages ?? Math.ceil(totalProjectMatches / pageSize))
    : Math.max(1, Math.ceil(totalProjectMatches / pageSize));
  const activePage = serverPaged
    ? Math.min(serverSearchMeta.page ?? currentPage, totalPages)
    : Math.min(currentPage, totalPages);
  const pageStart = totalProjectMatches ? (activePage - 1) * pageSize : 0;
  const paginatedProjects = serverPaged
    ? displayedProjects
    : displayedProjects.slice(pageStart, pageStart + pageSize);
  const pageEnd = pageStart + paginatedProjects.length;
  const sourceReportedRecords = feed.sources
    .filter((source) => source.level !== "registry")
    .reduce((sum, source) => sum + source.recordCount, 0);
  const contractors =
    feed.inventory?.contractorOrganizations ??
    new Set(
      feed.projects.flatMap((project) =>
        project.participants
          .filter(
            (participant) =>
              participant.role === "contractor" || participant.role === "bidder",
          )
          .map((participant) => participant.name),
      ),
    ).size;
  const nycCityRecordLive = feed.sources.some(
    (source) =>
      source.id === "nyc-city-record-construction-procurement" && source.status === "live",
  );
  const livePermitSources = feed.sources.filter(
    (source) => source.sourceClass === "permits" && source.status === "live",
  );

  const clearSearch = () => {
    const resetFreshness: FreshnessFilter = view === "projects" ? "actionable" : "all";
    searchRequestId.current += 1;
    setKeywordInput("");
    setLocationQuery("");
    setMatch("all");
    setStage("all");
    setState("all");
    setFreshness(resetFreshness);
    setDue("all");
    setIncludeArchived(false);
    setSearchError("");
    setSearching(false);
    setPageSize(10);
    setCurrentPage(1);
    if (view === "projects") {
      void fetchConnectedPage(1, 10, {
        keywords: "",
        location: "",
        match: "all",
        stage: "all",
        state: "all",
        freshness: resetFreshness,
        due: "all",
        includeArchived: false,
      });
    } else {
      setServerResults(null);
      setServerSearchMeta(null);
    }
  };

  const resetServerSearch = () => {
    searchRequestId.current += 1;
    setServerResults(null);
    setServerSearchMeta(null);
    setSearchError("");
    setSearching(false);
    setCurrentPage(1);
  };

  const fetchConnectedPage = async (
    requestedPage: number,
    requestedPageSize: number,
    overrides: SearchRequestOverrides = {},
  ) => {
    const requestId = searchRequestId.current + 1;
    searchRequestId.current = requestId;
    setSearching(true);
    setSearchError("");
    try {
      const activeSearch = {
        keywords: overrides.keywords ?? keywordInput,
        location: overrides.location ?? locationQuery,
        match: overrides.match ?? match,
        stage: overrides.stage ?? stage,
        state: overrides.state ?? state,
        freshness: overrides.freshness ?? freshness,
        due: overrides.due ?? due,
        includeArchived: overrides.includeArchived ?? includeArchived,
      };
      const params = new URLSearchParams({
        keywords: activeSearch.keywords,
        location: activeSearch.location,
        match: activeSearch.match,
        stage: activeSearch.stage,
        state: activeSearch.state,
        freshness: activeSearch.freshness,
        due: activeSearch.due,
        page: String(requestedPage),
        limit: String(requestedPageSize),
      });
      if (activeSearch.includeArchived) params.set("includeArchived", "1");
      const response = await fetch(`/api/search?${params}`);
      if (!response.ok) throw new Error(`Search failed with status ${response.status}`);
      const body = (await response.json()) as { projects: ProjectRecord[]; meta: SearchResultMeta };
      if (searchRequestId.current !== requestId) return;
      setServerResults(body.projects);
      setServerSearchMeta(body.meta);
      setPageSize(body.meta.pageSize ?? requestedPageSize);
      setCurrentPage(body.meta.page ?? requestedPage);
      if (view === "projects" && typeof window !== "undefined") {
        const canonical = new URLSearchParams();
        if (activeSearch.keywords.trim()) canonical.set("keywords", activeSearch.keywords.trim());
        if (activeSearch.location.trim()) canonical.set("location", activeSearch.location.trim());
        if (activeSearch.match !== "all") canonical.set("match", activeSearch.match);
        if (activeSearch.stage !== "all") canonical.set("stage", activeSearch.stage);
        if (activeSearch.state !== "all") canonical.set("state", activeSearch.state);
        if (
          activeSearch.freshness !== "actionable" ||
          (activeSearch.stage !== "all" && isArchivedProjectStage(activeSearch.stage))
        ) canonical.set("freshness", activeSearch.freshness);
        if (activeSearch.due !== "all") canonical.set("due", activeSearch.due);
        if (activeSearch.includeArchived) canonical.set("includeArchived", "1");
        const responsePage = body.meta.page ?? requestedPage;
        const responsePageSize = body.meta.pageSize ?? requestedPageSize;
        if (responsePage > 1) canonical.set("page", String(responsePage));
        if (responsePageSize !== 10) canonical.set("limit", String(responsePageSize));
        const nextUrl = `/projects${canonical.size ? `?${canonical}` : ""}`;
        window.history.replaceState(window.history.state, "", nextUrl);
      }
    } catch (error) {
      if (searchRequestId.current !== requestId) return;
      setSearchError(error instanceof Error ? error.message : "Search failed");
      setServerResults(null);
      setServerSearchMeta(null);
      setCurrentPage(1);
    } finally {
      if (searchRequestId.current === requestId) setSearching(false);
    }
  };

  const runConnectedSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void fetchConnectedPage(1, pageSize);
  };

  const goToPage = (nextPage: number) => {
    const boundedPage = Math.max(1, Math.min(totalPages, nextPage));
    if (serverPaged) {
      void fetchConnectedPage(boundedPage, pageSize);
    } else {
      setCurrentPage(boundedPage);
    }
  };

  const setConnectedStage = (nextStage: ProjectStage | "all") => {
    const terminalStage = nextStage !== "all" && isArchivedProjectStage(nextStage);
    const nextIncludeArchived =
      includeArchived || terminalStage;
    const nextFreshness: FreshnessFilter = terminalStage ? "all" : freshness;
    setStage(nextStage);
    if (nextIncludeArchived !== includeArchived) setIncludeArchived(nextIncludeArchived);
    if (nextFreshness !== freshness) setFreshness(nextFreshness);
    if (view === "projects") {
      void fetchConnectedPage(1, pageSize, {
        stage: nextStage,
        freshness: nextFreshness,
        includeArchived: nextIncludeArchived,
      });
    } else {
      resetServerSearch();
    }
  };

  const setConnectedMatch = (nextMatch: SearchMatch) => {
    setMatch(nextMatch);
    if (view === "projects") {
      void fetchConnectedPage(1, pageSize, { match: nextMatch });
    } else {
      resetServerSearch();
    }
  };

  const setConnectedState = (nextState: string) => {
    setState(nextState);
    if (view === "projects") {
      void fetchConnectedPage(1, pageSize, { state: nextState });
    } else {
      resetServerSearch();
    }
  };

  const setConnectedFreshness = (nextFreshness: FreshnessFilter) => {
    setFreshness(nextFreshness);
    if (view === "projects") {
      void fetchConnectedPage(1, pageSize, { freshness: nextFreshness });
    } else {
      resetServerSearch();
    }
  };

  const setConnectedDue = (nextDue: BidDueFilter) => {
    setDue(nextDue);
    if (view === "projects") {
      void fetchConnectedPage(1, pageSize, { due: nextDue });
    } else {
      resetServerSearch();
    }
  };

  const setConnectedIncludeArchived = (nextIncludeArchived: boolean) => {
    const nextStage =
      !nextIncludeArchived && stage !== "all" && isArchivedProjectStage(stage)
        ? "all"
        : stage;
    const nextFreshness: FreshnessFilter = nextIncludeArchived ? "all" : freshness;
    setIncludeArchived(nextIncludeArchived);
    if (nextStage !== stage) setStage(nextStage);
    if (nextFreshness !== freshness) setFreshness(nextFreshness);
    if (view === "projects") {
      void fetchConnectedPage(1, pageSize, {
        stage: nextStage,
        freshness: nextFreshness,
        includeArchived: nextIncludeArchived,
      });
    } else {
      resetServerSearch();
    }
  };

  return (
    <main className={`dashboard-route dashboard-route--${view}`}>
      <header className="topbar">
        <Link className="brand" href="/" aria-label="BidAtlas home">
          <span className="brand-mark" aria-hidden="true">BA</span>
          <span>BidAtlas</span>
        </Link>
        <nav aria-label="Primary navigation">
          <Link className={view === "overview" ? "topbar-link-active" : undefined} href="/" aria-current={view === "overview" ? "page" : undefined}>Overview</Link>
          <Link className={view === "projects" ? "topbar-link-active" : undefined} href="/projects" aria-current={view === "projects" ? "page" : undefined}>Projects</Link>
          <Link href="/leads">Leads</Link>
          <Link href="/companies">Companies</Link>
          <Link className={view === "documents" ? "topbar-link-active" : undefined} href="/documents" aria-current={view === "documents" ? "page" : undefined}>Documents</Link>
          <Link className={view === "bid-desk" ? "topbar-link-active" : undefined} href="/bid-desk" aria-current={view === "bid-desk" ? "page" : undefined}>Bid Desk</Link>
          <Link className={view === "coverage" ? "topbar-link-active" : undefined} href="/coverage" aria-current={view === "coverage" ? "page" : undefined}>Coverage</Link>
          <Link href="/integrations">Integrations</Link>
        </nav>
        <span className="pilot-pill pilot-warning"><span aria-hidden="true" />Not nationally complete</span>
      </header>

      <section className="truth-banner" role="status">
        <strong>Connected public records only:</strong> project counts are not national totals.
      </section>

      {view === "overview" && (
        <>
      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">PUBLIC-RECORD CONSTRUCTION INTELLIGENCE</p>
          <h1>Find the project.<br />Find what it needs.</h1>
          <p className="hero-text">
            Search publicly available records for private residential, private commercial, and public
            construction. Plan and specification text becomes searchable only after the file is lawfully
            collected and extracted.
          </p>
          <div className="hero-actions" aria-label="Start a project search">
            <Link className="hero-action-primary" href="/projects?keywords=residential&match=all">
              Find private homes
            </Link>
            <Link href="/projects?keywords=commercial&match=all">
              Find commercial projects
            </Link>
            <Link className="hero-action-tertiary" href="/projects">
              Search all projects
            </Link>
          </div>
          <small className="hero-actions-note">
            Searches connected public permit and plan-review records. Coverage is not yet nationwide.
          </small>
        </div>
        <div className="hero-pulse" aria-label="Current indexed-data status">
          <div className="pulse-top">
            <span>Active public-source index</span>
            <span className="limited-dot">Partial</span>
          </div>
          <strong>{activeLoadedProjects.toLocaleString("en-US")}</strong>
          <p>active materialized records in the queryable public-source inventory - not a national total</p>
          <div className="pulse-grid">
            <div><b>{liveSources}</b><span>live source connectors</span></div>
            <div><b>{compactNumber(sourceReportedRecords)}</b><span>records reported in source windows</span></div>
            <div><b>{contractors}</b><span>known contractor or bidder organizations across loaded records</span></div>
          </div>
          <small>Refreshed {shortDate(feed.generatedAt)} - provenance retained on every record</small>
        </div>
      </section>

      <section className="scope-strip" aria-label="Coverage scope">
        <div><b>{feed.coverage.localGovernmentUniverse.toLocaleString("en-US")}</b><span>local governments in the Census target</span></div>
        <div><b>{feed.coverage.registryRowsAvailable.toLocaleString("en-US")}</b><span>government and dependent-agency rows importable</span></div>
        <div><b>{feed.coverage.statesAndDistrict}</b><span>states and DC tracked</span></div>
        <div><b>{feed.coverage.documentTextIndexedProjects}</b><span>projects with plan/spec text indexed</span></div>
      </section>

      <section className="onboarding-strip" aria-label="Supplier portal onboarding">
        <div>
          <p className="eyebrow">ONE-TIME SUPPLIER PROFILE</p>
          <h2>{TUDELU_PUBLIC_PROFILE.legalName}</h2>
          <p>{TUDELU_PUBLIC_PROFILE.addressLine1}, {TUDELU_PUBLIC_PROFILE.city}, {TUDELU_PUBLIC_PROFILE.state} {TUDELU_PUBLIC_PROFILE.postalCode} - {TUDELU_PUBLIC_PROFILE.phone} - {TUDELU_PUBLIC_PROFILE.publicEmail}</p>
        </div>
        <div className="profile-products">
          {TUDELU_PUBLIC_PROFILE.products.map((product) => <span key={product}>{product}</span>)}
        </div>
        <div className="profile-status">
          <b>Public fields prefilled</b>
          <span>{REGISTRATION_FIELDS_REQUIRING_OWNER_CONFIRMATION.length} protected/attested field groups requested only when a portal needs them</span>
          <a href={TUDELU_PUBLIC_PROFILE.sourceUrl} target="_blank" rel="noreferrer">Verified from Tudelu ↗</a>
        </div>
      </section>

      <nav className="overview-route-cards" aria-label="BidAtlas work areas">
        <Link href="/projects?keywords=residential&match=all">
          <span>01</span>
          <strong>Find private homes &amp; residential projects</strong>
          <small>Search connected permit and plan-review records by location, stage, and product.</small>
        </Link>
        <Link href="/leads">
          <span>02</span>
          <strong>Research partial project leads</strong>
          <small>See permit, planning, construction, expired, and incomplete records with their missing evidence.</small>
        </Link>
        <Link href="/bid-desk">
          <span>03</span>
          <strong>Build a bid package</strong>
          <small>Review stakeholders, price a scope, and prepare a controlled delivery draft.</small>
        </Link>
        <Link href="/companies">
          <span>04</span>
          <strong>Find owners and contractors</strong>
          <small>Search NY/NJ company-role evidence and verify businesses in official public registries.</small>
        </Link>
        <Link href="/documents">
          <span>05</span>
          <strong>Search plans and specifications</strong>
          <small>Find product terms in verified metadata and lawfully extracted document text.</small>
        </Link>
        <Link href="/coverage">
          <span>06</span>
          <strong>Audit source coverage</strong>
          <small>See active source adapters, known gaps, and the 51-state buildout ledger.</small>
        </Link>
      </nav>
      <section className="overview-deadline-links" aria-labelledby="overview-deadline-title">
        <div>
          <p className="eyebrow">LIVE DEADLINE DESK</p>
          <h2 id="overview-deadline-title">Open the bids that need attention now.</h2>
        </div>
        <nav aria-label="Project deadline shortcuts">
          <Link href="/projects?due=today">Due today</Link>
          <Link href="/projects?due=7-days">Next 7 days</Link>
          <Link href="/projects?due=14-days">Next 14 days</Link>
        </nav>
      </section>
        </>
      )}

      {view === "projects" && (
        <>
      <section className="lifecycle-wrap">
        <div className="lifecycle-caption">
          Indexed inventory snapshot by stage. Live source matches and exact totals appear in the search below; completed and cancelled records stay archived unless included.
        </div>
        <div className="lifecycle" aria-label="Indexed inventory lifecycle filters">
          <button className={stage === "all" ? "active" : ""} onClick={() => setConnectedStage("all")}>
            <span>{includeArchived ? "All including archived" : "All active"}</span>
            <b>{visibleLoadedProjects}</b>
          </button>
          {stageOrder.map((stageName) => (
            <button
              key={stageName}
              className={stage === stageName ? "active" : ""}
              onClick={() => setConnectedStage(stageName)}
            >
              <span>{stageLabels[stageName]}</span><b>{stageCounts[stageName]}</b>
            </button>
          ))}
        </div>
      </section>

      <section className="workspace workspace-route-projects" id="projects">
        <div className="project-column">
          <div className="section-heading">
            <div>
              <p className="eyebrow">PROJECT + PRODUCT SEARCH</p>
              <h2>{totalProjectMatches.toLocaleString("en-US")} matches {serverSearchMeta ? "across queried sources" : "in loaded records"}</h2>
            </div>
            <p>Use commas for separate product phrases. Example: canopy, &quot;partition wall&quot;, lighting.</p>
          </div>

          <div className="deadline-quick-filters" role="group" aria-label="Bid deadline window">
            {(Object.keys(dueLabels) as BidDueFilter[]).map((option) => (
              <button
                type="button"
                key={option}
                className={due === option ? "active" : undefined}
                aria-pressed={due === option}
                onClick={() => setConnectedDue(option)}
                disabled={searching}
              >
                {dueLabels[option]}
              </button>
            ))}
          </div>

          {nycCityRecordLive && (
            <div className="city-portal-callout">
              <div>
                <strong>New York City procurement notices are connected.</strong>
                <span>Current City Record deadlines and published contacts load daily. Services, goods, and construction categories stay in the universe so design and renovation work is not dropped. Some bid books, plans, drawings, and specifications require the portal named in the source record.</span>
              </div>
              <div>
                <a href="https://a856-cityrecord.nyc.gov/Visitor/LogIn" target="_blank" rel="noreferrer">City Record sign-in</a>
                <a href="https://www.nyc.gov/site/mocs/passport/articles/create-passport-account.page" target="_blank" rel="noreferrer">Create PASSPort account</a>
              </div>
            </div>
          )}

          {livePermitSources.length > 0 && (
            <div className="city-portal-callout">
              <div>
                <strong>Private residential and commercial construction is included.</strong>
                <span>
                  {livePermitSources.length.toLocaleString("en-US")} live permit or plan-review source{livePermitSources.length === 1 ? "" : "s"} now expose publicly filed private and commercial work. A permit row does not guarantee that plan sheets, a homeowner, an architect, or a contractor are publicly downloadable; each missing field remains labeled as a gap.
                </span>
              </div>
              <div>
                <Link href="/projects?keywords=residential">
                  Residential projects
                </Link>
                <Link href="/projects?keywords=commercial">
                  Commercial projects
                </Link>
              </div>
            </div>
          )}

          <form className="search-panel" role="search" onSubmit={runConnectedSearch}>
            <label className="keyword-field">
              <span>Products, materials, systems, or project terms</span>
              <input
                value={keywordInput}
                onChange={(event) => { setKeywordInput(event.target.value); resetServerSearch(); }}
                placeholder={'canopy, "partition wall", architectural lighting'}
              />
            </label>
            <label>
              <span>Location</span>
              <input
                value={locationQuery}
                onChange={(event) => { setLocationQuery(event.target.value); resetServerSearch(); }}
                placeholder="city, county, address, ZIP, or state"
              />
            </label>
            <label>
              <span>Project stage</span>
              <select value={stage} onChange={(event) => setConnectedStage(event.target.value as ProjectStage | "all")}>
                <option value="all">All project stages</option>
                {stageOrder.map((stageName) => (
                  <option key={stageName} value={stageName}>{stageLabels[stageName]}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Freshness / lifecycle</span>
              <select
                value={freshness}
                onChange={(event) => setConnectedFreshness(event.target.value as FreshnessFilter)}
              >
                {(["actionable", "new", "current", "stale", "unclassified", "closed-or-inactive", "all"] as FreshnessFilter[]).map((option) => (
                  <option key={option} value={option}>{freshnessLabels[option]}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Keyword rule</span>
              <select value={match} onChange={(event) => setConnectedMatch(event.target.value as SearchMatch)}>
                <option value="all">Match all terms</option>
                <option value="any">Match any term</option>
                <option value="phrase">Exact normalized phrase</option>
              </select>
            </label>
            <label>
              <span>State</span>
              <select value={state} onChange={(event) => setConnectedState(event.target.value)}>
                <option value="all">All states</option>
                {allStateOptions().map(([code, name]) => (
                  <option key={code} value={code}>{code} - {name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Bid deadline</span>
              <select value={due} onChange={(event) => setConnectedDue(event.target.value as BidDueFilter)}>
                {(Object.keys(dueLabels) as BidDueFilter[]).map((option) => (
                  <option key={option} value={option}>{dueLabels[option]}</option>
                ))}
              </select>
            </label>
            <label className="project-archive-toggle">
              <input
                type="checkbox"
                checked={includeArchived}
                disabled={searching}
                onChange={(event) => setConnectedIncludeArchived(event.target.checked)}
              />
              <span>
                <strong>Include completed/cancelled</strong>
                <small>Off by default. Awards and construction remain active.</small>
              </span>
            </label>
            <button className="connected-search-button" type="submit" disabled={searching}>
              {searching ? "Searching queryable public sources..." : "Search queryable public records"}
            </button>
          </form>

          <div className="search-scope-note">
            <span className="mini-dot key" />
            <p>
              {serverSearchMeta
                ? `This search checked ${serverSearchMeta.searchedProjects.toLocaleString("en-US")} indexed or live-fallback metadata records${serverSearchMeta.sourceQueryableRecords !== undefined ? ` across ${serverSearchMeta.sourceQueryableRecords.toLocaleString("en-US")} loaded source-window rows` : ""}${serverSearchMeta.sourceReportedMatches !== undefined ? `; the connected sources report ${serverSearchMeta.sourceReportedMatches.toLocaleString("en-US")} rows before search facets` : ""}. `
                : `Search currently covers ${visibleLoadedProjects.toLocaleString("en-US")} ${includeArchived ? "active and archived" : "active"} metadata rows. `}
              {(serverSearchMeta?.documentTextIndexedProjects ?? feed.coverage.documentTextIndexedProjects).toLocaleString("en-US")} extracted plan/spec corpora are searchable.
              A no-match result does not prove the product is absent from uncollected or unindexed documents.
            </p>
          </div>

          {searchError && <div className="search-error" role="alert">{searchError}. Loaded-record filtering remains available.</div>}
          {serverSearchMeta?.resultLimitReached && (
            <div className="search-warning" role="status">
              The full-source adapter reports more matching rows than this bounded live window can
              return. These pages are partial until the remaining rows are materialized into the
              persisted index; counts and page totals below cover loaded matches only, and Last loaded
              is not the end of the public source.
            </div>
          )}

          <div className="project-list">
            {paginatedProjects.map((project) => {
              const source = feed.sources.find((candidate) => candidate.id === project.sourceId);
              const participantHeading = publishedParticipantHeading(project.participants);
              const matchedTerms = keywordTerms.length
                ? matchedProjectTerms(project, {
                    keywords: keywordTerms,
                    location: locationQuery,
                    match,
                    stage,
                    state,
                    freshness,
                    due,
                    includeArchived,
                  })
                : [];
              const freshnessAssessment = classifyProjectFreshness(project, feed.generatedAt);
              return (
                <article className="project-card" key={project.id}>
                  <div className="project-main">
                    <div className="project-flags">
                      <span className={`stage-badge stage-${project.stage}`}>{stageLabels[project.stage]}</span>
                      <span className={`freshness-badge freshness-${freshnessAssessment.freshness}`}>
                        {freshnessAssessment.label}
                      </span>
                      <span className="source-badge">{projectRecordLane(source)}</span>
                      <span className="source-badge">{project.confidence === "official" ? "Official record" : "Early signal - inferred"}</span>
                      <span className="index-badge">{project.documentTextIndexed ? "Documents searchable" : "Metadata searchable"}</span>
                    </div>
                    <h3>
                      <Link className="project-title-link" href={`/bid-desk?project=${encodeURIComponent(project.id)}`}>
                        {project.title}
                      </Link>
                    </h3>
                    <p className="project-summary">{project.summary}</p>
                    {matchedTerms.length > 0 && (
                      <div className="matched-terms" aria-label="Matched search terms">
                        {matchedTerms.map((term) => <span key={term}>Matched: {term}</span>)}
                      </div>
                    )}
                    <dl className="project-facts">
                      <div><dt>Location</dt><dd>{location(project)}</dd></div>
                      <div><dt>Publishing agency / named owner</dt><dd>{project.agency}</dd></div>
                      <div><dt>{project.stage === "bidding" ? "Bid cutoff" : "Published value"}</dt><dd>{project.stage === "bidding" ? formatBidDeadline(project.bidDate, project.bidDateTimeZone) : money(project.value)}</dd></div>
                    </dl>
                    <section className="project-contacts" aria-label="Published project contacts">
                      <div className="project-contacts__heading">
                        <strong>{participantHeading.title}</strong>
                        <span>{participantHeading.detail}</span>
                      </div>
                      {project.participants.length > 0 ? (
                        <div className="participants">
                          {project.participants.slice(0, 4).map((participant, index) => {
                            const email = publishedEmail(participant.email);
                            const phone = publishedPhone(participant.phone);
                            return (
                              <article key={`${participant.role}:${participant.name}:${index}`}>
                                <small>{participant.role}</small>
                                <strong>{publishedParticipantName(participant) ?? "Name not published"}</strong>
                                {!participantHasPublishedName(participant) && (
                                  <span>Official contact channel only — verify the recipient before outreach</span>
                                )}
                                {participant.organization && participant.organization !== participant.name && (
                                  <span>{participant.organization}</span>
                                )}
                                <div>
                                  {email && <a href={`mailto:${email}`}>Email</a>}
                                  {phone && <a href={`tel:${phone.replace(/[^\d+]/g, "")}`}>{phone}</a>}
                                  {participant.sourceUrl && <a href={participant.sourceUrl} target="_blank" rel="noreferrer">Evidence</a>}
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="project-contacts__empty">Open Bid Desk to run source-backed contact research for the owner, architect, agency, or contractor.</p>
                      )}
                    </section>
                  </div>
                  <div className="project-side">
                    <p className="record-id">{project.sourceRecordId}</p>
                    <p className="project-status">{project.status}</p>
                    <div className="document-links">
                      {project.documents.slice(0, 3).map((document) => (
                        <a href={document.url} target="_blank" rel="noreferrer" key={`${document.kind}:${document.url}`}>
                          <span>{document.name}</span>
                          <small>{document.access === "public" ? "Public" : "Sign-in required"} ↗</small>
                        </a>
                      ))}
                    </div>
                    <div className="project-drawing-actions" aria-label="Project drawing actions">
                      <Link
                        href={`/bid-desk?project=${encodeURIComponent(project.id)}&drawings=view#project-drawings`}
                      >
                        View plans/drawings
                      </Link>
                      <Link
                        href={`/bid-desk?project=${encodeURIComponent(project.id)}&drawings=download#project-drawings`}
                      >
                        Download drawings
                      </Link>
                    </div>
                    <a className="source-link" href={project.sourceUrl} target="_blank" rel="noreferrer">
                      View official source ↗
                    </a>
                    <Link
                      className="bid-desk-launch"
                      href={`/bid-desk?project=${encodeURIComponent(project.id)}`}
                    >
                      Open in Bid Desk
                    </Link>
                    <small className="provenance">
                      {project.sourceName} - source date {shortDate(project.updatedAt)}
                    </small>
                  </div>
                </article>
              );
            })}
            {paginatedProjects.length === 0 && (
              <div className="empty-state">
                <strong>No matches in the currently indexed public content.</strong>
                <p>The product may still appear in a plan/specification that has not been collected, is account-gated, or is not public.</p>
                <button onClick={clearSearch}>Clear search</button>
              </div>
            )}
          </div>

          {totalProjectMatches > 0 && (
            <nav className="project-pagination" aria-label="Project result pages">
              <p className="project-pagination__summary">
                Showing {(pageStart + 1).toLocaleString("en-US")}–{pageEnd.toLocaleString("en-US")} of {totalProjectMatches.toLocaleString("en-US")} loaded project matches{serverSearchMeta?.resultLimitReached ? " (partial source windows)" : ""}
              </p>
              <label className="project-pagination__size">
                <span>Results per page</span>
                <select
                  value={pageSize}
                  onChange={(event) => {
                    const nextPageSize = Number(event.target.value);
                    setPageSize(nextPageSize);
                    if (serverPaged) {
                      void fetchConnectedPage(1, nextPageSize);
                    } else {
                      setCurrentPage(1);
                    }
                  }}
                  disabled={searching}
                >
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                </select>
              </label>
              <div className="project-pagination__controls">
                <button type="button" disabled={activePage === 1 || searching} onClick={() => goToPage(1)}>First</button>
                <button type="button" disabled={activePage === 1 || searching} onClick={() => goToPage(activePage - 1)}>Previous</button>
                <span>Page {activePage.toLocaleString("en-US")} of {totalPages.toLocaleString("en-US")}{serverSearchMeta?.resultLimitReached ? " loaded pages" : ""}</span>
                <button type="button" disabled={activePage === totalPages || searching} onClick={() => goToPage(activePage + 1)}>Next</button>
                <button type="button" disabled={activePage === totalPages || searching} onClick={() => goToPage(totalPages)}>{serverSearchMeta?.resultLimitReached ? "Last loaded" : "Last"}</button>
              </div>
            </nav>
          )}
        </div>
      </section>
        </>
      )}

      {view === "documents" && (
        <DocumentsClient
          initialProjectId={initialDocumentProjectId}
          initialSourceId={initialDocumentSourceId}
          initialSearch={initialDocumentSearch}
        />
      )}

      {view === "bid-desk" && (
        <>
          {initialProjectId && !feed.projects.some((project) => project.id === initialProjectId) && (
            <div className="bid-desk-route-notice" role="status">
              The linked project is not in this page&apos;s current queryable public-source window. A loaded bidding project is shown instead; no project data was invented.
            </div>
          )}
          <BidDesk
            projects={feed.projects}
            selectedProjectId={selectedBidProjectId}
            asOf={feed.generatedAt}
            initialDrawingAction={initialDrawingAction}
            onSelectProject={setSelectedBidProjectId}
          />
        </>
      )}

      {view === "coverage" && (
        <>
      <section className="coverage-route-layout" id="coverage" aria-label="Source coverage status">
        <aside className="coverage-route-sources">
          <div className="coverage-card">
            <div className="coverage-head">
              <div>
                <p className="eyebrow">SOURCE HEALTH</p>
                <h2>Active adapters are not complete coverage.</h2>
              </div>
              <span>{liveSources} live</span>
            </div>
            <p className="coverage-intro">Source health says whether a connector works. National coverage asks whether every required jurisdiction and lifecycle source is represented.</p>
            <div className="source-list">
              {feed.sources.map((source) => (
                <a href={source.url} target="_blank" rel="noreferrer" className="source-row" key={source.id}>
                  <span className={`source-status status-${source.status}`} aria-hidden="true" />
                  <span className="source-name"><b>{source.name}</b><small>{source.jurisdiction} - {source.cadence}</small></span>
                  <span className="source-count">
                    <b>
                      {source.recordCount.toLocaleString("en-US")}
                      {source.recordCountUnit === "rows" ? " rows" : ""}
                    </b>
                    <small>
                      {source.loadedCount !== undefined && source.loadedCount !== source.recordCount
                        ? source.level === "registry"
                          ? `${source.loadedCount.toLocaleString("en-US")} active rows - `
                          : `${source.loadedCount.toLocaleString("en-US")} loaded - `
                        : ""}
                      {sourceStatusLabel(source)}
                    </small>
                  </span>
                </a>
              ))}
            </div>
          </div>

          <div className="truth-card" id="method">
            <p className="eyebrow">THE NO-BLIND-SPOT RULE</p>
            <h3>&quot;No match&quot; is not the same as &quot;the product is absent.&quot;</h3>
            <p>Every source and document carries an explicit state:</p>
            <ol>
              <li><span className="mini-dot live" />Public-source adapter active and current</li>
              <li><span className="mini-dot key" />Public, but needs a free key/account</li>
              <li><span className="mini-dot gap" />Source identified; connector not built yet</li>
              <li><span className="mini-dot private" />Not published, restricted, or records-request only</li>
            </ol>
          </div>

          {feed.warnings.length > 0 && (
            <div className="warning-card">
              <strong>{feed.warnings.length} source {feed.warnings.length === 1 ? "check needs" : "checks need"} retrying</strong>
              <p>Failed sources remain visible and are never silently treated as zero projects.</p>
            </div>
          )}
        </aside>
      </section>

      <section className="national-coverage" aria-labelledby="national-coverage-title">
        <div className="national-coverage-head">
          <div>
            <p className="eyebrow">NATIONAL BUILDOUT LEDGER</p>
            <h2 id="national-coverage-title">Every state is in the target. Most local layers remain gaps.</h2>
          </div>
          <p>{feed.coverage.statement}</p>
        </div>
        <div className="coverage-table-wrap">
          <table>
            <thead><tr><th>State</th><th>Procurement</th><th>DOT bidding</th><th>Permits</th><th>Planning</th><th>Loaded rows</th></tr></thead>
            <tbody>
              {feed.coverage.states.map((record) => (
                <tr key={record.code}>
                  <th scope="row"><b>{record.code}</b><span>{record.name}</span></th>
                  <td><a href={record.procurementUrl} target="_blank" rel="noreferrer" className={`coverage-chip coverage-${record.procurement}`}>{coverageLabel(record.procurement)} ↗</a></td>
                  <td><a href={record.dotBiddingUrl} target="_blank" rel="noreferrer" className={`coverage-chip coverage-${record.dotBidding}`}>{coverageLabel(record.dotBidding)} ↗</a></td>
                  <td><span className={`coverage-chip coverage-${record.permits}`}>{coverageLabel(record.permits)}</span></td>
                  <td><span className={`coverage-chip coverage-${record.planning}`}>{coverageLabel(record.planning)}</span></td>
                  <td className="loaded-cell">{record.loadedProjects.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <JurisdictionExplorer />
        </>
      )}

      <footer>
        <div><span className="brand-mark" aria-hidden="true">BA</span><b>BidAtlas</b></div>
        <p>Public-record coverage with source-level provenance. Private projects and unavailable native CAD are never presented as public.</p>
      </footer>
    </main>
  );
}
