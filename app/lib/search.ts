import type { BidDueFilter, ProjectRecord, ProjectSearchOptions } from "./types";
import { isBidReadyProject } from "./bid-readiness";
import {
  calendarDateInTimeZone,
  calendarDayWindow,
  dateOnlyBidDeadline,
  DEFAULT_BID_DATE_TIME_ZONE,
  type BidDateTimeZone,
} from "./deadline-time";
import { allStateOptions, normalizeStateCode } from "./national-coverage";
import { classifyProjectFreshness, freshnessMatchesFilter } from "./outreach-intelligence";
import { isArchivedProjectStage } from "./project-lifecycle";
import { inferredProjectSectorTags } from "./project-sector";

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LOCATION_STATE_SUFFIXES = allStateOptions()
  .map(([code, name]) => ({ code: code.toLowerCase(), name: normalize(name) }))
  .sort((left, right) => right.name.length - left.name.length);

/**
 * Normalize punctuation and a trailing full state name without rewriting a
 * same-named city. For example, "New York, New York" becomes "new york ny",
 * while the leading city remains intact.
 */
export function normalizeLocationQuery(value: string): string {
  const normalized = normalize(value);
  for (const state of LOCATION_STATE_SUFFIXES) {
    if (normalized === state.name) return state.code;
    if (normalized.endsWith(` ${state.name}`)) {
      return `${normalized.slice(0, -(state.name.length + 1))} ${state.code}`;
    }
  }
  return normalized;
}

function containsNormalizedPhrase(haystack: string, phrase: string): boolean {
  const normalizedPhrase = normalize(phrase);
  return Boolean(
    normalizedPhrase && ` ${haystack} `.includes(` ${normalizedPhrase} `),
  );
}

function containsEveryNormalizedToken(haystack: string, query: string): boolean {
  const tokens = query.split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => containsNormalizedPhrase(haystack, token));
}

export interface BidDueWindow {
  start: string;
  end: string;
}

/** Resolve shortcuts against calendar days in the deadline's source timezone. */
export function bidDueWindow(
  due: BidDueFilter | undefined,
  now = new Date(),
  timeZone: BidDateTimeZone = DEFAULT_BID_DATE_TIME_ZONE,
): BidDueWindow | null {
  if (!due || due === "all") return null;
  const dayCount = due === "today" ? 1 : due === "7-days" ? 7 : 14;
  return calendarDayWindow(dayCount, now, timeZone);
}

export function bidDateMatchesDueFilter(
  bidDate: string | undefined,
  due: BidDueFilter | undefined,
  now = new Date(),
  timeZone: BidDateTimeZone = DEFAULT_BID_DATE_TIME_ZONE,
): boolean {
  const window = bidDueWindow(due, now, timeZone);
  if (!window) return true;
  const dateOnlyDay = dateOnlyBidDeadline(bidDate);
  if (dateOnlyDay) {
    const startDay = calendarDateInTimeZone(new Date(window.start), timeZone);
    const endDay = calendarDateInTimeZone(new Date(window.end), timeZone);
    return dateOnlyDay >= startDay && dateOnlyDay < endDay;
  }
  const bidTimestamp = Date.parse(bidDate ?? "");
  return (
    Number.isFinite(bidTimestamp) &&
    bidTimestamp >= Date.parse(window.start) &&
    bidTimestamp < Date.parse(window.end)
  );
}

export function parseKeywordInput(input: string): string[] {
  const terms: string[] = [];
  const matcher = /"([^"]+)"|'([^']+)'|([^,\n]+)/g;
  for (const match of input.matchAll(matcher)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!raw) continue;
    if (!input.includes(",") && !input.includes("\n") && !match[1] && !match[2]) {
      terms.push(...raw.split(/\s+/));
    } else {
      terms.push(raw);
    }
  }
  return Array.from(new Set(terms.map(normalize).filter(Boolean))).slice(0, 20);
}

export function projectMetadataText(project: ProjectRecord): string {
  const sectorEvidenceText = [
    project.title,
    project.summary,
    project.status,
    ...(project.searchableFields ?? []),
  ]
    .filter(Boolean)
    .join(" ");
  const sourceText = [
      project.title,
      project.summary,
      project.status,
      project.agency,
      project.address,
      project.city,
      project.county,
      project.state,
      project.postalCode,
      ...project.participants.flatMap((participant) => [
        participant.name,
        participant.role,
        participant.organization,
        participant.email,
        participant.phone,
      ]),
      ...project.documents.flatMap((document) => [document.name, document.kind]),
      ...(project.searchableFields ?? []),
    ]
      .filter(Boolean)
      .join(" ");
  // Agency names, contact titles, addresses, and document labels can contain
  // words such as "office" without classifying the building. Sector tags use
  // only project/scope fields supplied by the source adapter.
  return normalize([sourceText, ...inferredProjectSectorTags(sectorEvidenceText)].join(" "));
}

export function projectLocationText(project: ProjectRecord): string {
  const stateCode = normalizeStateCode(project.state);
  return normalize(
    [project.address, project.city, project.county, project.state, stateCode, project.postalCode]
      .filter(Boolean)
      .join(" "),
  );
}

export function matchedProjectTerms(
  project: ProjectRecord,
  options: ProjectSearchOptions,
): string[] {
  const haystack = projectMetadataText(project);
  return options.keywords.filter((term) => containsNormalizedPhrase(haystack, term));
}

export function projectMatchesSearch(
  project: ProjectRecord,
  options: ProjectSearchOptions,
  now = new Date(),
): boolean {
  if (options.readiness === "bid-ready" && !isBidReadyProject(project, now)) {
    return false;
  }
  if (!options.includeArchived && isArchivedProjectStage(project.stage)) return false;
  if (options.stage && options.stage !== "all" && project.stage !== options.stage) return false;
  if (
    !freshnessMatchesFilter(
      classifyProjectFreshness(project).freshness,
      options.freshness,
    )
  ) return false;
  if (options.state && options.state.toLowerCase() !== "all") {
    const requestedState = normalizeStateCode(options.state);
    if (!requestedState || normalizeStateCode(project.state) !== requestedState) return false;
  }
  if (
    !bidDateMatchesDueFilter(
      project.bidDate,
      options.due,
      now,
      project.bidDateTimeZone,
    )
  ) return false;

  const location = normalizeLocationQuery(options.location ?? "");
  if (location && !containsEveryNormalizedToken(projectLocationText(project), location)) return false;

  const keywords = options.keywords.map(normalize).filter(Boolean);
  if (keywords.length === 0) return true;
  const haystack = projectMetadataText(project);
  if (options.match === "phrase") return containsNormalizedPhrase(haystack, keywords.join(" "));
  if (options.match === "all") {
    return keywords.every((term) => containsNormalizedPhrase(haystack, term));
  }
  return keywords.some((term) => containsNormalizedPhrase(haystack, term));
}

export function searchProjects(
  projects: ProjectRecord[],
  options: ProjectSearchOptions,
  now = new Date(),
): ProjectRecord[] {
  return projects.filter((project) => projectMatchesSearch(project, options, now));
}
