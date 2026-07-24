import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { rootCertificates } from "node:tls";
import { Agent } from "undici";

import {
  PROJECT_SOURCE_IDS,
  getProjectFeed,
} from "../../legacy/cloudflare/app/lib/connectors";
import {
  fetchPublicDotSource,
} from "../../legacy/cloudflare/app/lib/public-dot-connectors";
import {
  fetchNycCityRecordCurrentConstructionSolicitations,
} from "../../legacy/cloudflare/app/lib/socrata-city-connectors";
import {
  TEXAS_DOT_SOURCE_ID,
  fetchTexasDotSource,
} from "../../legacy/cloudflare/app/lib/texas-dot-connector";


type JsonRecord = Record<string, any>;

const s3 = new S3Client({});
const PYTHON_MANAGED_SOURCE_IDS = new Set([
  "new-york-dot-construction-contracts",
  "new-jersey-dpmc-construction-advertisements",
  "new-jersey-dot-current-advertised-projects",
  "maine-dot-current-construction-bids",
]);
const MANAGED_SOURCE_IDS = new Set(
  PROJECT_SOURCE_IDS.filter(
    (sourceId) =>
      sourceId !== "sam-contract-opportunities"
      && !PYTHON_MANAGED_SOURCE_IDS.has(sourceId),
  ),
);
const COVERAGE_FIELDS = ["procurement", "dotBidding", "permits", "planning"] as const;
const FLORIDA_DOT_SOURCE_ID = "florida-dot-statewide-lettings";
const NYC_CITY_RECORD_SOURCE_ID = "nyc-city-record-construction-procurement";
const MAX_COMPLETE_ROUTE_PAGES = 10;
// ftp.txdot.gov currently omits this DigiCert intermediate from its TLS chain.
// Pin the public CA certificate while retaining Node's default roots and normal
// hostname/certificate validation. Intermediate expires 2031-03-29.
const TXDOT_INTERMEDIATE_BASE64 =
  "MIIEyDCCA7CgAwIBAgIQDPW9BitWAvR6uFAsI8zwZjANBgkqhkiG9w0BAQsFADBhMQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQuY29tMSAwHgYDVQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBHMjAeFw0yMTAzMzAwMDAwMDBaFw0zMTAzMjkyMzU5NTlaMFkxCzAJBgNVBAYTAlVTMRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxMzAxBgNVBAMTKkRpZ2lDZXJ0IEdsb2JhbCBHMiBUTFMgUlNBIFNIQTI1NiAyMDIwIENBMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMz3EGJPprtjb+2QUlbFbSd7ehJWivH0+dbn4Y+9lavyYEEVcNsSAPonCrVXOFt9slGTcZUOakGUWzUb+nv6u8W+JDD+Vu/E832X4xT1FE3LpxDyFuqrIvAxIhFhaZAmunjZlx/jfWardUSVc8is/+9dCopZQ+GssjoP80j812s3wWPc3kbW20X+fSP9kOhRBx5Ro1/tSUZUfyyIxfQTnJcVPAPooTncaQwywa8WV0yUR0J8osicfebUTVSvQpmowQTCd5zWSOTOEeAqgJnwQ3DPP3Zr0UxJqyRewg2C/Uaoq2yTzGJSQnWS+Jr6Xl6ysGHlHx+5fwmY6D36g39HaaECAwEAAaOCAYIwggF+MBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFHSFgMBmx9833s+9KTeqAx2+7c0XMB8GA1UdIwQYMBaAFE4iVCAYlebjbuYP+vq5Eu0GF485MA4GA1UdDwEB/wQEAwIBhjAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwdgYIKwYBBQUHAQEEajBoMCQGCCsGAQUFBzABhhhodHRwOi8vb2NzcC5kaWdpY2VydC5jb20wQAYIKwYBBQUHMAKGNGh0dHA6Ly9jYWNlcnRzLmRpZ2ljZXJ0LmNvbS9EaWdpQ2VydEdsb2JhbFJvb3RHMi5jcnQwQgYDVR0fBDswOTA3oDWgM4YxaHR0cDovL2NybDMuZGlnaWNlcnQuY29tL0RpZ2lDZXJ0R2xvYmFsUm9vdEcyLmNybDA9BgNVHSAENjA0MAsGCWCGSAGG/WwCATAHBgVngQwBATAIBgZngQwBAgEwCAYGZ4EMAQICMAgGBmeBDAECAzANBgkqhkiG9w0BAQsFAAOCAQEAkPFwyyiXaZd8dP3A+iZ7U6utzWX9upwGnIrXWkOH7U1MVl+twcW1BSAuWdH/SvWgKtiwla3JLko716f2b4gp/DA/JIS7w7d7kwcsr4drdjPtAFVSslme5LnQ89/nD/7d+MS5EHKBCQRfz5eeLjJ1js+aWNJXMX43AYGyZm0pGrFmCW3RbpD0ufovARTFXFZkAdl9h6g4U5+LXUZtXMYnhIHUfoyMo5tS58aI7Dd8KvvwVVo4chDYABPPTHPbqjc1qCmBaZx2vN4Ye5DUys/vZwP9BFohFrH/6j/f3IL16/RZkiMNJCqVJUzKoZHm1Lesh3Sz8W2jmdv51b2EQJ8HmA==";
