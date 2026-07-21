import {
  caltransResearchSources,
  parseCaltransProjectId,
  resolveExactCaltransProject,
} from "./caltrans.ts";
import {
  MAX_RESEARCH_SOURCES,
  RESEARCH_FRESHNESS_MS,
  RESEARCH_TOTAL_TIMEOUT_MS,
  ProjectResearchError,
  cleanResearchText,
} from "./contracts.ts";
import { extractCaltransContractDetail, extractGenericOfficialPage } from "./extractors.ts";
import {
  fetchOfficialText,
  type ResearchFetch,
  type ResearchHostResolver,
} from "./network.ts";
import {
  parseNycCityRecordProjectId,
  resolveExactNycCityRecordProject,
  type NycCityRecordLookup,
} from "./nyc-city-record.ts";
import {
  parseConfiguredPermitProjectId,
  resolveExactConfiguredPermitProject,
  type ConfiguredPermitLookup,
} from "./configured-permit.ts";
import {
  parsePublicDotProjectId,
  resolveExactPublicDotProject,
  type PublicDotLookup,
} from "./public-dot.ts";
import {
  claimProjectResearch,
  finalizeProjectResearch,
  findKnownResearchProject,
  getProjectResearchRecord,
  loadProjectOfficialSources,
  persistResolvedResearchProject,
  type ResearchD1Database,
} from "./repository.ts";
import type {
  OfficialResearchSource,
  ProjectResearchRecord,
  ResearchFinding,
  ResearchGap,
  ResearchRunOutput,
  ResearchSourceAttempt,
} from "./types.ts";

type ResearchDependencies = {
  fetchImpl?: ResearchFetch;
  resolveHost?: ResearchHostResolver;
  lookupNycCityRecordProject?: NycCityRecordLookup;
  lookupConfiguredPermitProject?: ConfiguredPermitLookup;
  lookupPublicDotProject?: PublicDotLookup;
  now?: () => Date;
  totalTimeoutMs?: number;
};

function uniqueSources(sources: OfficialResearchSource[]): OfficialResearchSource[] {
  const unique = new Map<string, OfficialResearchSource>();
  for (const source of sources) {
    const key = `${source.strategy}|${source.url}`;
    if (!unique.has(key)) unique.set(key, source);
  }
  return [...unique.values()].slice(0, MAX_RESEARCH_SOURCES);
}

function sourceFailureAttempt(
  source: OfficialResearchSource,
  startedAt: string,
  startedMs: number,
  error: unknown,
  now: Date,
): Omit<ResearchSourceAttempt, "id"> {
  const code = error instanceof Error && "code" in error ? String(error.code) : "official_source_failed";
  const message = error instanceof Error ? cleanResearchText(error.message, 300) : "The official source could not be researched.";
  return {
    ...(source.sourceId ? { sourceId: source.sourceId } : {}),
    sourceUrl: source.url,
    status: "failed",
    bytesRead: 0,
    durationMs: Math.max(0, Date.now() - startedMs),
    errorCode: code,
    errorMessage: message,
    startedAt,
    completedAt: now.toISOString(),
  };
}

