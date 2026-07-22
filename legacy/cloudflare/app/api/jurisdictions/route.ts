import { and, asc, eq, like, or, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import {
  jurisdictionDiscoveryJobs,
  jurisdictionMetrics,
  jurisdictions,
} from "../../../db/schema";
import citySeedManifest from "../../../data/city-seeds-2025.json";
import {
  CENSUS_REGISTRY_ROWS_2025,
  CENSUS_GOVERNMENT_UNIVERSE_URL,
  LOCAL_GOVERNMENT_UNIVERSE_2025,
} from "../../lib/national-coverage";

export const dynamic = "force-dynamic";

type CitySeedManifest = {
  recordCount: number;
  sourceUrl: string;
  districtOfColumbiaIncluded: boolean;
  ambiguousWithinStateNames: string[];
  states: Array<{ code: string; name: string; places: string[] }>;
};

const CITY_SEEDS = citySeedManifest as CitySeedManifest;
const CITY_SEED_ROWS = [
  ...CITY_SEEDS.states.flatMap((state) =>
    state.places.map((name, index) => ({
      id: `place-seed:${state.code}:${slug(name)}:${index + 1}`,
      name,
      city: barePlaceName(name),
      governmentType: placeType(name),
      registryKind: "incorporated-place-seed",
      state: state.code,
      sourceUrl: CITY_SEEDS.sourceUrl,
    })),
  ),
  {
    id: "place-seed:DC:district-of-columbia:1",
    name: "District of Columbia",
    city: "District of Columbia",
    governmentType: "district",
    registryKind: "district-supplement",
    state: "DC",
    sourceUrl: CENSUS_GOVERNMENT_UNIVERSE_URL,
  },
];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const rawState = (url.searchParams.get("state") ?? "").trim();
  const state = rawState && rawState.toLowerCase() !== "all"
    ? rawState.slice(0, 2).toUpperCase()
    : undefined;
  const registryKind = url.searchParams.get("kind");
  const requestedLimit = Number(url.searchParams.get("limit") ?? 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 50)
    : 10;
  const page = Math.max(Math.trunc(Number(url.searchParams.get("page") ?? 1)) || 1, 1);
  const offset = (page - 1) * limit;

  try {
    const db = await getDb();
    const filters = [
      state ? eq(jurisdictions.state, state) : undefined,
      registryKind === "independent-government" || registryKind === "dependent-agency"
        ? eq(jurisdictions.registryKind, registryKind)
        : undefined,
      query
        ? or(
            like(jurisdictions.name, `${query}%`),
            like(jurisdictions.city, `${query}%`),
            like(jurisdictions.countyAreaName, `${query}%`),
            eq(jurisdictions.postalCode, query),
          )
        : undefined,
    ].filter((filter): filter is NonNullable<typeof filter> => Boolean(filter));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, totalRows] = await Promise.all([
      db
        .select({
          id: jurisdictions.id,
          censusGovernmentId: jurisdictions.censusGovernmentId,
          name: jurisdictions.name,
          governmentType: jurisdictions.governmentType,
          registryKind: jurisdictions.registryKind,
          state: jurisdictions.state,
          city: jurisdictions.city,
          postalCode: jurisdictions.postalCode,
          countyAreaName: jurisdictions.countyAreaName,
          population: jurisdictions.population,
          populationYear: jurisdictions.populationYear,
          website: jurisdictions.website,
          workerStatus: jurisdictionDiscoveryJobs.status,
          workerAttemptCount: jurisdictionDiscoveryJobs.attemptCount,
          sourceCandidatesFound: jurisdictionDiscoveryJobs.sourceCandidatesFound,
          connectedSources: sql<number>`(
            SELECT COUNT(DISTINCT current_evidence.source_id)
            FROM coverage_evidence AS current_evidence
            JOIN sources AS current_sources ON current_sources.id=current_evidence.source_id
            WHERE current_evidence.jurisdiction_id=jurisdictions.id
              AND current_evidence.evidence_state='connected'
              AND current_sources.status='live'
              AND current_sources.last_success_at IS NOT NULL
              AND julianday(current_sources.last_success_at) >=
                  julianday('now') -
                  (MAX(current_sources.cadence_minutes * 3, 1440) / 1440.0)
          )`,
          loadedProjects: jurisdictionMetrics.loadedProjects,
          publicDocuments: jurisdictionMetrics.publicDocuments,
          connectedSourceClasses: sql<number>`(
            SELECT COUNT(DISTINCT current_evidence.source_class)
            FROM coverage_evidence AS current_evidence
            JOIN sources AS current_sources ON current_sources.id=current_evidence.source_id
            WHERE current_evidence.jurisdiction_id=jurisdictions.id
              AND current_evidence.evidence_state='connected'
              AND current_sources.status='live'
              AND current_sources.last_success_at IS NOT NULL
              AND julianday(current_sources.last_success_at) >=
                  julianday('now') -
                  (MAX(current_sources.cadence_minutes * 3, 1440) / 1440.0)
          )`,
          requiredSourceClasses: jurisdictionMetrics.requiredSourceClasses,
          metricsRefreshedAt: jurisdictionMetrics.refreshedAt,
        })
        .from(jurisdictions)
        .leftJoin(
          jurisdictionDiscoveryJobs,
          eq(jurisdictionDiscoveryJobs.jurisdictionId, jurisdictions.id),
        )
        .leftJoin(
          jurisdictionMetrics,
          eq(jurisdictionMetrics.jurisdictionId, jurisdictions.id),
        )
        .where(where)
        .orderBy(asc(jurisdictions.name))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(jurisdictions)
        .where(where),
    ]);

    return Response.json({
      query: { q: query || undefined, state, registryKind, limit, page },
      total: Number(totalRows[0]?.count ?? 0),
      totalPages: Math.max(1, Math.ceil(Number(totalRows[0]?.count ?? 0) / limit)),
      jurisdictions: rows.map((row) => ({
        ...row,
        workerStatus: row.workerStatus ?? "not-seeded",
        workerAttemptCount: Number(row.workerAttemptCount ?? 0),
        sourceCandidatesFound: Number(row.sourceCandidatesFound ?? 0),
        connectedSources: Number(row.connectedSources ?? 0),
        loadedProjects: Number(row.loadedProjects ?? 0),
        publicDocuments: Number(row.publicDocuments ?? 0),
        connectedSourceClasses: Number(row.connectedSourceClasses ?? 0),
        requiredSourceClasses: Number(row.requiredSourceClasses ?? 7),
        connectionState: connectionState(
          Number(row.connectedSourceClasses ?? 0),
          Number(row.requiredSourceClasses ?? 7),
        ),
      })),
      registry: {
        importedRowsExpected: CENSUS_REGISTRY_ROWS_2025,
        independentLocalGovernments: LOCAL_GOVERNMENT_UNIVERSE_2025,
        incorporatedPlaceSeeds: CITY_SEEDS.recordCount,
        citySeedIncludesDistrictOfColumbia: CITY_SEEDS.districtOfColumbiaIncluded,
        ambiguousWithinStateNames: CITY_SEEDS.ambiguousWithinStateNames.length,
        sourceUrl: CENSUS_GOVERNMENT_UNIVERSE_URL,
      },
    });
  } catch (error) {
    if (!databaseIsUnavailable(error, url.hostname)) {
      console.error("Jurisdiction registry query failed.", error);
      return Response.json(
        {
          error: "Jurisdiction coverage is temporarily unavailable.",
          retryable: true,
        },
        { status: 503 },
      );
    }

    const fallback = CITY_SEED_ROWS.filter((row) => {
      if (state && row.state !== state) return false;
      if (registryKind === "dependent-agency") return false;
      if (!query) return true;
      const haystack = `${row.name} ${row.city} ${row.state}`.toLowerCase();
      return haystack.includes(query.toLowerCase());
    });
    const total = fallback.length;
    return Response.json({
      query: { q: query || undefined, state, registryKind, limit, page },
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      jurisdictions: fallback.slice(offset, offset + limit).map((row) => ({
        ...row,
        censusGovernmentId: null,
        postalCode: null,
        countyAreaName: null,
        population: null,
        populationYear: null,
        website: null,
        workerStatus: "awaiting-official-registry-match",
        workerAttemptCount: 0,
        sourceCandidatesFound: 0,
        connectedSources: 0,
        loadedProjects: 0,
        publicDocuments: 0,
        connectedSourceClasses: 0,
        requiredSourceClasses: 7,
        metricsRefreshedAt: null,
        connectionState: "not-connected",
      })),
      registry: {
        importedRowsExpected: CENSUS_REGISTRY_ROWS_2025,
        independentLocalGovernments: LOCAL_GOVERNMENT_UNIVERSE_2025,
        incorporatedPlaceSeeds: CITY_SEEDS.recordCount,
        citySeedIncludesDistrictOfColumbia: CITY_SEEDS.districtOfColumbiaIncluded,
        districtSupplementRows: 1,
        ambiguousWithinStateNames: CITY_SEEDS.ambiguousWithinStateNames.length,
        sourceUrl: CENSUS_GOVERNMENT_UNIVERSE_URL,
        citySeedSourceUrl: CITY_SEEDS.sourceUrl,
        usingFallbackSeeds: true,
      },
    });
  }
}

function databaseIsUnavailable(error: unknown, hostname: string): boolean {
  const messages: string[] = [];
  const codes: string[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Error) messages.push(current.message.toLowerCase());
    if ("code" in current) codes.push(String(current.code));
    current = "cause" in current ? current.cause : undefined;
  }
  const message = messages.join(" ");
  return (
    codes.includes("ERR_UNSUPPORTED_ESM_URL_SCHEME") ||
    message.includes("d1 binding") ||
    message.includes("binding `db` is unavailable") ||
    message.includes("cloudflare:workers") ||
    message.includes("protocol 'cloudflare:'") ||
    (
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") &&
      message.includes("no such table: jurisdictions")
    )
  );
}

function connectionState(connected: number, required: number): string {
  if (required > 0 && connected >= required) return "connected";
  if (connected > 0) return "partial";
  return "not-connected";
}

function barePlaceName(value: string): string {
  return value.replace(
    /\s+(city|town|village|borough|municipality|city and borough|unified government|metropolitan government)$/i,
    "",
  );
}

function placeType(value: string): string {
  return /\s+([a-z]+(?: and [a-z]+)?)$/i.exec(value)?.[1]?.toLowerCase() ?? "incorporated place";
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 100);
}