const TXDOT_INTERMEDIATE_PEM = [
  "-----BEGIN CERTIFICATE-----",
  ...(TXDOT_INTERMEDIATE_BASE64.match(/.{1,64}/g) ?? []),
  "-----END CERTIFICATE-----",
].join("\n");
const txdotAgent = new Agent({
  connect: {
    ca: [...rootCertificates, TXDOT_INTERMEDIATE_PEM],
    rejectUnauthorized: true,
  },
});


function stateCode(value: unknown): string {
  const text = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(text) ? text : "";
}


function sourceState(source: JsonRecord): string {
  const direct = stateCode(source.stateCode);
  if (direct) return direct;
  const parts = String(source.jurisdiction ?? "")
    .split(",")
    .map((part) => part.trim())
    .reverse();
  return parts.map(stateCode).find(Boolean) ?? "";
}


function sourceCoverageField(source: JsonRecord): typeof COVERAGE_FIELDS[number] | "" {
  if (COVERAGE_FIELDS.includes(source.coverageField)) return source.coverageField;
  if (source.sourceClass === "permits") return "permits";
  if (source.sourceClass === "planning" || source.sourceClass === "capital-plans") {
    return "planning";
  }
  if (source.sourceClass !== "procurement") return "";
  const description = `${source.id ?? ""} ${source.owner ?? ""}`.toLowerCase();
  return /(?:^|\W)(?:dot|transportation)(?:\W|$)/.test(description)
    ? "dotBidding"
    : "procurement";
}


function aggregateSnapshot(snapshot: JsonRecord): void {
  const projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  const stageCounts: Record<string, number> = {};
  const stateCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  const organizations = new Set<string>();
  let documentTextIndexedProjects = 0;

  for (const project of projects) {
    const stage = String(project.stage || "unclassified");
    const state = stateCode(project.state);
    const sourceId = String(project.sourceId || "unknown");
    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
    if (state) stateCounts[state] = (stateCounts[state] ?? 0) + 1;
    sourceCounts[sourceId] = (sourceCounts[sourceId] ?? 0) + 1;
    if (project.documentTextIndexed) documentTextIndexedProjects += 1;
    for (const participant of project.participants ?? []) {
      const organization = String(participant.organization ?? "").trim().toLowerCase();
      if (organization) organizations.add(organization);
    }
  }

  const refreshedAt = new Date().toISOString();
  snapshot.generatedAt = refreshedAt;
  snapshot.inventory = {
    ...(snapshot.inventory ?? {}),
    mode: "aws-snapshot",
    totalProjects: projects.length,
    stageCounts,
    stateCounts,
    sourceCounts,
    documentTextIndexedProjects,
    contractorOrganizations: organizations.size,
    refreshedAt,
  };
  snapshot.coverage = {
    ...(snapshot.coverage ?? {}),
    asOf: refreshedAt,
    loadedProjectRecords: projects.length,
    documentTextIndexedProjects,
    connectedSourceGroups: sources.filter((source: JsonRecord) => source.status === "live").length,
  };
  for (const state of snapshot.coverage.states ?? []) {
    state.loadedProjects = stateCounts[stateCode(state.code)] ?? 0;
  }
}


