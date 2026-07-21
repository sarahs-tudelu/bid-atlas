import {
  SEATTLE_PERMIT_SOURCE_ID,
  SEATTLE_PERMIT_SOURCE_TEMPLATE,
  lookupSeattlePermitProject,
} from "../connectors.ts";
import {
  SOCRATA_CITY_SOURCE_IDS,
  SOCRATA_CITY_SOURCE_TEMPLATES,
  lookupSocrataCityProject,
  type SocrataCitySourceId,
} from "../socrata-city-connectors.ts";
import {
  STANDARDIZED_SOURCE_DEFINITIONS,
  STANDARDIZED_SOURCE_IDS,
  STANDARDIZED_SOURCE_TEMPLATES,
  lookupStandardizedProject,
  type StandardizedSourceId,
} from "../standardized-source-connectors.ts";
import type { ProjectParticipant, ProjectRecord, ProjectStage } from "../types.ts";
import {
  UNKNOWN_SOURCE_ACTIVITY_AT,
  type ResolvedResearchProject,
} from "./caltrans.ts";
import {
  ProjectResearchError,
  cleanResearchText,
  normalizeOfficialHttpsUrl,
} from "./contracts.ts";
import type {
  PlanExtractionHandoff,
  ResearchFinding,
  ResearchSourceAttempt,
} from "./types.ts";

const NYC_PROCUREMENT_SOURCE_ID = "nyc-city-record-construction-procurement";
const MAX_EXACT_RECORD_ID_LENGTH = 160;
const PROJECT_STAGES = new Set<ProjectStage>([
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
]);

export const CONFIGURED_PERMIT_RESEARCH_SOURCE_IDS = [
  SEATTLE_PERMIT_SOURCE_ID,
  ...SOCRATA_CITY_SOURCE_IDS.filter((sourceId) => sourceId !== NYC_PROCUREMENT_SOURCE_ID),
  ...STANDARDIZED_SOURCE_IDS,
] as const;

export type ConfiguredPermitResearchSourceId =
  | typeof SEATTLE_PERMIT_SOURCE_ID
  | Exclude<SocrataCitySourceId, typeof NYC_PROCUREMENT_SOURCE_ID>
  | StandardizedSourceId;

export type ConfiguredPermitLookup = (
  projectId: string,
) => Promise<ProjectRecord | null | undefined>;

export type ConfiguredPermitSourceRegistration = {
  id: ConfiguredPermitResearchSourceId;
  name: string;
  owner: string;
  jurisdictionName: string;
  jurisdictionLevel: "local";
  connector: string;
  sourceClass: "permits";
  sourceUrl: string;
  accessMode: "open";
  cadenceMinutes: number;
  status: "live";
  lifecycleStages: string[];
};

export type ConfiguredPermitResolution = {
  project: ResolvedResearchProject;
  findings: ResearchFinding[];
  handoffs: Omit<PlanExtractionHandoff, "id" | "requestedAt" | "updatedAt">[];
  attempt: Omit<ResearchSourceAttempt, "id">;
};

function isSocrataPermitSource(
  sourceId: string,
): sourceId is Exclude<SocrataCitySourceId, typeof NYC_PROCUREMENT_SOURCE_ID> {
  return sourceId !== NYC_PROCUREMENT_SOURCE_ID &&
    (SOCRATA_CITY_SOURCE_IDS as readonly string[]).includes(sourceId);
}

function isStandardizedPermitSource(sourceId: string): sourceId is StandardizedSourceId {
  return (STANDARDIZED_SOURCE_IDS as readonly string[]).includes(sourceId);
}

function isSeattlePermitSource(
  sourceId: string,
): sourceId is typeof SEATTLE_PERMIT_SOURCE_ID {
  return sourceId === SEATTLE_PERMIT_SOURCE_ID;
}

function configuredSourceId(value: string): ConfiguredPermitResearchSourceId | undefined {
  return (CONFIGURED_PERMIT_RESEARCH_SOURCE_IDS as readonly string[]).find(
    (sourceId) => value.startsWith(`${sourceId}:`),
  ) as ConfiguredPermitResearchSourceId | undefined;
}

function sourceTemplate(sourceId: ConfiguredPermitResearchSourceId) {
  return isSeattlePermitSource(sourceId)
    ? SEATTLE_PERMIT_SOURCE_TEMPLATE
    : isSocrataPermitSource(sourceId)
    ? SOCRATA_CITY_SOURCE_TEMPLATES[sourceId]
    : STANDARDIZED_SOURCE_TEMPLATES[sourceId];
}