function gapsFor(findings: ResearchFinding[], attempts: ResearchRunOutput["attempts"]): Omit<ResearchGap, "id">[] {
  const gaps: Omit<ResearchGap, "id">[] = [];
  if (!findings.some((finding) => finding.kind === "contact")) {
    gaps.push({
      gapType: "contact",
      status: "open",
      message: "No named person, literal public email, or literal public telephone number was observed in the bounded official sources.",
      nextAction: "Check newly posted plan sheets, bidder/plan-holder lists, addenda, and the issuing agency contact page on the next refresh. Do not invent or infer a person.",
    });
  }
  if (!findings.some((finding) =>
    finding.kind === "document" &&
    ["plans", "specifications", "drawings", "cad"].includes(finding.documentType)
  )) {
    gaps.push({
      gapType: "documents",
      status: "open",
      message: "No official plan, drawing, specification, or CAD file was exposed by the researched pages. Bidder lists, plan-holder lists, tabulations, addenda, and bid forms are useful links but do not prove that plans are available.",
      nextAction: "Refresh after advertisement or addenda publication; account-gated or NDA material requires an approved connector and is not bypassed.",
    });
  }
  if (!findings.some((finding) =>
    finding.kind === "scope" &&
    ["work-description", "quantity-item", "scope-clause"].includes(finding.factType)
  )) {
    gaps.push({
      gapType: "scope",
      status: "open",
      message: "No usable project scope clause or item detail was observed in the bounded official response.",
      nextAction: "Run the authorized plan/specification extraction handoff when an official document becomes available.",
    });
  }
  if (!findings.some((finding) => finding.kind === "lifecycle")) {
    gaps.push({
      gapType: "lifecycle",
      status: "open",
      message: "No exact official lifecycle/status field was observed during this pass.",
      nextAction: "Reconcile on the next source refresh. Never infer completion from project age or a passed bid date.",
    });
  }
  if (attempts.some((attempt) => attempt.status === "failed")) {
    gaps.push({
      gapType: "source-unavailable",
      status: "open",
      message: "At least one allowlisted official source failed or exceeded a safety bound, so this result may be incomplete.",
      nextAction: "Retry after the durable backoff window; do not substitute unverified URLs.",
    });
  }
  return gaps;
}

async function ensureKnownProject(
  db: ResearchD1Database,
  requestedProjectId: string,
  controller: AbortController,
  dependencies: ResearchDependencies,
): Promise<{
  projectId: string;
  resolutionAttempt?: Omit<ResearchSourceAttempt, "id">;
  detailUrl?: string;
  findings?: ResearchFinding[];
  handoffs?: ResearchRunOutput["handoffs"];
}> {
  const existing = await findKnownResearchProject(db, requestedProjectId);

  const nycRequestId = parseNycCityRecordProjectId(requestedProjectId);
  if (nycRequestId) {
    let resolved;
    try {
      resolved = await resolveExactNycCityRecordProject(
        requestedProjectId,
        dependencies.lookupNycCityRecordProject,
      );
    } catch (error) {
      if (error instanceof ProjectResearchError) throw error;
      throw new ProjectResearchError(
        502,
        "nyc_city_record_lookup_failed",
        "The official NYC City Record exact-project lookup failed.",
      );
    }
    if (!resolved) {
      throw new ProjectResearchError(
        404,
        "known_project_not_found",
        `NYC City Record request ${nycRequestId} was not present in the configured construction-procurement source.`,
      );
    }
    const now = (dependencies.now?.() ?? new Date()).toISOString();
    const project = await persistResolvedResearchProject(db, resolved, now);
    return { projectId: project.id, detailUrl: resolved.sourceUrl };
  }

  const configuredPermitId = parseConfiguredPermitProjectId(requestedProjectId);
  if (configuredPermitId) {
    let resolved;
    try {
      resolved = await resolveExactConfiguredPermitProject(
        requestedProjectId,
        dependencies.lookupConfiguredPermitProject,
        dependencies.now?.() ?? new Date(),
      );
    } catch (error) {
      if (error instanceof ProjectResearchError) throw error;
      throw new ProjectResearchError(
        502,
        "configured_permit_lookup_failed",
        "The configured official permit exact-project lookup failed.",
      );
    }
    if (!resolved) {
      throw new ProjectResearchError(
        404,
        "known_project_not_found",
        `Permit record ${configuredPermitId.recordId} was not present in the configured ${configuredPermitId.sourceId} source.`,
      );
    }
    const now = (dependencies.now?.() ?? new Date()).toISOString();
    const project = await persistResolvedResearchProject(db, resolved.project, now);
    return {
      projectId: project.id,
      resolutionAttempt: resolved.attempt,
      detailUrl: resolved.project.sourceUrl,
      findings: resolved.findings,
      handoffs: resolved.handoffs,
    };
  }

  const publicDotId = parsePublicDotProjectId(requestedProjectId);
  if (publicDotId) {
    let resolved;
    try {
      resolved = await resolveExactPublicDotProject(
        requestedProjectId,
        dependencies.lookupPublicDotProject,
        dependencies.now?.() ?? new Date(),
      );
    } catch (error) {
      if (error instanceof ProjectResearchError) throw error;
      throw new ProjectResearchError(
        502,
        "public_dot_lookup_failed",
        "The official DOT exact-project lookup failed.",
      );
    }
    if (!resolved) {
      throw new ProjectResearchError(
        404,
        "known_project_not_found",
        `DOT contract ${publicDotId.recordId} was not present in the configured ${publicDotId.sourceId} source.`,
      );
    }
    const now = (dependencies.now?.() ?? new Date()).toISOString();
    const project = await persistResolvedResearchProject(db, resolved.project, now);
    return {
      projectId: project.id,
      resolutionAttempt: resolved.attempt,
      detailUrl: resolved.project.sourceUrl,
      findings: resolved.findings,
      handoffs: resolved.handoffs,
    };
  }

  const contractId = parseCaltransProjectId(requestedProjectId);
  if (!contractId) {
    if (existing) return { projectId: existing.id };
    throw new ProjectResearchError(404, "known_project_not_found", "Research can run only for an exact project produced by a configured official adapter.");
  }
  const resolved = await resolveExactCaltransProject(requestedProjectId, {
    fetchImpl: dependencies.fetchImpl,
    resolveHost: dependencies.resolveHost,
    parentSignal: controller.signal,
    now: dependencies.now?.() ?? new Date(),
  });
  if (!resolved.project) {
    throw new ProjectResearchError(
      resolved.attempt.status === "failed" ? 502 : 404,
      resolved.attempt.errorCode ?? "known_project_not_found",
      resolved.attempt.errorMessage ?? "The exact project was not present on the official Caltrans adapter.",
    );
  }
  const now = (dependencies.now?.() ?? new Date()).toISOString();
  const project = await persistResolvedResearchProject(db, resolved.project, now);
  return { projectId: project.id, resolutionAttempt: resolved.attempt, detailUrl: resolved.project.sourceUrl };
}

