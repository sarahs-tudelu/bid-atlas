import { cleanResearchText, normalizeOfficialHttpsUrl } from "./contracts.ts";
import { fetchOfficialText, type ResearchFetch, type ResearchHostResolver } from "./network.ts";
import type { OfficialResearchSource, ResearchSourceAttempt } from "./types.ts";

export const CALTRANS_SOURCE_ID = "caltrans-contracting-opportunities";
export const CALTRANS_INDEX_URL = "https://ccop.dot.ca.gov/allProjects";
export const UNKNOWN_SOURCE_ACTIVITY_AT = new Date(0).toISOString();
export const CALTRANS_ALLOWED_HOSTS = [
  "ccop.dot.ca.gov",
  "cdotprod.service-now.com",
  "caleprocure.ca.gov",
] as const;

export type ResolvedResearchProject = {
  id: string;
  canonicalKey: string;
  title: string;
  summary: string;
  stage: string;
  status: string;
  agency: string;
  address?: string;
  city?: string;
  county?: string;
  state?: string;
  postalCode?: string;
  estimatedValue?: number;
  postedAt?: string;
  bidDate?: string;
  /** The official source's activity/publication time, never the lookup time. */
  sourceActivityAt: string;
  sourceId: string;
  sourceRecordId: string;
  sourceUrl: string;
  sourceLabel: string;
};

function stripHtml(value: string): string {
  return cleanResearchText(
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"),
    800,
  );
}

function cell(row: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return stripHtml(row.match(new RegExp(`data-label=["']${escaped}["'][^>]*>([\\s\\S]*?)(?=<\\/td>|<td|<\\/tr>)`, "i"))?.[1] ?? "");
}

