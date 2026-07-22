import {
  PUBLIC_DOT_SOURCE_IDS,
  PUBLIC_DOT_SOURCE_TEMPLATES,
  lookupPublicDotProject,
  type PublicDotSourceId,
} from "../public-dot-connectors.ts";
import type { ProjectParticipant, ProjectRecord } from "../types.ts";
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

const MAX_RECORD_ID_LENGTH = 160;

const ALLOWED_HOSTS: Record<PublicDotSourceId, readonly string[]> = {
  "washington-dot-contracting-opportunities": [
    "wsdot.wa.gov",
    "apps.wsdot.wa.gov",
    "ftp.wsdot.wa.gov",
  ],
  "illinois-dot-transportation-bulletin": [
    "webapps1.dot.illinois.gov",
    "webapps.dot.illinois.gov",
    "apps.dot.illinois.gov",
    "idot.illinois.gov",
  ],
  "texas-dot-state-let-construction": [
    "txdot.gov",
    "www.txdot.gov",
    "ftp.txdot.gov",
    "dot.state.tx.us",
    "www.dot.state.tx.us",
  ],
  "new-york-dot-construction-contracts": [
    "dot.ny.gov",
    "www.dot.ny.gov",
  ],
  "north-carolina-dot-highway-lettings": [
    "connect.ncdot.gov",
    "ncdot.gov",
    "www.ncdot.gov",
  ],
  "iowa-dot-plans-estimating-proposals": [
    "iowadot.gov",
    "www.iowadot.gov",
    "ia.iowadot.gov",
    "secure.iowadot.gov",
    "bidx.com",
    "www.bidx.com",
  ],
  "florida-dot-statewide-lettings": [
    "fdot.gov",
    "www.fdot.gov",
    "ftp.fdot.gov",
    "bqa.fdot.gov",
    "cpp.fdot.gov",
    "fdotwww.blob.core.windows.net",
  ],
  "virginia-dot-cabb-advertisements": [
    "cabb.virginiadot.org",
    "vdot.virginia.gov",
    "www.vdot.virginia.gov",
  ],
  "michigan-dot-bid-lettings": [
    "mdotjboss.state.mi.us",
    "michigan.gov",
    "www.michigan.gov",
    "milogintp.michigan.gov",
    "bidx.com",
    "www.bidx.com",
  ],
  "ohio-dot-filed-construction-projects": [
    "tims.dot.state.oh.us",
    "contracts.dot.state.oh.us",
  ],
  "pennsylvania-dot-ecms-bid-packages": ["www.ecms.penndot.pa.gov"],
};

export type PublicDotLookup = (
  projectId: string,
) => Promise<ProjectRecord | null | undefined>;

export type PublicDotResearchSourceRegistration = {
  id: PublicDotSourceId;
  name: string;
  owner: string;
  jurisdictionName: string;
  jurisdictionLevel: "state";
  connector: "public-dot-exact";
  sourceClass: "procurement";
  sourceUrl: string;
  accessMode: "open";
  cadenceMinutes: number;
  status: "live";
  lifecycleStages: string[];
};

export type PublicDotResearchResolution = {
  project: ResolvedResearchProject;
  findings: ResearchFinding[];
  handoffs: Omit<PlanExtractionHandoff, "id" | "requestedAt" | "updatedAt">[];
  attempt: Omit<ResearchSourceAttempt, "id">;
};

function configuredSourceId(value: string): PublicDotSourceId | undefined {
  return PUBLIC_DOT_SOURCE_IDS.find((sourceId) =>
    value.startsWith(`${sourceId}:`)
  );
}