function findingDedupeKey(finding: ResearchFinding): string {
  const value = finding.kind === "contact"
    ? `${finding.email ?? ""}|${finding.phone ?? ""}|${finding.displayName ?? ""}`
    : finding.kind === "document"
      ? finding.url
      : finding.kind === "scope"
        ? `${finding.factType}|${finding.value}`
        : `${finding.officialStatus}|${finding.sourceUrl}`;
  return cleanResearchText(`${finding.kind}|${value}`.toLowerCase(), 700);
}

function dedupeRunEvidence(output: ResearchRunOutput): void {
  const byKey = new Map<string, ResearchFinding>();
  const replacementIds = new Map<string, string>();
  for (const finding of output.findings) {
    const key = findingDedupeKey(finding);
    const existing = byKey.get(key);
    if (existing) {
      replacementIds.set(finding.id, existing.id);
    } else {
      byKey.set(key, finding);
    }
  }
  output.findings = [...byKey.values()];
  const handoffs = new Map<string, ResearchRunOutput["handoffs"][number]>();
  for (const handoff of output.handoffs) {
    const findingId = handoff.findingId
      ? replacementIds.get(handoff.findingId) ?? handoff.findingId
      : undefined;
    const normalized = findingId ? { ...handoff, findingId } : handoff;
    const key = `${handoff.handoffType}|${handoff.sourceUrl}`;
    if (!handoffs.has(key)) handoffs.set(key, normalized);
  }
  output.handoffs = [...handoffs.values()];
}