export function mergeFeed(snapshot: JsonRecord, feed: JsonRecord): JsonRecord {
  const freshSources = (feed.sources ?? []).filter(
    (source: JsonRecord) => MANAGED_SOURCE_IDS.has(String(source.id)),
  );
  const freshProjectSourceIds = new Set(
    (feed.projects ?? []).map((project: JsonRecord) => String(project.sourceId)),
  );
  const refreshedSourceIds = new Set(
    freshSources
      .filter(
        (source: JsonRecord) =>
          source.status === "live"
          || (source.status === "degraded" && freshProjectSourceIds.has(String(source.id))),
      )
      .map((source: JsonRecord) => String(source.id)),
  );
  const retainedProjects = (snapshot.projects ?? []).filter(
    (project: JsonRecord) => !refreshedSourceIds.has(String(project.sourceId)),
  );
  const freshProjects = (feed.projects ?? []).filter(
    (project: JsonRecord) => refreshedSourceIds.has(String(project.sourceId)),
  );
  const projectsById = new Map<string, JsonRecord>();
  for (const project of [...retainedProjects, ...freshProjects]) {
    projectsById.set(String(project.id), project);
  }

  const retainedSources = (snapshot.sources ?? []).filter(
    (source: JsonRecord) => !refreshedSourceIds.has(String(source.id)),
  );
  const sourcesById = new Map<string, JsonRecord>();
  for (const source of [
    ...retainedSources,
    ...freshSources.filter((source: JsonRecord) => refreshedSourceIds.has(String(source.id))),
  ]) {
    sourcesById.set(String(source.id), source);
  }

  const warningPrefixes = freshSources.map((source: JsonRecord) => `${source.name}:`);
  const priorWarnings = (snapshot.warnings ?? []).filter(
    (warning: unknown) =>
      !warningPrefixes.some((prefix: string) => String(warning).startsWith(prefix)),
  );
  const managedWarnings = (feed.warnings ?? []).filter(
    (warning: unknown) =>
      warningPrefixes.some((prefix: string) => String(warning).startsWith(prefix)),
  );
  const next: JsonRecord = {
    ...snapshot,
    projects: [...projectsById.values()],
    sources: [...sourcesById.values()],
    warnings: [...new Set([...priorWarnings, ...managedWarnings])],
    coverage: {
      ...(snapshot.coverage ?? {}),
      states: (snapshot.coverage?.states ?? []).map(
        (state: JsonRecord) => ({ ...state }),
      ),
    },
    inventory: { ...(snapshot.inventory ?? {}) },
  };

  for (const source of freshSources) {
    if (source.status !== "live") continue;
    const code = sourceState(source);
    const field = sourceCoverageField(source);
    if (!code || !field) continue;
    const state = (next.coverage?.states ?? []).find(
      (candidate: JsonRecord) => stateCode(candidate.code) === code,
    );
    if (state) state[field] = "partial";
  }

  aggregateSnapshot(next);
  return next;
}


async function txdotFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "ftp.txdot.gov") return fetch(input, init);
  return fetch(input, {
    ...init,
    dispatcher: txdotAgent,
  } as RequestInit & { dispatcher: Agent });
}