function cadenceMinutes(value: string): number {
  const cadence = value.toLowerCase();
  if (cadence.includes("weekly")) return 7 * 24 * 60;
  // This is the bounded BidAtlas refresh schedule, not a claim that the
  // publisher changes its data on that interval.
  return 24 * 60;
}

export function configuredPermitSourceRegistration(
  sourceId: string,
): ConfiguredPermitSourceRegistration | undefined {
  if (
    !isSeattlePermitSource(sourceId) &&
    !isSocrataPermitSource(sourceId) &&
    !isStandardizedPermitSource(sourceId)
  ) {
    return undefined;
  }
  const template = sourceTemplate(sourceId);
  const connector = isSeattlePermitSource(sourceId) || isSocrataPermitSource(sourceId)
    ? "socrata-exact"
    : `${STANDARDIZED_SOURCE_DEFINITIONS[sourceId].platform}-exact`;
  return {
    id: sourceId,
    name: template.name,
    owner: template.owner,
    jurisdictionName: template.jurisdiction,
    jurisdictionLevel: "local",
    connector,
    sourceClass: "permits",
    sourceUrl: normalizeOfficialHttpsUrl(template.url),
    accessMode: "open",
    cadenceMinutes: cadenceMinutes(template.cadence),
    status: "live",
    lifecycleStages: [...template.stages],
  };
}

/**
 * Recognizes only an exact identity belonging to a configured permit adapter.
 * Quotes, query delimiters, and SQL punctuation are not valid permit identity
 * input on this server-side research path. The connector still escapes its
 * own source query as a second line of defense.
 */
export function parseConfiguredPermitProjectId(
  projectId: string,
): { sourceId: ConfiguredPermitResearchSourceId; recordId: string } | undefined {
  const sourceId = configuredSourceId(projectId);
  if (!sourceId || projectId !== projectId.trim() || projectId.length > 180) return undefined;
  const recordId = projectId.slice(sourceId.length + 1);
  if (
    !recordId ||
    recordId.length > MAX_EXACT_RECORD_ID_LENGTH ||
    !/^[\x20-\x7e]+$/.test(recordId) ||
    /['"`;=\\?%]/.test(recordId)
  ) {
    return undefined;
  }
  return { sourceId, recordId };
}

async function defaultConfiguredPermitLookup(
  projectId: string,
): Promise<ProjectRecord | null | undefined> {
  const parsed = parseConfiguredPermitProjectId(projectId);
  if (!parsed) return undefined;
  return isSeattlePermitSource(parsed.sourceId)
    ? lookupSeattlePermitProject(projectId)
    : isSocrataPermitSource(parsed.sourceId)
    ? lookupSocrataCityProject(projectId)
    : lookupStandardizedProject(projectId);
}

function sourceAllowedHosts(sourceId: ConfiguredPermitResearchSourceId): string[] {
  const registration = configuredPermitSourceRegistration(sourceId);
  if (!registration) return [];
  const urls = [registration.sourceUrl];
  if (isStandardizedPermitSource(sourceId)) {
    const definition = STANDARDIZED_SOURCE_DEFINITIONS[sourceId];
    urls.push(definition.platform === "arcgis" ? definition.layerUrl : definition.apiRoot);
    for (const host of [
      ...definition.mapping.documentUrlFields,
      ...definition.mapping.contactUrlFields,
    ].flatMap((field) => field.allowedHosts)) {
      urls.push(`https://${host}`);
    }
  }
  if (sourceId === "austin-issued-construction-permits") {
    urls.push("https://austintexas.gov/");
  }
  if (isSeattlePermitSource(sourceId)) {
    // The official Socrata API provides the exact record, while its literal
    // source link points to Seattle Services' Accela permit detail page.
    urls.push(
      "https://cos-data.seattle.gov/",
      "https://services.seattle.gov/",
    );
  }
  return [...new Set(urls.map((url) => new URL(url).hostname.toLowerCase()))];
}

function verifiedSourceUrl(
  value: string,
  sourceId: ConfiguredPermitResearchSourceId,
): string {
  const sourceUrl = normalizeOfficialHttpsUrl(value);
  const hostname = new URL(sourceUrl).hostname.toLowerCase();
  const allowedHosts = sourceAllowedHosts(sourceId);
  const allowed = allowedHosts.includes(hostname) || (
    sourceId === "austin-issued-construction-permits" &&
    hostname.endsWith(".austintexas.gov")
  );
  if (!allowed) {
    throw new ProjectResearchError(
      502,
      "invalid_configured_permit_project",
      "The exact permit lookup returned an unregistered official-source host.",
    );
  }
  return sourceUrl;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const cleaned = typeof value === "string" ? cleanResearchText(value, maxLength) : "";
  if (!cleaned) {
    throw new ProjectResearchError(
      502,
      "invalid_configured_permit_project",
      `The exact permit lookup did not return a usable ${field}.`,
    );
  }
  return cleaned;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = cleanResearchText(value, maxLength);
  return cleaned || undefined;
}

function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ProjectResearchError(
      502,
      "invalid_configured_permit_project",
      `The exact permit lookup returned an invalid ${field}.`,
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ProjectResearchError(
      502,
      "invalid_configured_permit_project",
      `The exact permit lookup returned an invalid ${field}.`,
    );
  }
  return parsed.toISOString();
}