export async function triggerProjectResearch(
  db: ResearchD1Database,
  requestedProjectId: string,
  requestedBy: string,
  force = false,
  dependencies: ResearchDependencies = {},
): Promise<ProjectResearchRecord> {
  const totalController = new AbortController();
  const totalTimeout = setTimeout(
    () => totalController.abort(),
    dependencies.totalTimeoutMs ?? RESEARCH_TOTAL_TIMEOUT_MS,
  );
  try {
    const known = await ensureKnownProject(db, requestedProjectId, totalController, dependencies);
    const now = dependencies.now?.() ?? new Date();
    const claim = await claimProjectResearch(db, known.projectId, requestedBy, force, now);
    if (!claim) {
      const current = await getProjectResearchRecord(db, known.projectId, { authenticated: true, cached: true });
      if (!current) throw new ProjectResearchError(500, "research_cache_unavailable", "The existing research cache could not be read.");
      return current;
    }

    const storedSources = await loadProjectOfficialSources(db, known.projectId);
    const caltransContract = parseCaltransProjectId(known.projectId);
    const sources = uniqueSources([
      ...storedSources.filter((source) => {
        // Configured permit resolution already performed the exact fixed-API
        // lookup and emitted only role-mapped contacts and source fields. Do
        // not fetch the raw JSON again through the generic contact scraper:
        // an unlabeled applicant/homeowner email is not a verified outreach
        // contact merely because it appears in a public permit response.
        if (source.strategy === "configured-exact-record") return false;
        return !caltransContract || !["ccop.dot.ca.gov", "cdotprod.service-now.com"].includes(
          new URL(source.url).hostname.toLowerCase(),
        );
      }),
      ...(caltransContract ? caltransResearchSources(caltransContract, known.detailUrl ?? `https://cdotprod.service-now.com/cc`) : []),
    ]);
    const output: ResearchRunOutput = {
      findings: [...(known.findings ?? [])],
      gaps: [],
      handoffs: [...(known.handoffs ?? [])],
      attempts: known.resolutionAttempt ? [known.resolutionAttempt] : [],
    };

    for (const source of sources) {
      if (totalController.signal.aborted) break;
      const startedAt = (dependencies.now?.() ?? new Date()).toISOString();
      const startedMs = Date.now();
      try {
        const response = await fetchOfficialText(source.url, source.allowedHosts, {
          fetchImpl: dependencies.fetchImpl,
          resolveHost: dependencies.resolveHost,
          parentSignal: totalController.signal,
        });
        const observedAt = (dependencies.now?.() ?? new Date()).toISOString();
        const extracted = source.strategy === "caltrans-contract-detail" && caltransContract
          ? extractCaltransContractDetail(response.body, response.finalUrl, source, caltransContract, observedAt)
          : extractGenericOfficialPage(response.body, response.finalUrl, source, observedAt);
        output.findings.push(...extracted.findings);
        output.handoffs.push(...extracted.handoffs);
        output.attempts.push({
          ...(source.sourceId ? { sourceId: source.sourceId } : {}),
          sourceUrl: source.url,
          finalUrl: response.finalUrl,
          status: "complete",
          httpStatus: response.status,
          contentType: response.contentType,
          bytesRead: response.bytesRead,
          durationMs: Math.max(0, Date.now() - startedMs),
          startedAt,
          completedAt: observedAt,
        });
      } catch (error) {
        output.attempts.push(sourceFailureAttempt(source, startedAt, startedMs, error, dependencies.now?.() ?? new Date()));
      }
    }

    dedupeRunEvidence(output);
    output.gaps = gapsFor(output.findings, output.attempts);
    const completedSources = output.attempts.filter((attempt) => attempt.status === "complete").length;
    const hasEvidence = output.findings.length > 0;
    const finishedAt = dependencies.now?.() ?? new Date();
    if (completedSources === 0 && !hasEvidence) {
      const backoffMinutes = Math.min(360, 15 * (2 ** Math.max(0, claim.attempt - 1)));
      const nextRetryAt = claim.attempt < 3
        ? new Date(finishedAt.getTime() + backoffMinutes * 60_000)
        : undefined;
      await finalizeProjectResearch(db, claim, output, "failed", finishedAt, {
        nextRetryAt,
        errorCode: totalController.signal.aborted ? "research_total_timeout" : "no_official_source_completed",
        errorMessage: totalController.signal.aborted
          ? "The bounded research pass reached its total time limit."
          : "No allowlisted official source completed successfully.",
      });
    } else {
      const status = output.gaps.length ? "partial" : "complete";
      const freshness = status === "complete" ? RESEARCH_FRESHNESS_MS : 2 * 60 * 60 * 1_000;
      await finalizeProjectResearch(db, claim, output, status, finishedAt, {
        freshUntil: new Date(finishedAt.getTime() + freshness),
      });
    }
    const record = await getProjectResearchRecord(db, known.projectId, { authenticated: true, cached: false });
    if (!record) throw new ProjectResearchError(500, "research_result_unavailable", "The completed research result could not be read.");
    return record;
  } finally {
    clearTimeout(totalTimeout);
  }
}