function isoDate(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const date = new Date(`${value.trim()}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function parseCaltransProjectId(projectId: string): string | undefined {
  const prefix = `${CALTRANS_SOURCE_ID}:`;
  if (!projectId.startsWith(prefix)) return undefined;
  const contractId = projectId.slice(prefix.length).trim().toUpperCase();
  return /^(?=.{5,20}$)(?=.*\d)[A-Z0-9]+(?:-[A-Z0-9]+)?$/.test(contractId) ? contractId : undefined;
}

export function caltransDetailApiUrl(contractId: string): string {
  const url = new URL("https://cdotprod.service-now.com/api/now/sp/page");
  url.searchParams.set("id", "cc_advertisement_details");
  url.searchParams.set("ad_id", contractId);
  return url.toString();
}

export function caltransResearchSources(contractId: string, officialDetailUrl?: string): OfficialResearchSource[] {
  const detailHost = officialDetailUrl ? new URL(officialDetailUrl).hostname.toLowerCase() : "";
  return [
    {
      sourceId: CALTRANS_SOURCE_ID,
      sourceLabel: "Caltrans Contracting Opportunities Portal",
      url: CALTRANS_INDEX_URL,
      strategy: "generic-official-page",
      allowedHosts: [...CALTRANS_ALLOWED_HOSTS],
    },
    ...(detailHost === "cdotprod.service-now.com"
      ? [{
          sourceId: CALTRANS_SOURCE_ID,
          sourceLabel: `Caltrans Contractors Corner ${contractId}`,
          url: caltransDetailApiUrl(contractId),
          strategy: "caltrans-contract-detail" as const,
          allowedHosts: [...CALTRANS_ALLOWED_HOSTS],
        }]
      : []),
  ];
}

/**
 * Resolves only an exact ID observed on Caltrans' current official index. The
 * browser cannot supply or override a URL, title, status, or lifecycle value.
 */
export async function resolveExactCaltransProject(
  projectId: string,
  options: {
    fetchImpl?: ResearchFetch;
    resolveHost?: ResearchHostResolver;
    parentSignal?: AbortSignal;
    now?: Date;
  } = {},
): Promise<{ project?: ResolvedResearchProject; attempt: Omit<ResearchSourceAttempt, "id"> }> {
  const contractId = parseCaltransProjectId(projectId);
  if (!contractId) {
    const timestamp = (options.now ?? new Date()).toISOString();
    return {
      attempt: {
        sourceId: CALTRANS_SOURCE_ID,
        sourceUrl: CALTRANS_INDEX_URL,
        status: "skipped",
        bytesRead: 0,
        durationMs: 0,
        errorCode: "not_caltrans_project",
        errorMessage: "The project ID is not a Caltrans canonical ID.",
        startedAt: timestamp,
        completedAt: timestamp,
      },
    };
  }
  const started = Date.now();
  const startedAt = (options.now ?? new Date()).toISOString();
  try {
    const response = await fetchOfficialText(CALTRANS_INDEX_URL, CALTRANS_ALLOWED_HOSTS, options);
    for (const rowMatch of response.body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const row = rowMatch[1];
      const link = row.match(/data-label=["']Project ID["'][\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/i);
      if (!link || stripHtml(link[2]).toUpperCase() !== contractId) continue;
      const detailUrl = normalizeOfficialHttpsUrl(new URL(link[1].replace(/&amp;/g, "&"), CALTRANS_INDEX_URL).toString());
      if (!CALTRANS_ALLOWED_HOSTS.includes(new URL(detailUrl).hostname.toLowerCase() as typeof CALTRANS_ALLOWED_HOSTS[number])) continue;
      const status = cell(row, "Status") || "Published";
      // The current official index contains active advertisements and upcoming
      // work. No elapsed-date heuristic is used to infer completion.
      const stage = /upcoming|scheduled/i.test(status) ? "planning" : "bidding";
      const title = cell(row, "Project Title") || `Caltrans contract ${contractId}`;
      const county = cell(row, "County");
      const license = cell(row, "License");
      const postedAt = isoDate(cell(row, "Advertise Date"));
      const bidDate = isoDate(cell(row, "Bid Date"));
      return {
        project: {
          id: `${CALTRANS_SOURCE_ID}:${contractId}`,
          canonicalKey: `${CALTRANS_SOURCE_ID}:${contractId}`,
          title,
          summary: [county ? `${county} County` : "California", license ? `License ${license}` : undefined].filter(Boolean).join(" · "),
          stage,
          status,
          agency: "California Department of Transportation",
          ...(county ? { county } : {}),
          state: "CA",
          ...(postedAt ? { postedAt } : {}),
          ...(bidDate ? { bidDate } : {}),
          // Caltrans does not expose a separate modified timestamp here. Its
          // published advertise date is the only truthful source activity
          // signal; an undated row remains unknown rather than looking new.
          sourceActivityAt: postedAt ?? UNKNOWN_SOURCE_ACTIVITY_AT,
          sourceId: CALTRANS_SOURCE_ID,
          sourceRecordId: contractId,
          sourceUrl: detailUrl,
          sourceLabel: "Caltrans Contracting Opportunities Portal",
        },
        attempt: {
          sourceId: CALTRANS_SOURCE_ID,
          sourceUrl: CALTRANS_INDEX_URL,
          finalUrl: response.finalUrl,
          status: "complete",
          httpStatus: response.status,
          contentType: response.contentType,
          bytesRead: response.bytesRead,
          durationMs: Math.max(0, Date.now() - started),
          startedAt,
          completedAt: new Date().toISOString(),
        },
      };
    }
    return {
      attempt: {
        sourceId: CALTRANS_SOURCE_ID,
        sourceUrl: CALTRANS_INDEX_URL,
        finalUrl: response.finalUrl,
        status: "complete",
        httpStatus: response.status,
        contentType: response.contentType,
        bytesRead: response.bytesRead,
        durationMs: Math.max(0, Date.now() - started),
        errorCode: "exact_project_not_active",
        errorMessage: "The exact project ID was not present on the current official Caltrans index.",
        startedAt,
        completedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return {
      attempt: {
        sourceId: CALTRANS_SOURCE_ID,
        sourceUrl: CALTRANS_INDEX_URL,
        status: "failed",
        bytesRead: 0,
        durationMs: Math.max(0, Date.now() - started),
        errorCode: error instanceof Error && "code" in error ? String(error.code) : "caltrans_lookup_failed",
        errorMessage: error instanceof Error ? cleanResearchText(error.message, 240) : "The official Caltrans index lookup failed.",
        startedAt,
        completedAt: new Date().toISOString(),
      },
    };
  }
}