export function parsePublicDotProjectId(
  projectId: string,
): { sourceId: PublicDotSourceId; recordId: string } | undefined {
  const sourceId = configuredSourceId(projectId);
  if (!sourceId || projectId !== projectId.trim() || projectId.length > 220) {
    return undefined;
  }
  const recordId = projectId.slice(sourceId.length + 1);
  if (
    !recordId ||
    recordId.length > MAX_RECORD_ID_LENGTH ||
    !/^[\x20-\x7e]+$/.test(recordId) ||
    /['"`;=\\?%]/.test(recordId)
  ) {
    return undefined;
  }
  return { sourceId, recordId };
}

export function publicDotSourceRegistration(
  sourceId: string,
): PublicDotResearchSourceRegistration | undefined {
  if (!(PUBLIC_DOT_SOURCE_IDS as readonly string[]).includes(sourceId)) {
    return undefined;
  }
  const typedSourceId = sourceId as PublicDotSourceId;
  const template = PUBLIC_DOT_SOURCE_TEMPLATES[typedSourceId];
  return {
    id: typedSourceId,
    name: template.name,
    owner: template.owner,
    jurisdictionName: template.jurisdiction,
    jurisdictionLevel: "state",
    connector: "public-dot-exact",
    sourceClass: "procurement",
    sourceUrl: normalizeOfficialHttpsUrl(template.url),
    accessMode: "open",
    cadenceMinutes: 24 * 60,
    status: "live",
    lifecycleStages: [...template.stages],
  };
}

function verifiedUrl(value: string, sourceId: PublicDotSourceId): string {
  const normalized = normalizeOfficialHttpsUrl(value);
  const hostname = new URL(normalized).hostname.toLowerCase();
  const allowed = ALLOWED_HOSTS[sourceId].some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
  if (!allowed) {
    throw new ProjectResearchError(
      502,
      "invalid_public_dot_project",
      "The exact DOT lookup returned an unregistered official-source host.",
    );
  }
  return normalized;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === "string" ? cleanResearchText(value, maxLength) : "";
  if (!text) {
    throw new ProjectResearchError(
      502,
      "invalid_public_dot_project",
      `The exact DOT lookup did not return a usable ${field}.`,
    );
  }
  return text;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = cleanResearchText(value, maxLength);
  return text || undefined;
}

function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ProjectResearchError(
      502,
      "invalid_public_dot_project",
      `The exact DOT lookup returned an invalid ${field}.`,
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ProjectResearchError(
      502,
      "invalid_public_dot_project",
      `The exact DOT lookup returned an invalid ${field}.`,
    );
  }
  return parsed.toISOString();
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

function participantVerified(
  participant: ProjectParticipant,
  sourceId: PublicDotSourceId,
): boolean {
  if (!participant.sourceUrl) return false;
  try {
    verifiedUrl(participant.sourceUrl, sourceId);
    return true;
  } catch {
    return false;
  }
}

function exactEvidence(
  project: ProjectRecord,
  sourceId: PublicDotSourceId,
  sourceUrl: string,
  observedAt: string,
): Pick<PublicDotResearchResolution, "findings" | "handoffs"> {
  const template = PUBLIC_DOT_SOURCE_TEMPLATES[sourceId];
  const base = (
    evidence: string,
    method: "official-api" | "official-document-link",
  ) => ({
    sourceUrl,
    sourceId,
    sourceLabel: template.name,
    evidence: cleanResearchText(evidence, 700),
    observedAt,
    confidence: 0.97,
    provenance: {
      sourceUrl,
      sourceId,
      sourceLabel: template.name,
      retrievedAt: observedAt,
      method,
      strategy: "configured-exact-record" as const,
    },
  });

  const findings: ResearchFinding[] = [{
    id: crypto.randomUUID(),
    ...base(`Official DOT status: ${project.status}`, "official-api"),
    kind: "lifecycle",
    stage: project.stage,
    officialStatus: requiredText(project.status, "status", 160),
    terminal: project.stage === "completed" || project.stage === "cancelled",
    terminalBasis:
      project.stage === "completed" || project.stage === "cancelled"
        ? "official-status-field"
        : "none",
  }];

  const location = [project.address, project.city, project.county, project.state]
    .flatMap((value) => optionalText(value, 300) ?? [])
    .join(", ");
  if (location) {
    findings.push({
      id: crypto.randomUUID(),
      ...base(`Official project location: ${location}`, "official-api"),
      kind: "scope",
      factType: "location",
      value: location,
    });
  }

  const scope = [project.title, project.summary]
    .flatMap((value) => optionalText(value, 1_000) ?? [])
    .filter((value, index, all) => all.indexOf(value) === index)
    .join(" ? ");
  if (scope) {
    findings.push({
      id: crypto.randomUUID(),
      ...base(`Official DOT scope: ${scope}`, "official-api"),
      kind: "scope",
      factType: "work-description",
      value: scope,
    });
  }

  for (const participant of project.participants.slice(0, 40)) {
    const email = publicEmail(participant.email);
    const phone = publicPhone(participant.phone);
    if ((!email && !phone) || !participantVerified(participant, sourceId)) continue;
    const name = optionalText(participant.name, 180);
    const organization = optionalText(participant.organization, 240) ??
      (participant.participantType === "organization" ? name : undefined);
    findings.push({
      id: crypto.randomUUID(),
      ...base(
        [name, organization, email, phone].filter(Boolean).join(" ? "),
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

  const handoffs: PublicDotResearchResolution["handoffs"] = [];
  for (const document of project.documents.slice(0, 80)) {
    const documentType = document.kind === "plans"
      ? "plans" as const
      : document.kind === "specifications"
        ? "specifications" as const
        : document.kind === "addendum"
          ? "addenda" as const
          : undefined;
    if (
      !documentType ||
      document.access !== "public" ||
      document.indexStatus === "metadata-only" ||
      document.indexStatus === "not-public"
    ) {
      continue;
    }
    let documentUrl: string;
    try {
      documentUrl = verifiedUrl(document.url, sourceId);
    } catch {
      continue;
    }
    const findingId = crypto.randomUUID();
    findings.push({
      id: findingId,
      ...base(
        `Official ${documentType} link: ${document.name}`,
        "official-document-link",
      ),
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
      detail:
        "The official DOT adapter exposed this exact public project file. Retrieval, OCR, and CAD conversion remain in the authorized document pipeline.",
    });
  }

  return { findings, handoffs };
}

export async function resolveExactPublicDotProject(
  projectId: string,
  lookup: PublicDotLookup = lookupPublicDotProject,
  now: Date = new Date(),
): Promise<PublicDotResearchResolution | null> {
  const startedMs = Date.now();
  const parsed = parsePublicDotProjectId(projectId);
  if (!parsed) return null;
  const project = await lookup(projectId);
  if (!project) return null;
  const template = PUBLIC_DOT_SOURCE_TEMPLATES[parsed.sourceId];
  if (
    project.id !== projectId ||
    project.sourceId !== parsed.sourceId ||
    project.sourceRecordId !== parsed.recordId ||
    project.sourceName !== template.name ||
    project.confidence !== "official" ||
    project.provenance !== "live-public-page" ||
    project.stage !== "bidding"
  ) {
    throw new ProjectResearchError(
      502,
      "invalid_public_dot_project",
      "The exact DOT lookup returned inconsistent source identity or provenance.",
    );
  }

  const sourceUrl = verifiedUrl(project.sourceUrl, parsed.sourceId);
  const title = requiredText(project.title, "title", 500);
  const status = requiredText(project.status, "status", 160);
  const agency = requiredText(project.agency, "agency", 300);
  const observedAt = now.toISOString();
  const evidence = exactEvidence(project, parsed.sourceId, sourceUrl, observedAt);
  const postedAt = optionalDate(project.postedAt, "published date");
  const bidDate = optionalDate(project.bidDate, "bid date");

  return {
    project: {
      id: project.id,
      canonicalKey: project.id,
      title,
      summary: optionalText(project.summary, 2_000) ?? "",
      stage: project.stage,
      status,
      agency,
      ...(optionalText(project.address, 500)
        ? { address: optionalText(project.address, 500) }
        : {}),
      ...(optionalText(project.city, 180)
        ? { city: optionalText(project.city, 180) }
        : {}),
      ...(optionalText(project.county, 180)
        ? { county: optionalText(project.county, 180) }
        : {}),
      ...(optionalText(project.state, 30)
        ? { state: optionalText(project.state, 30) }
        : {}),
      ...(optionalText(project.postalCode, 30)
        ? { postalCode: optionalText(project.postalCode, 30) }
        : {}),
      ...(typeof project.value === "number" && Number.isFinite(project.value)
        ? { estimatedValue: project.value }
        : {}),
      ...(postedAt ? { postedAt } : {}),
      ...(bidDate ? { bidDate } : {}),
      sourceActivityAt: postedAt ?? UNKNOWN_SOURCE_ACTIVITY_AT,
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