function sourceActivityDate(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return UNKNOWN_SOURCE_ACTIVITY_AT;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : UNKNOWN_SOURCE_ACTIVITY_AT;
}

function publicEmail(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  return email && email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
    ? email
    : undefined;
}

function publicPhone(value: string | undefined): string | undefined {
  const phone = optionalText(value, 80);
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? phone : undefined;
}

function participantSourceVerified(
  participant: ProjectParticipant,
  sourceId: ConfiguredPermitResearchSourceId,
): boolean {
  if (!participant.sourceUrl) return false;
  try {
    verifiedSourceUrl(participant.sourceUrl, sourceId);
    return true;
  } catch {
    return false;
  }
}

function exactRecordEvidence(
  project: ProjectRecord,
  sourceId: ConfiguredPermitResearchSourceId,
  sourceUrl: string,
  observedAt: string,
): Pick<ConfiguredPermitResolution, "findings" | "handoffs"> {
  const sourceLabel = sourceTemplate(sourceId).name;
  const base = (evidence: string, method: "official-api" | "official-document-link") => ({
    sourceUrl,
    sourceId,
    sourceLabel,
    evidence: cleanResearchText(evidence, 700),
    observedAt,
    confidence: 0.96,
    provenance: {
      sourceUrl,
      sourceId,
      sourceLabel,
      retrievedAt: observedAt,
      method,
      strategy: "configured-exact-record" as const,
    },
  });
  const findings: ResearchFinding[] = [{
    id: crypto.randomUUID(),
    ...base(`Official permit status: ${project.status}`, "official-api"),
    kind: "lifecycle",
    stage: project.stage,
    officialStatus: requiredText(project.status, "status", 160),
    terminal: project.stage === "completed" || project.stage === "cancelled",
    terminalBasis:
      project.stage === "completed" || project.stage === "cancelled"
        ? "official-status-field"
        : "none",
  }];
  const location = [project.address, project.city, project.state, project.postalCode]
    .flatMap((value) => optionalText(value, 300) ?? [])
    .join(", ");
  if (location) {
    findings.push({
      id: crypto.randomUUID(),
      ...base(`Official permit location: ${location}`, "official-api"),
      kind: "scope",
      factType: "location",
      value: location,
    });
  }
  const publishedScope = [project.title, project.summary]
    .flatMap((value) => optionalText(value, 1_000) ?? [])
    .filter((value, index, all) => all.indexOf(value) === index)
    .join(" — ");
  if (publishedScope) {
    findings.push({
      id: crypto.randomUUID(),
      ...base(`Official permit scope metadata: ${publishedScope}`, "official-api"),
      kind: "scope",
      factType: "work-description",
      value: publishedScope,
    });
  }

  for (const participant of project.participants.slice(0, 40)) {
    const email = publicEmail(participant.email);
    const phone = publicPhone(participant.phone);
    if ((!email && !phone) || !participantSourceVerified(participant, sourceId)) continue;
    const name = optionalText(participant.name, 180);
    const organization = optionalText(participant.organization, 240) ??
      (participant.participantType === "organization" ? name : undefined);
    findings.push({
      id: crypto.randomUUID(),
      ...base(
        [name, organization, email, phone].filter(Boolean).join(" · "),
        "official-api",
      ),
      kind: "contact",
      role: optionalText(participant.role, 100),
      ...(name && name !== email && name !== phone ? { displayName: name } : {}),
      ...(organization ? { organization } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
    });
  }

  const handoffs: ConfiguredPermitResolution["handoffs"] = [];
  for (const document of project.documents.slice(0, 40)) {
    const documentType = document.kind === "plans"
      ? "plans" as const
      : document.kind === "specifications"
        ? "specifications" as const
        : document.kind === "addendum"
          ? "addenda" as const
          : undefined;
    if (!documentType || document.access !== "public" || document.indexStatus === "not-public") {
      continue;
    }
    let documentUrl: string;
    try {
      documentUrl = verifiedSourceUrl(document.url, sourceId);
    } catch {
      continue;
    }
    const findingId = crypto.randomUUID();
    findings.push({
      id: findingId,
      ...base(`Official ${documentType} link: ${document.name}`, "official-document-link"),
      kind: "document",
      name: requiredText(document.name, "document name", 240),
      documentType,
      url: documentUrl,
      access: "public-link",
      textExtractionStatus: "awaiting-extractor",
    });
    handoffs.push({
      findingId,
      handoffType: "plan-text-extraction",
      status: "awaiting-extractor",
      sourceUrl: documentUrl,
      detail: "The configured official adapter exposed this plan-like public link. Content retrieval, OCR, and CAD conversion remain in the authorized extraction pipeline.",
    });
  }
  return { findings, handoffs };
}

/**
 * Resolves a configured private permit through its fixed server-side adapter.
 * The caller supplies only the canonical ID; it cannot provide a source URL,
 * record content, contact, or document classification.
 */
export async function resolveExactConfiguredPermitProject(
  projectId: string,
  lookup: ConfiguredPermitLookup = defaultConfiguredPermitLookup,
  now: Date = new Date(),
): Promise<ConfiguredPermitResolution | null> {
  const startedMs = Date.now();
  const parsed = parseConfiguredPermitProjectId(projectId);
  if (!parsed) return null;
  const project = await lookup(projectId);
  if (!project) return null;
  const template = sourceTemplate(parsed.sourceId);
  if (
    project.id !== projectId ||
    project.sourceId !== parsed.sourceId ||
    project.sourceRecordId !== parsed.recordId ||
    project.sourceName !== template.name ||
    project.confidence !== "official" ||
    project.provenance !== "live-api" ||
    !PROJECT_STAGES.has(project.stage)
  ) {
    throw new ProjectResearchError(
      502,
      "invalid_configured_permit_project",
      "The exact permit lookup returned inconsistent source identity or provenance.",
    );
  }
  const sourceUrl = verifiedSourceUrl(project.sourceUrl, parsed.sourceId);
  const title = requiredText(project.title, "title", 500);
  const status = requiredText(project.status, "status", 160);
  const agency = requiredText(project.agency, "agency", 300);
  const observedAt = now.toISOString();
  const evidence = exactRecordEvidence(project, parsed.sourceId, sourceUrl, observedAt);
  return {
    project: {
      id: project.id,
      canonicalKey: project.id,
      title,
      summary: optionalText(project.summary, 2_000) ?? "",
      stage: project.stage,
      status,
      agency,
      ...(optionalText(project.address, 500) ? { address: optionalText(project.address, 500) } : {}),
      ...(optionalText(project.city, 180) ? { city: optionalText(project.city, 180) } : {}),
      ...(optionalText(project.county, 180) ? { county: optionalText(project.county, 180) } : {}),
      ...(optionalText(project.state, 20) ? { state: optionalText(project.state, 20) } : {}),
      ...(optionalText(project.postalCode, 30) ? { postalCode: optionalText(project.postalCode, 30) } : {}),
      ...(typeof project.value === "number" && Number.isFinite(project.value)
        ? { estimatedValue: project.value }
        : {}),
      ...(optionalDate(project.postedAt, "published date") ? { postedAt: optionalDate(project.postedAt, "published date") } : {}),
      ...(optionalDate(project.bidDate, "bid date") ? { bidDate: optionalDate(project.bidDate, "bid date") } : {}),
      // Connector records use the Unix epoch when the publisher exposes no
      // usable activity field. Persisting that sentinel keeps freshness
      // unclassified instead of substituting this research observation time.
      sourceActivityAt: sourceActivityDate(project.updatedAt),
      sourceId: parsed.sourceId,
      sourceRecordId: parsed.recordId,
      sourceUrl,
      sourceLabel: template.name,
    },
    ...evidence,
    attempt: {
      sourceId: parsed.sourceId,
      sourceUrl,
      finalUrl: sourceUrl,
      status: "complete",
      bytesRead: 0,
      durationMs: Math.max(0, Date.now() - startedMs),
      startedAt: observedAt,
      completedAt: observedAt,
    },
  };
}