export async function repairTxDotFeed(feed: JsonRecord): Promise<void> {
  try {
    const result = await fetchTexasDotSource({
      mode: "view",
      fetchImpl: txdotFetch as typeof fetch,
    });
    feed.sources = (feed.sources ?? []).filter(
      (source: JsonRecord) => source.id !== TEXAS_DOT_SOURCE_ID,
    );
    feed.sources.push(result.source);
    feed.projects = (feed.projects ?? []).filter(
      (project: JsonRecord) => project.sourceId !== TEXAS_DOT_SOURCE_ID,
    );
    feed.projects.push(...result.projects);
    feed.warnings = (feed.warnings ?? []).filter(
      (warning: unknown) => !String(warning).startsWith("TxDOT "),
    );
    if (result.source.status !== "live") {
      feed.warnings.push(
        "TxDOT State-Let Construction and Maintenance: core project, plan, and proposal data refreshed; one or more supplementary exports remain incomplete",
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    feed.warnings = [
      ...(feed.warnings ?? []).filter(
        (warning: unknown) => !String(warning).startsWith("TxDOT "),
      ),
      `TxDOT State-Let Construction and Maintenance: ${detail}`,
    ];
  }
}


function replaceFeedPartition(
  feed: JsonRecord,
  sourceId: string,
  source: JsonRecord,
  projects: JsonRecord[],
): void {
  const priorSource = (feed.sources ?? []).find(
    (candidate: JsonRecord) => candidate.id === sourceId,
  );
  const warningPrefixes = [
    `${String(priorSource?.name ?? "")}:`,
    `${String(source.name ?? "")}:`,
  ].filter((prefix) => prefix !== ":");
  feed.sources = (feed.sources ?? []).filter(
    (candidate: JsonRecord) => candidate.id !== sourceId,
  );
  feed.sources.push(source);
  feed.projects = (feed.projects ?? []).filter(
    (project: JsonRecord) => project.sourceId !== sourceId,
  );
  const projectsById = new Map<string, JsonRecord>();
  for (const project of projects) {
    projectsById.set(String(project.id), project);
  }
  feed.projects.push(...projectsById.values());
  feed.warnings = (feed.warnings ?? []).filter(
    (warning: unknown) =>
      !warningPrefixes.some((prefix) => String(warning).startsWith(prefix)),
  );
}


export async function fetchCompleteFloridaDotRoute(): Promise<{
  projects: JsonRecord[];
  source: JsonRecord;
}> {
  const projectsById = new Map<string, JsonRecord>();
  let cursor: JsonRecord = { offset: 0 };
  let lastSource: JsonRecord | undefined;
  for (let pageNumber = 1; pageNumber <= MAX_COMPLETE_ROUTE_PAGES; pageNumber += 1) {
    const result = await fetchPublicDotSource(FLORIDA_DOT_SOURCE_ID, {
      mode: "ingest",
      lane: "backfill",
      sourceCursors: { [FLORIDA_DOT_SOURCE_ID]: cursor },
    });
    lastSource = result.source;
    for (const project of result.projects) {
      projectsById.set(String(project.id), project);
    }
    if (!result.page.hasMore) {
      const projects = [...projectsById.values()];
      return {
        projects,
        source: {
          ...lastSource,
          loadedCount: projects.length,
          snapshotComplete: true,
          note: `${String(lastSource.note ?? "").trim()} Full current-route refresh loaded ${projects.length.toLocaleString("en-US")} unique projects.`,
        },
      };
    }
    const nextCursor = result.page.nextCursor;
    const currentOffset = Number(cursor.offset ?? 0);
    const nextOffset = Number(nextCursor.offset ?? 0);
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= currentOffset) {
      throw new Error("FDOT current-route pagination did not advance");
    }
    cursor = nextCursor;
  }
  throw new Error(
    `FDOT current-route refresh exceeded ${MAX_COMPLETE_ROUTE_PAGES} guarded pages`,
  );
}


export async function integrateVerifiedCollectionRoutes(
  feed: JsonRecord,
): Promise<JsonRecord[]> {
  const collected: JsonRecord[] = [];
  const [nycOutcome, floridaOutcome] = await Promise.allSettled([
    fetchNycCityRecordCurrentConstructionSolicitations(),
    fetchCompleteFloridaDotRoute(),
  ]);

  if (nycOutcome.status === "fulfilled") {
    const current = nycOutcome.value;
    const priorSource = (feed.sources ?? []).find(
      (source: JsonRecord) => source.id === NYC_CITY_RECORD_SOURCE_ID,
    );
    if (!priorSource) {
      feed.warnings = [
        ...(feed.warnings ?? []),
        "NYC City Record procurement notices: expanded current-solicitation route returned without a registered source",
      ];
    } else {
      const checkedAt = new Date().toISOString();
      replaceFeedPartition(
        feed,
        NYC_CITY_RECORD_SOURCE_ID,
        {
          ...priorSource,
          status: "live",
          recordCount: current.sourceReportedMatches,
          loadedCount: current.returnedProjects,
          snapshotComplete: !current.resultLimitReached,
          lastChecked: checkedAt,
          note: `${String(priorSource.note ?? "").trim()} Expanded current-solicitation route loaded ${current.returnedProjects.toLocaleString("en-US")} of ${current.sourceReportedMatches.toLocaleString("en-US")} still-open notices ordered by deadline.`,
        },
        current.projects,
      );
      collected.push({
        sourceId: NYC_CITY_RECORD_SOURCE_ID,
        projects: current.returnedProjects,
        sourceReported: current.sourceReportedMatches,
        snapshotComplete: !current.resultLimitReached,
      });
    }
  } else {
    const detail = nycOutcome.reason instanceof Error
      ? nycOutcome.reason.message
      : String(nycOutcome.reason);
    feed.warnings = [
      ...(feed.warnings ?? []),
      `NYC City Record procurement notices: expanded current-solicitation route failed: ${detail}`,
    ];
  }

  if (floridaOutcome.status === "fulfilled") {
    replaceFeedPartition(
      feed,
      FLORIDA_DOT_SOURCE_ID,
      floridaOutcome.value.source,
      floridaOutcome.value.projects,
    );
    collected.push({
      sourceId: FLORIDA_DOT_SOURCE_ID,
      projects: floridaOutcome.value.projects.length,
      sourceReported: floridaOutcome.value.source.recordCount,
      snapshotComplete: floridaOutcome.value.source.snapshotComplete,
    });
  } else {
    const detail = floridaOutcome.reason instanceof Error
      ? floridaOutcome.reason.message
      : String(floridaOutcome.reason);
    feed.warnings = [
      ...(feed.warnings ?? []),
      `FDOT Statewide Lettings: expanded current-route refresh failed: ${detail}`,
    ];
  }
  return collected;
}


export async function handler(): Promise<JsonRecord> {
  const bucket = process.env.BIDATLAS_CATALOG_BUCKET;
  const key = process.env.BIDATLAS_CATALOG_KEY ?? "current-projects.json";
  if (!bucket) throw new Error("BIDATLAS_CATALOG_BUCKET is required");

  const current = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const snapshot = JSON.parse(await current.Body!.transformToString());
  const feed = await getProjectFeed({ mode: "view" });
  const collectionRoutes = await integrateVerifiedCollectionRoutes(feed);
  await repairTxDotFeed(feed);
  const refreshed = mergeFeed(snapshot, feed);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(refreshed),
    ContentType: "application/json",
    CacheControl: "no-cache, no-store, must-revalidate",
    Metadata: {
      "refreshed-at": refreshed.generatedAt,
      scope: "legacy-public-connectors",
    },
  }));

  const managedSources = (feed.sources ?? []).filter(
    (source: JsonRecord) =>
      MANAGED_SOURCE_IDS.has(String(source.id)),
  );
  const managedProjectSourceIds = new Set(
    (feed.projects ?? [])
      .map((project: JsonRecord) => String(project.sourceId))
      .filter((sourceId: string) => MANAGED_SOURCE_IDS.has(sourceId)),
  );
  const usableSources = managedSources.filter(
    (source: JsonRecord) =>
      source.status === "live"
      || (source.status === "degraded" && managedProjectSourceIds.has(String(source.id))),
  );
  return {
    status: "ok",
    refreshedAt: refreshed.generatedAt,
    connectedSources: usableSources.length,
    healthySources: managedSources.filter((source: JsonRecord) => source.status === "live").length,
    degradedSources: managedSources
      .filter((source: JsonRecord) => source.status === "degraded")
      .map((source: JsonRecord) => source.id),
    refreshedProjects: (feed.projects ?? []).filter(
      (project: JsonRecord) => MANAGED_SOURCE_IDS.has(String(project.sourceId)),
    ).length,
    collectionRoutes,
    warnings: refreshed.warnings ?? [],
  };
}
