import { lookupNycCityRecordConstructionProject } from "../socrata-city-connectors.ts";
import type { ProjectRecord } from "../types.ts";
import {
  UNKNOWN_SOURCE_ACTIVITY_AT,
  type ResolvedResearchProject,
} from "./caltrans.ts";
import {
  ProjectResearchError,
  cleanResearchText,
  normalizeOfficialHttpsUrl,
} from "./contracts.ts";

export const NYC_CITY_RECORD_SOURCE_ID = "nyc-city-record-construction-procurement";
export const NYC_CITY_RECORD_DATASET_URL = "https://data.cityofnewyork.us/d/dg92-zbpx";
export const NYC_CITY_RECORD_CROL_HOST = "a856-cityrecord.nyc.gov";

export type NycCityRecordLookup = (
  projectId: string,
) => Promise<ProjectRecord | null>;

export function parseNycCityRecordProjectId(projectId: string): string | undefined {
  const prefix = `${NYC_CITY_RECORD_SOURCE_ID}:`;
  if (!projectId.startsWith(prefix)) return undefined;
  const requestId = projectId.slice(prefix.length);
  return /^\d{1,20}$/.test(requestId) ? requestId : undefined;
}

function requiredText(value: string, field: string, maxLength: number): string {
  const cleaned = cleanResearchText(value, maxLength);
  if (!cleaned) {
    throw new ProjectResearchError(
      502,
      "invalid_nyc_city_record_project",
      `The exact NYC City Record row did not contain a usable ${field}.`,
    );
  }
  return cleaned;
}

function normalizedDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ProjectResearchError(
      502,
      "invalid_nyc_city_record_project",
      "The exact NYC City Record row contained an invalid published date.",
    );
  }
  return parsed.toISOString();
}

function sourceActivityDate(value: string | undefined, publishedAt?: string): string {
  if (value) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return publishedAt ?? UNKNOWN_SOURCE_ACTIVITY_AT;
}

function verifiedCrolDetailUrl(value: string, requestId: string): string {
  const sourceUrl = normalizeOfficialHttpsUrl(value);
  const url = new URL(sourceUrl);
  const expectedPath = `/RequestDetail/${encodeURIComponent(requestId)}`;
  if (
    url.hostname.toLowerCase() !== NYC_CITY_RECORD_CROL_HOST ||
    url.pathname !== expectedPath ||
    url.search
  ) {
    throw new ProjectResearchError(
      502,
      "invalid_nyc_city_record_project",
      "The exact NYC City Record row did not contain its canonical official CROL detail page.",
    );
  }
  return sourceUrl;
}

/**
 * Resolves only a numeric identity returned by the fixed NYC City Record
 * connector. The browser cannot provide a source URL or substitute record
 * content, and the returned CROL page is checked again before persistence.
 */
export async function resolveExactNycCityRecordProject(
  projectId: string,
  lookup: NycCityRecordLookup = lookupNycCityRecordConstructionProject,
): Promise<ResolvedResearchProject | null> {
  const requestId = parseNycCityRecordProjectId(projectId);
  if (!requestId) return null;
  const project = await lookup(projectId);
  if (!project) return null;
  if (
    project.id !== projectId ||
    project.sourceId !== NYC_CITY_RECORD_SOURCE_ID ||
    project.sourceRecordId !== requestId ||
    project.confidence !== "official" ||
    project.provenance !== "live-api"
  ) {
    throw new ProjectResearchError(
      502,
      "invalid_nyc_city_record_project",
      "The exact NYC City Record lookup returned inconsistent source identity or provenance.",
    );
  }
  const postedAt = normalizedDate(project.postedAt);
  const bidDate = normalizedDate(project.bidDate);

  return {
    id: project.id,
    canonicalKey: project.id,
    title: requiredText(project.title, "title", 500),
    summary: cleanResearchText(project.summary, 2_000),
    stage: project.stage,
    status: requiredText(project.status, "notice type", 160),
    agency: requiredText(project.agency, "agency", 300),
    ...(project.county ? { county: cleanResearchText(project.county, 180) } : {}),
    state: "NY",
    ...(postedAt ? { postedAt } : {}),
    ...(bidDate ? { bidDate } : {}),
    // City Record maps updatedAt from its source-published start date. Fall
    // back only to the same verified published date, never the lookup clock.
    sourceActivityAt: sourceActivityDate(project.updatedAt, postedAt),
    sourceId: NYC_CITY_RECORD_SOURCE_ID,
    sourceRecordId: requestId,
    sourceUrl: verifiedCrolDetailUrl(project.sourceUrl, requestId),
    sourceLabel: "NYC City Record procurement notices",
  };
}
