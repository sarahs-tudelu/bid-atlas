"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectParticipant, ProjectRecord, ProjectStage } from "./lib/types";
import type {
  BidDraftPipelineStage,
  BidDraftReadinessKey,
  PersistedBidDraft,
  PersistedQuoteLineItem,
  SavedBidDraftRecord,
} from "./lib/bid-draft-types";
import {
  assessProjectOutreach,
  buildProjectContactSheet,
  participantHasPublishedName,
  rankProjectContactRoutes,
} from "./lib/outreach-intelligence";
import type { ResearchContactFinding } from "./lib/project-research/types";
import { useProjectResearch } from "./lib/use-project-research";
import { ProjectResearchDossier } from "./ProjectResearchDossier";
import { ProjectDrawingsPanel } from "./ProjectDrawingsPanel";
import { formatBidDeadline } from "./lib/deadline-time";

export interface BidDeskProps {
  projects: ProjectRecord[];
  selectedProjectId?: string;
  asOf?: string;
  initialDrawingAction?: "view" | "download";
  onSelectProject(id: string): void;
}

type PipelineStage = BidDraftPipelineStage;
type ReadinessKey = BidDraftReadinessKey;
type QuoteLineItem = PersistedQuoteLineItem;
type BidDraft = PersistedBidDraft;

type DraftStorageStatus =
  | "checking"
  | "new"
  | "loaded"
  | "saving"
  | "saved"
  | "signin-required"
  | "unavailable"
  | "error";

interface RecipientRecord {
  id: string;
  participant: ProjectParticipant;
  origin: "source-record" | "on-demand-research";
  sourceRole?: string;
  suggestedChannel?: string;
  phone?: string;
  sourceUrl?: string;
  sourceEvidence?: string;
  observedAt?: string;
}

interface IntegrationCapabilities {
  apolloConfigured: boolean;
  outboundDeliveryConfigured: boolean;
}

const pipelineStages: Array<{ id: PipelineStage; label: string; hint: string }> = [
  { id: "research", label: "Research", hint: "Confirm opportunity" },
  { id: "qualify", label: "Qualify", hint: "Fit and contacts" },
  { id: "estimate", label: "Estimate", hint: "Price the scope" },
  { id: "package", label: "Package", hint: "Build proposal" },
  { id: "approval", label: "Approval", hint: "Internal review" },
  { id: "delivered", label: "Delivered", hint: "Manual tracking" },
];

const readinessItems: Array<{
  id: ReadinessKey;
  label: string;
  description: string;
}> = [
  {
    id: "documents",
    label: "Current plans and addenda reviewed",
    description: "The package uses the latest publicly available project documents.",
  },
  {
    id: "scope",
    label: "Scope and product fit confirmed",
    description: "The quoted system matches the project requirement and responsibility split.",
  },
  {
    id: "pricing",
    label: "Pricing independently checked",
    description: "Quantities, unit prices, freight, taxes, and allowances have been reviewed.",
  },
  {
    id: "terms",
    label: "Commercial terms confirmed",
    description: "Exclusions, lead time, and validity are explicit in the package.",
  },
  {
    id: "authority",
    label: "Internal approval authority confirmed",
    description: "The person approving this draft is authorized to release the quote.",
  },
];

const projectStageLabels: Record<ProjectStage, string> = {
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

function newLineId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `line-${Date.now()}`;
}

function initialPipelineStage(project: ProjectRecord): PipelineStage {
  if (project.stage === "bidding") return "estimate";
  if (project.stage === "design" || project.stage === "permitting") return "qualify";
  return "research";
}

function initialDraft(project: ProjectRecord): BidDraft {
  const quoteNumber = `DRAFT-${project.sourceRecordId.slice(-8).toUpperCase()}`;
  const packageName = "Product quote package";
  return {
    quoteNumber,
    packageName,
    scope: "",
    exclusions: "",
    leadTime: "",
    validity: "30 days",
    lineItems: [
      {
        id: `initial-${project.id}`,
        description: "Product / system package",
        quantity: 1,
        unit: "lot",
        unitPrice: 0,
      },
    ],
    messageSubject: `Quote package — ${project.title}`,
    messageBody: [
      "Hello,",
      "",
      `We are preparing a quote package for ${project.title}. The attached draft will identify the proposed scope, pricing, exclusions, lead time, and quote validity.`,
      "",
      "Please confirm that you are the correct recipient and advise if there are updated plans, addenda, bid instructions, or qualification requirements we should review.",
      "",
      "Thank you,",
    ].join("\n"),
    readiness: {
      documents: false,
      scope: false,
      pricing: false,
      terms: false,
      authority: false,
    },
  };
}

function projectLocation(project: ProjectRecord): string {
  return [project.address, project.city, project.county, project.state, project.postalCode]
    .filter(Boolean)
    .join(", ") || "Location not published";
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function lineTotal(lineItem: QuoteLineItem): number {
  return Math.max(0, lineItem.quantity || 0) * Math.max(0, lineItem.unitPrice || 0);
}

function draftTotal(draft: BidDraft): number {
  return draft.lineItems.reduce((total, lineItem) => total + lineTotal(lineItem), 0);
}

function validDeliveryChannel(channel: string): boolean {
  const normalized = channel.trim();
  if (!normalized || /[\s\u0000-\u001f\u007f\\]/.test(normalized)) return false;
  const at = normalized.indexOf("@");
  if (at > 0 && at === normalized.lastIndexOf("@")) {
    const local = normalized.slice(0, at);
    const domain = normalized.slice(at + 1);
    return (
      normalized.length <= 254 &&
      local.length <= 64 &&
      !local.startsWith(".") &&
      !local.endsWith(".") &&
      !local.includes("..") &&
      /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) &&
      validDeliveryHostname(domain)
    );
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    Boolean(url.hostname) &&
    !url.username &&
    !url.password &&
    validDeliveryHostname(url.hostname)
  );
}

function validDeliveryHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return /^[0-9a-f:.]+$/i.test(normalized.slice(1, -1));
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized.split(".").every((part) => Number(part) <= 255);
  }
  if (normalized.length > 253 || !normalized.includes(".")) return false;
  return normalized.split(".").every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

function draftStorageLabel(status: DraftStorageStatus): string {
  if (status === "checking") return "Checking private draft storage";
  if (status === "loaded") return "Private draft restored";
  if (status === "saving") return "Saving private draft";
  if (status === "saved") return "Private draft saved";
  if (status === "signin-required") return "Session draft · sign in to save";
  if (status === "unavailable") return "Session draft · storage unavailable";
  if (status === "error") return "Session draft · save needs retry";
  return "New private draft · not yet saved";
}

function roleLabel(role: ProjectParticipant["role"]): string {
  if (role === "agency") return "Agency";
  if (role === "architect") return "Architect / designer";
  if (role === "engineer") return "Engineer / consultant";
  if (role === "bidder") return "Bidder";
  if (role === "plan-holder") return "Plan holder / authorized proposal requester";
  if (role === "contractor") return "Contractor / GC";
  return "Owner";
}

function researchParticipantRole(role?: string): ProjectParticipant["role"] {
  const normalized = role?.toLowerCase() ?? "";
  if (/architect|designer/.test(normalized)) return "architect";
  if (/engineer|consultant/.test(normalized)) return "engineer";
  if (/bidder|estimator/.test(normalized)) return "bidder";
  if (/plan[ -]?holder|proposal requester/.test(normalized)) return "plan-holder";
  if (/contractor|general contractor|\bgc\b|builder/.test(normalized)) return "contractor";
  if (/owner|client|developer/.test(normalized)) return "owner";
  return "agency";
}

function stableRecipientToken(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function recipientsForProject(
  project: ProjectRecord,
  researchContacts: readonly ResearchContactFinding[],
): RecipientRecord[] {
  const recipients: RecipientRecord[] = project.participants
    .filter(participantHasPublishedName)
    .map((participant, index) => ({
      id: `${project.id}:recipient:${index}:${participant.role}:${participant.name}`,
      participant,
      origin: "source-record",
      suggestedChannel: participant.email,
      phone: participant.phone,
      sourceUrl: participant.sourceUrl ?? project.sourceUrl,
      sourceRole: participant.role,
      sourceEvidence:
        participant.email || participant.phone
          ? "Published named contact and channel in the official project source record."
          : "Participant name published in the official project source record.",
      observedAt: project.updatedAt,
    }));
  const byIdentity = new Map(
    recipients.map((recipient, index) => [
      `${recipient.participant.role}|${recipient.participant.name.trim().toLowerCase()}`,
      index,
    ]),
  );

  for (const contact of researchContacts) {
    const name =
      contact.displayName?.trim() ||
      contact.organization?.trim() ||
      "";
    if (!name) continue;
    const role = researchParticipantRole(contact.role);
    const identity = `${role}|${name.toLowerCase()}`;
    const exactFindingAlreadyPresent = recipients.some(
      (recipient) =>
        recipient.participant.role === role &&
        recipient.participant.name.trim().toLowerCase() === name.toLowerCase() &&
        (recipient.suggestedChannel ?? "").toLowerCase() ===
          (contact.email ?? "").toLowerCase() &&
        (recipient.phone ?? "") === (contact.phone ?? "") &&
        recipient.sourceUrl === contact.sourceUrl,
    );
    if (exactFindingAlreadyPresent) continue;
    const existingIndex = byIdentity.get(identity);
    const evidence = contact.evidence.trim();
    if (existingIndex !== undefined) {
      const existing = recipients[existingIndex];
      const sourceRecordNeedsEvidence =
        existing.origin === "source-record" &&
        !existing.suggestedChannel &&
        !existing.phone &&
        !existing.sourceUrl;
      const sameChannelBundle =
        (existing.suggestedChannel ?? "").toLowerCase() ===
          (contact.email ?? "").toLowerCase() &&
        (existing.phone ?? "") === (contact.phone ?? "");
      if (sourceRecordNeedsEvidence) {
        recipients[existingIndex] = {
          ...existing,
          suggestedChannel: contact.email,
          phone: contact.phone,
          sourceUrl: contact.sourceUrl,
          sourceRole: contact.role,
          sourceEvidence: evidence,
          observedAt: contact.observedAt,
        };
        continue;
      }
      if (sameChannelBundle && existing.sourceUrl === contact.sourceUrl) continue;
    }

    const token = stableRecipientToken(
      [role, name.toLowerCase(), contact.email, contact.phone, contact.sourceUrl]
        .filter(Boolean)
        .join("|"),
    );
    if (!byIdentity.has(identity)) byIdentity.set(identity, recipients.length);
    recipients.push({
      id: `${project.id}:research-recipient:${token}`,
      participant: { name, role },
      origin: "on-demand-research",
      sourceRole: contact.role,
      suggestedChannel: contact.email,
      phone: contact.phone,
      sourceUrl: contact.sourceUrl,
      sourceEvidence: evidence,
      observedAt: contact.observedAt,
    });
  }

  return recipients;
}

function recipientChannel(
  recipient: RecipientRecord,
  channels: Record<string, string>,
): string {
  return channels[recipient.id] ?? recipient.suggestedChannel ?? "";
}

function validEvidenceUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function recipientEvidenceUrl(
  recipient: RecipientRecord,
  evidenceUrls: Record<string, string>,
): string {
  return evidenceUrls[recipient.id] ??
    (recipient.suggestedChannel && recipient.sourceUrl ? recipient.sourceUrl : "");
}

function recipientVerificationFingerprint(
  recipient: RecipientRecord,
  channels: Record<string, string>,
  evidenceUrls: Record<string, string>,
): string {
  const channel = recipientChannel(recipient, channels).trim().toLowerCase();
  const evidenceUrl = recipientEvidenceUrl(recipient, evidenceUrls).trim();
  return channel && evidenceUrl ? `${channel}\u0000${evidenceUrl}` : "";
}

function csvContactCell(value: string): string {
  const spreadsheetSafe = /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
  return `"${spreadsheetSafe.replace(/"/g, '""')}"`;
}

function recipientsAsCsv(recipients: readonly RecipientRecord[]): string {
  const rows = [
    ["role", "name", "email", "phone", "provenance", "evidence_url", "evidence"],
    ...recipients.map((recipient) => [
      roleLabel(recipient.participant.role),
      recipient.participant.name,
      recipient.suggestedChannel ?? "missing from source",
      recipient.phone ?? "missing from source",
      recipient.origin === "on-demand-research"
        ? "on-demand official-source research"
        : "indexed public project record",
      recipient.sourceUrl ?? "missing from source",
      recipient.sourceEvidence ?? "Participant name only; channel not published in indexed record.",
    ]),
  ];
  return rows.map((row) => row.map(csvContactCell).join(",")).join("\n");
}

function refreshMessage(project: ProjectRecord, draft: BidDraft): string {
  const scope = draft.scope.trim() || "Scope to be confirmed";
  return [
    "Hello,",
    "",
    `Please review our ${draft.packageName || "quote package"} for ${project.title}.`,
    "",
    `Quote reference: ${draft.quoteNumber || "Draft"}`,
    `Proposed scope: ${scope}`,
    `Quote total: ${formatCurrency(draftTotal(draft))}`,
    `Lead time: ${draft.leadTime || "To be confirmed"}`,
    `Validity: ${draft.validity || "To be confirmed"}`,
    `Exclusions: ${draft.exclusions || "To be confirmed"}`,
    "",
    "Please confirm receipt and let us know if there are updated plans, addenda, bid forms, or qualification requirements that should be reflected before final submission.",
    "",
    "Thank you,",
  ].join("\n");
}

function draftAsText(
  project: ProjectRecord,
  draft: BidDraft,
  recipients: RecipientRecord[],
  selectedRecipients: Record<string, boolean>,
  channels: Record<string, string>,
  evidenceUrls: Record<string, string>,
  verified: Record<string, boolean>,
  verifiedFingerprints: Record<string, string>,
): string {
  const recipientLines = recipients
    .filter((recipient) => selectedRecipients[recipient.id])
    .map((recipient) => {
      const channel = recipientChannel(recipient, channels).trim() || "channel missing";
      const evidenceUrl = recipientEvidenceUrl(recipient, evidenceUrls);
      const fingerprint = recipientVerificationFingerprint(recipient, channels, evidenceUrls);
      const status =
        verified[recipient.id] &&
        validDeliveryChannel(channel) &&
        validEvidenceUrl(evidenceUrl) &&
        verifiedFingerprints[recipient.id] === fingerprint
          ? "team verified"
          : "unverified";
      return `- ${recipient.participant.name} — ${roleLabel(recipient.participant.role)} — ${channel} (${status}; evidence: ${evidenceUrl || "missing"})`;
    });

  const lineItemRows = draft.lineItems.map(
    (lineItem, index) =>
      `${index + 1}. ${lineItem.description || "Untitled item"} | ${lineItem.quantity || 0} ${lineItem.unit || "unit"} × ${formatCurrency(lineItem.unitPrice || 0)} = ${formatCurrency(lineTotal(lineItem))}`,
  );

  return [
    "BID DESK DRAFT — NOT SUBMITTED",
    "",
    `Project: ${project.title}`,
    `Agency / owner: ${project.agency}`,
    `Location: ${projectLocation(project)}`,
    `Source record: ${project.sourceRecordId}`,
    `Quote reference: ${draft.quoteNumber || "Draft"}`,
    `Package: ${draft.packageName || "Untitled package"}`,
    "",
    "RECIPIENTS",
    ...(recipientLines.length ? recipientLines : ["- No recipients selected"]),
    "",
    "LINE ITEMS",
    ...lineItemRows,
    `Total: ${formatCurrency(draftTotal(draft))}`,
    "",
    "SCOPE",
    draft.scope || "Not entered",
    "",
    "EXCLUSIONS",
    draft.exclusions || "Not entered",
    "",
    `Lead time: ${draft.leadTime || "Not entered"}`,
    `Validity: ${draft.validity || "Not entered"}`,
    "",
    "MESSAGE DRAFT",
    `Subject: ${draft.messageSubject}`,
    "",
    draft.messageBody,
    "",
    "This file is a working draft. Downloading it does not submit a bid or contact a recipient.",
  ].join("\n");
}

export function BidDesk({
  projects,
  selectedProjectId,
  asOf,
  initialDrawingAction,
  onSelectProject,
}: BidDeskProps) {
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0],
    [projects, selectedProjectId],
  );
  const projectResearch = useProjectResearch(selectedProject?.id);
  const [drafts, setDrafts] = useState<Record<string, BidDraft>>({});
  const [pipelineByProject, setPipelineByProject] = useState<Record<string, PipelineStage>>({});
  const [selectedRecipients, setSelectedRecipients] = useState<Record<string, boolean>>({});
  const [recipientChannels, setRecipientChannels] = useState<Record<string, string>>({});
  const [recipientEvidenceUrls, setRecipientEvidenceUrls] = useState<Record<string, string>>({});
  const [verifiedRecipients, setVerifiedRecipients] = useState<Record<string, boolean>>({});
  const [verifiedRecipientFingerprints, setVerifiedRecipientFingerprints] = useState<
    Record<string, string>
  >({});
  const [approvedProjects, setApprovedProjects] = useState<Record<string, string>>({});
  const [actionStatus, setActionStatus] = useState("");
  const [draftStorageByProject, setDraftStorageByProject] = useState<
    Record<string, DraftStorageStatus>
  >({});
  const hydratedDraftProjects = useRef(new Set<string>());
  const hydratingDraftProjects = useRef(new Map<string, AbortController>());
  const [draftHydrationAttempt, setDraftHydrationAttempt] = useState(0);
  const [integrationCapabilities, setIntegrationCapabilities] = useState<
    IntegrationCapabilities | "checking" | "unavailable"
  >("checking");

  useEffect(() => {
    let active = true;
    fetch("/api/integrations", { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Integration status ${response.status}`);
        return (await response.json()) as IntegrationCapabilities;
      })
      .then((capabilities) => {
        if (active) setIntegrationCapabilities(capabilities);
      })
      .catch(() => {
        if (active) setIntegrationCapabilities("unavailable");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const projectId = selectedProject?.id;
    if (
      !projectId ||
      hydratedDraftProjects.current.has(projectId) ||
      hydratingDraftProjects.current.has(projectId)
    ) {
      return;
    }
    const controller = new AbortController();
    hydratingDraftProjects.current.set(projectId, controller);
    const releaseHydration = () => {
      if (hydratingDraftProjects.current.get(projectId) === controller) {
        hydratingDraftProjects.current.delete(projectId);
      }
    };
    setDraftStorageByProject((current) => ({ ...current, [projectId]: "checking" }));

    fetch(`/api/bid-drafts?projectId=${encodeURIComponent(projectId)}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 404) return { status: "new" as const };
        if (response.status === 401) return { status: "signin-required" as const };
        if (response.status === 503) return { status: "unavailable" as const };
        if (!response.ok) throw new Error(`Draft storage ${response.status}`);
        return {
          status: "loaded" as const,
          record: (await response.json()) as SavedBidDraftRecord,
        };
      })
      .then((result) => {
        releaseHydration();
        if (controller.signal.aborted) return;
        if (result.status === "loaded" || result.status === "new") {
          hydratedDraftProjects.current.add(projectId);
        }
        setDraftStorageByProject((current) => ({
          ...current,
          [projectId]: result.status,
        }));
        if (!result.record) return;

        setDrafts((current) => ({
          ...current,
          [projectId]: current[projectId] ?? result.record.draft,
        }));
        setPipelineByProject((current) => ({
          [projectId]: result.record.pipelineStage,
          ...current,
        }));
        const savedSelection = Object.fromEntries(
          result.record.recipients.map((recipient) => [recipient.clientId, true]),
        );
        const savedChannels = Object.fromEntries(
          result.record.recipients.map((recipient) => [recipient.clientId, recipient.channel]),
        );
        const savedVerification = Object.fromEntries(
          result.record.recipients.map((recipient) => [recipient.clientId, recipient.verified]),
        );
        const savedEvidenceUrls = Object.fromEntries(
          result.record.recipients.flatMap((recipient) =>
            recipient.verificationSourceUrl
              ? [[recipient.clientId, recipient.verificationSourceUrl]]
              : [],
          ),
        );
        const savedFingerprints = Object.fromEntries(
          result.record.recipients.flatMap((recipient) =>
            recipient.verified && recipient.verificationSourceUrl
              ? [[
                  recipient.clientId,
                  `${recipient.channel.trim().toLowerCase()}\u0000${recipient.verificationSourceUrl}`,
                ]]
              : [],
          ),
        );
        setSelectedRecipients((current) => ({ ...savedSelection, ...current }));
        setRecipientChannels((current) => ({ ...savedChannels, ...current }));
        setRecipientEvidenceUrls((current) => ({ ...savedEvidenceUrls, ...current }));
        setVerifiedRecipients((current) => ({ ...savedVerification, ...current }));
        setVerifiedRecipientFingerprints((current) => ({ ...savedFingerprints, ...current }));
      })
      .catch((error) => {
        releaseHydration();
        if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        hydratedDraftProjects.current.delete(projectId);
        setDraftStorageByProject((current) => ({ ...current, [projectId]: "error" }));
      });

    return () => {
      controller.abort();
      releaseHydration();
    };
  }, [selectedProject?.id, draftHydrationAttempt]);

  if (!selectedProject) {
    return (
      <section id="bid-desk" className="bid-desk bid-desk--empty" aria-labelledby="bid-desk-title">
        <p className="bid-desk__eyebrow">BID WORKSPACE</p>
        <h2 id="bid-desk-title">Select a project to start a quote package.</h2>
        <p>Projects will appear here after they are loaded into the active public-source index.</p>
      </section>
    );
  }

  const draft = drafts[selectedProject.id] ?? initialDraft(selectedProject);
  const draftStorageStatus = draftStorageByProject[selectedProject.id] ?? "checking";
  const draftLoadCanRetry =
    draftStorageStatus === "error" ||
    draftStorageStatus === "signin-required" ||
    draftStorageStatus === "unavailable";
  const retryDraftLoad = () => {
    const projectId = selectedProject.id;
    hydratedDraftProjects.current.delete(projectId);
    hydratingDraftProjects.current.get(projectId)?.abort();
    hydratingDraftProjects.current.delete(projectId);
    setDraftHydrationAttempt((current) => current + 1);
  };
  const outreachAssessment = assessProjectOutreach(selectedProject, asOf ?? new Date());
  const contactSheet = buildProjectContactSheet(selectedProject);
  const contactRoutes = rankProjectContactRoutes(selectedProject);
  const researchContacts = projectResearch.research?.contacts ?? [];
  const researchDocuments = projectResearch.research?.documents ?? [];
  const storedPipelineStage =
    pipelineByProject[selectedProject.id] ?? initialPipelineStage(selectedProject);
  const recipients = recipientsForProject(selectedProject, researchContacts);
  const directRecipientCount = recipients.filter(
    (recipient) => recipient.suggestedChannel || recipient.phone,
  ).length;
  const agencyOnlyRecipients =
    recipients.length > 0 &&
    directRecipientCount === 0 &&
    recipients.every((recipient) => recipient.participant.role === "agency");
  const contactLedgerHeading = directRecipientCount > 0
    ? "Named contacts with published direct channels"
    : agencyOnlyRecipients
      ? "Agency-only participants; direct contacts missing"
      : recipients.length > 0
        ? "Named participants; direct contacts missing"
        : "Contact participants and channels missing";
  const contactSheetCsv = recipientsAsCsv(recipients);
  const total = draftTotal(draft);
  const selectedRecipientRecords = recipients.filter(
    (recipient) => selectedRecipients[recipient.id],
  );
  const verifiedSelectedRecipientRecords = selectedRecipientRecords.filter((recipient) => {
    const channel = recipientChannel(recipient, recipientChannels);
    const evidenceUrl = recipientEvidenceUrl(recipient, recipientEvidenceUrls);
    const fingerprint = recipientVerificationFingerprint(
      recipient,
      recipientChannels,
      recipientEvidenceUrls,
    );
    return Boolean(
      verifiedRecipients[recipient.id] &&
        validDeliveryChannel(channel) &&
        validEvidenceUrl(evidenceUrl) &&
        fingerprint &&
        verifiedRecipientFingerprints[recipient.id] === fingerprint,
    );
  });
  const checklistComplete = readinessItems.every((item) => draft.readiness[item.id]);
  const scopeReady = Boolean(draft.scope.trim());
  const termsReady = Boolean(
    draft.exclusions.trim() && draft.leadTime.trim() && draft.validity.trim(),
  );
  const pricingReady =
    total > 0 &&
    draft.lineItems.every(
      (lineItem) => lineItem.description.trim() && lineItem.quantity > 0 && lineItem.unitPrice >= 0,
    );
  const recipientReady = verifiedSelectedRecipientRecords.length > 0;
  const researchCompleted = Boolean(
    projectResearch.loadState === "ready" &&
      (projectResearch.research?.status === "complete" ||
        projectResearch.research?.status === "partial") &&
      projectResearch.research?.freshUntil,
  );
  const terminalResearchFinding = projectResearch.research?.lifecycle.find(
    (finding) => finding.terminal,
  );
  const activeLifecycleFinding = projectResearch.research?.lifecycle.find(
    (finding) => !finding.terminal,
  );
  const lifecycleResearchReady = Boolean(
    researchCompleted &&
      !terminalResearchFinding &&
      activeLifecycleFinding,
  );
  const officialStatusReady =
    lifecycleResearchReady &&
    selectedProject.stage !== "completed" &&
    selectedProject.stage !== "cancelled";
  const readyForApproval =
    officialStatusReady &&
    checklistComplete &&
    scopeReady &&
    termsReady &&
    pricingReady &&
    recipientReady;
  const approvalContextToken = researchCompleted
    ? [
        projectResearch.research?.completedAt,
        projectResearch.research?.freshUntil,
        activeLifecycleFinding?.id,
        ...verifiedSelectedRecipientRecords.map((recipient) =>
          recipientVerificationFingerprint(
            recipient,
            recipientChannels,
            recipientEvidenceUrls,
          ),
        ),
      ].join("|")
    : "";
  const projectApproved = Boolean(
    readyForApproval &&
      approvalContextToken &&
      approvedProjects[selectedProject.id] === approvalContextToken,
  );
  const pipelineStage =
    storedPipelineStage === "approval" && !projectApproved
      ? "research"
      : storedPipelineStage;

  const invalidateApproval = () => {
    setApprovedProjects((current) => ({ ...current, [selectedProject.id]: "" }));
  };

  const updateDraft = (updates: Partial<BidDraft>) => {
    setDrafts((current) => ({
      ...current,
      [selectedProject.id]: {
        ...(current[selectedProject.id] ?? initialDraft(selectedProject)),
        ...updates,
      },
    }));
    invalidateApproval();
    setActionStatus("");
  };

  const updateLineItem = (lineItemId: string, updates: Partial<QuoteLineItem>) => {
    updateDraft({
      lineItems: draft.lineItems.map((lineItem) =>
        lineItem.id === lineItemId ? { ...lineItem, ...updates } : lineItem,
      ),
    });
  };

  const updateReadiness = (readinessKey: ReadinessKey, value: boolean) => {
    updateDraft({
      readiness: { ...draft.readiness, [readinessKey]: value },
    });
  };

  const handleRecipientSelection = (recipientId: string, value: boolean) => {
    setSelectedRecipients((current) => ({ ...current, [recipientId]: value }));
    invalidateApproval();
  };

  const handleRecipientChannel = (recipientId: string, value: string) => {
    setRecipientChannels((current) => ({ ...current, [recipientId]: value }));
    setVerifiedRecipients((current) => ({ ...current, [recipientId]: false }));
    setVerifiedRecipientFingerprints((current) => {
      const next = { ...current };
      delete next[recipientId];
      return next;
    });
    invalidateApproval();
  };

  const handleRecipientEvidenceUrl = (recipientId: string, value: string) => {
    setRecipientEvidenceUrls((current) => ({ ...current, [recipientId]: value }));
    setVerifiedRecipients((current) => ({ ...current, [recipientId]: false }));
    setVerifiedRecipientFingerprints((current) => {
      const next = { ...current };
      delete next[recipientId];
      return next;
    });
    invalidateApproval();
  };

  const handleRecipientVerification = (recipient: RecipientRecord, value: boolean) => {
    const channel = recipientChannel(recipient, recipientChannels);
    const evidenceUrl = recipientEvidenceUrl(recipient, recipientEvidenceUrls);
    const fingerprint = recipientVerificationFingerprint(
      recipient,
      recipientChannels,
      recipientEvidenceUrls,
    );
    const verified = Boolean(
      value &&
        validDeliveryChannel(channel) &&
        validEvidenceUrl(evidenceUrl) &&
        fingerprint,
    );
    setVerifiedRecipients((current) => ({ ...current, [recipient.id]: verified }));
    setVerifiedRecipientFingerprints((current) => {
      const next = { ...current };
      if (verified) next[recipient.id] = fingerprint;
      else delete next[recipient.id];
      return next;
    });
    invalidateApproval();
  };

  const textDraft = () =>
    draftAsText(
      selectedProject,
      draft,
      recipients,
      selectedRecipients,
      recipientChannels,
      recipientEvidenceUrls,
      verifiedRecipients,
      verifiedRecipientFingerprints,
    );

  const copyDraft = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(textDraft());
      setActionStatus("Draft copied. Nothing was sent.");
    } catch {
      setActionStatus("Clipboard access was unavailable. Download the draft instead.");
    }
  };

  const copyContactSheet = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(contactSheetCsv);
      setActionStatus("Source-backed contact ledger copied. Nothing was sent.");
    } catch {
      setActionStatus("Clipboard access was unavailable. Download the contact sheet instead.");
    }
  };

  const downloadContactSheet = () => {
    const file = new Blob([contactSheetCsv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selectedProject.sourceRecordId.replace(/[^a-z0-9-]+/gi, "-") || "project"}-contacts.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setActionStatus("Source-backed contact ledger downloaded. Nothing was sent.");
  };

  const downloadDraft = () => {
    const file = new Blob([textDraft()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    const safeProjectName = selectedProject.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 48);
    anchor.href = url;
    anchor.download = `${safeProjectName || "project"}-bid-draft.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    setActionStatus("Draft downloaded. Nothing was submitted.");
  };

  const saveDraft = async () => {
    setDraftStorageByProject((current) => ({
      ...current,
      [selectedProject.id]: "saving",
    }));
    setActionStatus("Saving the private draft…");
    const owner = selectedProject.participants.find((participant) => participant.role === "owner");
    const architect = selectedProject.participants.find(
      (participant) => participant.role === "architect",
    );
    const engineer = selectedProject.participants.find(
      (participant) => participant.role === "engineer",
    );
    const savedRecipients = recipients
      .filter((recipient) => selectedRecipients[recipient.id])
      .map((recipient) => {
        const channel = recipientChannel(recipient, recipientChannels).trim();
        const verificationSourceUrl = recipientEvidenceUrl(
          recipient,
          recipientEvidenceUrls,
        ).trim();
        const fingerprint = recipientVerificationFingerprint(
          recipient,
          recipientChannels,
          recipientEvidenceUrls,
        );
        const verified = Boolean(
          verifiedRecipients[recipient.id] &&
            validDeliveryChannel(channel) &&
            validEvidenceUrl(verificationSourceUrl) &&
            verifiedRecipientFingerprints[recipient.id] === fingerprint,
        );
        return {
          clientId: recipient.id,
          participantName: recipient.participant.name,
          role: recipient.participant.role,
          channel,
          ...(verificationSourceUrl ? { verificationSourceUrl } : {}),
          verified,
        };
      });

    try {
      const response = await fetch("/api/bid-drafts", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          project: {
            id: selectedProject.id,
            canonicalKey: selectedProject.id,
            title: selectedProject.title,
            summary: selectedProject.summary,
            stage: selectedProject.stage,
            status: selectedProject.status,
            agency: selectedProject.agency,
            ownerName: owner?.name,
            architectName: architect?.name,
            engineerName: engineer?.name,
            address: selectedProject.address,
            city: selectedProject.city,
            county: selectedProject.county,
            state: selectedProject.state,
            postalCode: selectedProject.postalCode,
            estimatedValue: selectedProject.value,
            postedAt: selectedProject.postedAt,
            bidDate: selectedProject.bidDate,
            sourceId: selectedProject.sourceId,
            sourceUrl: selectedProject.sourceUrl,
          },
          draft,
          pipelineStage,
          recipients: savedRecipients,
        }),
      });
      const responseBody = (await response.json().catch(() => null)) as
        | SavedBidDraftRecord
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        const message =
          responseBody && "error" in responseBody
            ? responseBody.error?.message
            : undefined;
        if (response.status === 401) {
          setDraftStorageByProject((current) => ({
            ...current,
            [selectedProject.id]: "signin-required",
          }));
          setActionStatus("Sign in through the private workspace to save this draft.");
          return;
        }
        if (response.status === 503) {
          setDraftStorageByProject((current) => ({
            ...current,
            [selectedProject.id]: "unavailable",
          }));
          setActionStatus("Private storage is not active here. The session draft is still available.");
          return;
        }
        throw new Error(message || `Draft storage ${response.status}`);
      }
      setDraftStorageByProject((current) => ({
        ...current,
        [selectedProject.id]: "saved",
      }));
      setActionStatus("Private draft saved. Nothing was sent or submitted.");
    } catch {
      setDraftStorageByProject((current) => ({
        ...current,
        [selectedProject.id]: "error",
      }));
      setActionStatus("The draft could not be saved. It remains available in this session.");
    }
  };

  const approveDraft = () => {
    if (!readyForApproval || !approvalContextToken) return;
    setApprovedProjects((current) => ({
      ...current,
      [selectedProject.id]: approvalContextToken,
    }));
    setPipelineByProject((current) => ({
      ...current,
      [selectedProject.id]: "approval",
    }));
    setActionStatus("Approved for manual delivery in this session. Nothing was sent.");
  };

  return (
    <section id="bid-desk" className="bid-desk" aria-labelledby="bid-desk-title">
      <header className="bid-desk__header">
        <div className="bid-desk__header-copy">
          <p className="bid-desk__eyebrow">BID DESK</p>
          <h2 id="bid-desk-title">Prepare this bid</h2>
          <p>
            Review the deadline and plans, build the quote, then verify the delivery route.
          </p>
        </div>
        <div className="bid-desk__session-state" role="status">
          <span aria-hidden="true" />
          {draftStorageLabel(draftStorageStatus)} · no external actions
          {draftLoadCanRetry ? (
            <button className="bid-desk__text-button" type="button" onClick={retryDraftLoad}>
              Retry draft load
            </button>
          ) : null}
        </div>
      </header>

      <details className="bid-desk__workflow-disclosure">
        <summary>
          Workflow · {pipelineStages.find((stage) => stage.id === pipelineStage)?.label ?? "Project selected"}
        </summary>
        <nav className="bid-desk__pipeline" aria-label="Bid workspace pipeline">
        {pipelineStages.map((stage, index) => {
          const activeIndex = pipelineStages.findIndex((item) => item.id === pipelineStage);
          const isActive = stage.id === pipelineStage;
          const isComplete = index < activeIndex;
          return (
            <button
              className={`bid-desk__pipeline-step${isActive ? " bid-desk__pipeline-step--active" : ""}${isComplete ? " bid-desk__pipeline-step--complete" : ""}`}
              type="button"
              key={stage.id}
              aria-current={isActive ? "step" : undefined}
              onClick={() => {
                setPipelineByProject((current) => ({
                  ...current,
                  [selectedProject.id]: stage.id,
                }));
                setActionStatus(
                  stage.id === "delivered"
                    ? "Marked delivered for session tracking only. No package was sent."
                    : "",
                );
              }}
            >
              <span className="bid-desk__pipeline-index">{index + 1}</span>
              <span>
                <strong>{stage.label}</strong>
                <small>{stage.hint}</small>
              </span>
            </button>
          );
        })}
        </nav>
      </details>

      <div className="bid-desk__layout">
        <aside className="bid-desk__context" aria-label="Project and contact context">
          <section className="bid-desk__panel bid-desk__project-panel">
            <div className="bid-desk__panel-heading">
              <div>
                <p className="bid-desk__eyebrow">PROJECT RECORD</p>
                <h3>Project context</h3>
              </div>
              <span className={`bid-desk__stage-badge bid-desk__stage-badge--${selectedProject.stage}`}>
                {projectStageLabels[selectedProject.stage]}
              </span>
            </div>
            <label className="bid-desk__field">
              <span>Project</span>
              <select
                value={selectedProject.id}
                onChange={(event) => {
                  onSelectProject(event.target.value);
                  setActionStatus("");
                }}
              >
                {projects.map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="bid-desk__project-summary">
              <strong>{selectedProject.title}</strong>
              <p>{selectedProject.summary}</p>
              <dl>
                <div className="bid-desk__due-fact">
                  <dt>Bid due</dt>
                  <dd>{formatBidDeadline(selectedProject.bidDate, selectedProject.bidDateTimeZone)}</dd>
                </div>
                <div>
                  <dt>Agency / owner</dt>
                  <dd>{selectedProject.agency}</dd>
                </div>
                <div>
                  <dt>Location</dt>
                  <dd>{projectLocation(selectedProject)}</dd>
                </div>
                <div>
                  <dt>Solicitation</dt>
                  <dd>{selectedProject.sourceRecordId}</dd>
                </div>
                <div>
                  <dt>Official status</dt>
                  <dd>{selectedProject.status}</dd>
                </div>
                <div>
                  <dt>Official bid</dt>
                  <dd>
                    <a href={selectedProject.sourceUrl} target="_blank" rel="noreferrer">
                      Open official bid
                    </a>
                  </dd>
                </div>
              </dl>
            </div>
          </section>

          <details className="bid-desk__disclosure">
            <summary>Outreach timing · {outreachAssessment.recommendation.window}</summary>
            <section className="bid-desk__panel bid-desk__outreach-timing">
            <div className="bid-desk__panel-heading">
              <div>
                <p className="bid-desk__eyebrow">RIGHT-TIME SIGNAL</p>
                <h3>Freshness and outreach timing</h3>
              </div>
              <span
                className={`bid-desk__freshness-badge bid-desk__freshness-badge--${outreachAssessment.freshness.freshness}`}
              >
                {outreachAssessment.freshness.label}
              </span>
            </div>
            <div className="bid-desk__timing-callout">
              <strong>{outreachAssessment.recommendation.window}</strong>
              <p>{outreachAssessment.recommendation.explanation}</p>
            </div>
            <ul className="bid-desk__signal-list">
              {outreachAssessment.freshness.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
              <li>
                Building status: {outreachAssessment.freshness.buildStatus.label}.{" "}
                {outreachAssessment.freshness.buildStatus.explanation}
              </li>
            </ul>
            {outreachAssessment.recommendation.audience.length > 0 && (
              <p className="bid-desk__audience-note">
                Suggested roles: {outreachAssessment.recommendation.audience.map(roleLabel).join(", ")}.
              </p>
            )}
            <small className="bid-desk__safety-note">
              Explainable recommendation only. Verify the official source and a lawful business
              channel; nothing is sent from this workspace.
            </small>
            </section>
          </details>

          <section className="bid-desk__panel bid-desk__documents-panel">
            <div className="bid-desk__panel-heading">
              <div>
                <p className="bid-desk__eyebrow">PROJECT DOCUMENTS</p>
                <h3>Published files and source links</h3>
              </div>
              <span className="bid-desk__count-badge">{selectedProject.documents.length} links</span>
            </div>
            <ProjectDrawingsPanel
              key={selectedProject.id}
              project={selectedProject}
              researchDocuments={researchDocuments}
              researchLoadState={projectResearch.loadState}
              researchError={projectResearch.error}
              initialAction={initialDrawingAction}
              onResearch={projectResearch.refresh}
            />
            {selectedProject.documents.some(
              (document) => document.kind !== "plans" && document.kind !== "specifications",
            ) ? (
              <details className="bid-desk__disclosure bid-desk__supplemental-documents">
                <summary>
                  Other bid documents ({selectedProject.documents.filter(
                    (document) => document.kind !== "plans" && document.kind !== "specifications",
                  ).length})
                </summary>
                <ul className="bid-desk__document-list">
                  {selectedProject.documents
                    .filter(
                      (document) => document.kind !== "plans" && document.kind !== "specifications",
                    )
                    .map((document) => (
                      <li key={`${document.kind}:${document.url}`}>
                        <a href={document.url} target="_blank" rel="noreferrer">
                          <strong>{document.name}</strong>
                          <small>
                            {document.kind} · {document.access === "public" ? "public" : "free account"} ·{" "}
                            {document.indexStatus ?? "metadata only"}
                          </small>
                        </a>
                      </li>
                    ))}
                </ul>
              </details>
            ) : null}
            <a
              className="bid-desk__secondary-button bid-desk__document-library-link"
              href={`/documents?project=${encodeURIComponent(selectedProject.id)}&source=${encodeURIComponent(selectedProject.sourceId)}`}
            >
              Search or add project documents
            </a>
          </section>

          <details className="bid-desk__disclosure bid-desk__contact-research">
            <summary>Contact research · {recipients.length} sourced</summary>
            <section className="bid-desk__panel bid-desk__stakeholders">
            <div className="bid-desk__panel-heading">
              <div>
                <p className="bid-desk__eyebrow">CONTACT LEDGER</p>
                <h3>{contactLedgerHeading}</h3>
              </div>
              <span className="bid-desk__count-badge">
                {recipients.length} sourced entries
              </span>
            </div>
            <div className="bid-desk__contact-routing" aria-label="Recommended contact order">
              <strong>Verify these contacts in order</strong>
              <ol>
                {contactRoutes.slice(0, 5).map((route) => (
                  <li key={`${route.rank}:${route.role}:${route.name ?? "missing"}`}>
                    <span>
                      {route.roleLabel}: {route.name ?? "name missing from source"}
                    </span>
                    <small>
                      {route.reason} Authority unverified · {route.channelStatus === "published" ? "channel published in official source" : "channel missing"} · verify before outreach.
                    </small>
                  </li>
                ))}
              </ol>
            </div>
            <div className="bid-desk__stakeholder-graph">
              {contactSheet.groups.map((group) => (
                <article
                  className={`bid-desk__stakeholder-node${group.missingRole ? " bid-desk__stakeholder-node--missing" : ""}`}
                  key={group.role}
                >
                  <div className="bid-desk__stakeholder-node-head">
                    <span className="bid-desk__stakeholder-marker" aria-hidden="true" />
                    <div>
                      <strong>{group.label}</strong>
                      <small>{group.purpose}</small>
                    </div>
                  </div>
                  {group.contacts.length ? (
                    <ul>
                      {group.contacts.map((participant) => (
                        <li key={participant.id}>
                          <span>{participant.name}</span>
                          <small>
                            {roleLabel(participant.role)} · {participant.channels.length
                              ? `${participant.channels.map((channel) => channel.kind).join(" + ")} published in source`
                              : "channel not in source"}
                          </small>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No participant with this role appears in the current public record</p>
                  )}
                </article>
              ))}
            </div>
            <p className="bid-desk__contact-sheet-notice">
              {contactSheet.notice} On-demand findings are added to the exported ledger with their
              exact evidence URL; conflicting channels remain separate rows.
            </p>
            <div className="bid-desk__contact-sheet-actions">
              <button className="bid-desk__secondary-button" type="button" onClick={copyContactSheet}>
                Copy contact ledger
              </button>
              <button className="bid-desk__secondary-button" type="button" onClick={downloadContactSheet}>
                Download CSV
              </button>
            </div>
          </section>

          <ProjectResearchDossier
            research={projectResearch.research}
            loadState={projectResearch.loadState}
            error={projectResearch.error}
            apolloStatus={
              integrationCapabilities === "checking"
                ? "checking adapter"
                : integrationCapabilities === "unavailable"
                  ? "status unavailable"
                  : integrationCapabilities.apolloConfigured
                    ? "configured"
                    : "not configured"
            }
            onRefresh={projectResearch.refresh}
          />
          </details>
        </aside>

        <div className="bid-desk__builder">
          <section className="bid-desk__panel bid-desk__package-builder">
            <div className="bid-desk__panel-heading">
              <div>
                <p className="bid-desk__eyebrow">QUOTE PACKAGE</p>
                <h3>Commercial draft</h3>
              </div>
              <span className="bid-desk__draft-state">Working draft</span>
            </div>

            <div className="bid-desk__field-grid">
              <label className="bid-desk__field">
                <span>Quote reference</span>
                <input
                  value={draft.quoteNumber}
                  onChange={(event) => updateDraft({ quoteNumber: event.target.value })}
                />
              </label>
              <label className="bid-desk__field">
                <span>Package name</span>
                <input
                  value={draft.packageName}
                  onChange={(event) => updateDraft({ packageName: event.target.value })}
                />
              </label>
            </div>

            <div className="bid-desk__line-items">
              <div className="bid-desk__subheading">
                <div>
                  <h4>Line items</h4>
                  <p>Enter quantities and pricing from the reviewed project scope.</p>
                </div>
                <button
                  className="bid-desk__text-button"
                  type="button"
                  onClick={() =>
                    updateDraft({
                      lineItems: [
                        ...draft.lineItems,
                        {
                          id: newLineId(),
                          description: "",
                          quantity: 1,
                          unit: "each",
                          unitPrice: 0,
                        },
                      ],
                    })
                  }
                >
                  + Add line item
                </button>
              </div>
              <div className="bid-desk__line-item-table-wrap">
                <table className="bid-desk__line-item-table">
                  <thead>
                    <tr>
                      <th scope="col">Description</th>
                      <th scope="col">Quantity</th>
                      <th scope="col">Unit</th>
                      <th scope="col">Unit price</th>
                      <th scope="col">Total</th>
                      <th scope="col"><span className="bid-desk__visually-hidden">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.lineItems.map((lineItem) => (
                      <tr key={lineItem.id}>
                        <td>
                          <input
                            aria-label="Line-item description"
                            value={lineItem.description}
                            placeholder="Product, fabrication, freight…"
                            onChange={(event) =>
                              updateLineItem(lineItem.id, { description: event.target.value })
                            }
                          />
                        </td>
                        <td>
                          <input
                            aria-label="Quantity"
                            type="number"
                            min="0"
                            step="0.01"
                            value={lineItem.quantity || ""}
                            onChange={(event) =>
                              updateLineItem(lineItem.id, {
                                quantity: Number(event.target.value),
                              })
                            }
                          />
                        </td>
                        <td>
                          <input
                            aria-label="Unit"
                            value={lineItem.unit}
                            placeholder="each"
                            onChange={(event) =>
                              updateLineItem(lineItem.id, { unit: event.target.value })
                            }
                          />
                        </td>
                        <td>
                          <input
                            aria-label="Unit price"
                            type="number"
                            min="0"
                            step="0.01"
                            value={lineItem.unitPrice || ""}
                            onChange={(event) =>
                              updateLineItem(lineItem.id, {
                                unitPrice: Number(event.target.value),
                              })
                            }
                          />
                        </td>
                        <td className="bid-desk__line-total">{formatCurrency(lineTotal(lineItem))}</td>
                        <td>
                          <button
                            className="bid-desk__remove-button"
                            type="button"
                            aria-label={`Remove ${lineItem.description || "line item"}`}
                            onClick={() =>
                              updateDraft({
                                lineItems: draft.lineItems.filter(
                                  (candidate) => candidate.id !== lineItem.id,
                                ),
                              })
                            }
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th colSpan={4} scope="row">Draft total</th>
                      <td>{formatCurrency(total)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            <div className="bid-desk__terms-grid">
              <label className="bid-desk__field bid-desk__field--wide">
                <span>Proposed scope</span>
                <textarea
                  rows={5}
                  value={draft.scope}
                  placeholder="Describe the exact products, services, quantities, responsibilities, and alternates included."
                  onChange={(event) => updateDraft({ scope: event.target.value })}
                />
              </label>
              <label className="bid-desk__field bid-desk__field--wide">
                <span>Exclusions and assumptions</span>
                <textarea
                  rows={5}
                  value={draft.exclusions}
                  placeholder="List installation, engineering, permits, taxes, freight, field verification, finishes, or other exclusions. Enter “None” only after review."
                  onChange={(event) => updateDraft({ exclusions: event.target.value })}
                />
              </label>
              <label className="bid-desk__field">
                <span>Lead time</span>
                <input
                  value={draft.leadTime}
                  placeholder="Example: 10–12 weeks after approvals"
                  onChange={(event) => updateDraft({ leadTime: event.target.value })}
                />
              </label>
              <label className="bid-desk__field">
                <span>Quote validity</span>
                <input
                  value={draft.validity}
                  placeholder="Example: 30 days"
                  onChange={(event) => updateDraft({ validity: event.target.value })}
                />
              </label>
            </div>
          </section>

          <section className="bid-desk__panel bid-desk__recipients">
            <div className="bid-desk__panel-heading">
              <div>
                <p className="bid-desk__eyebrow">DELIVERY ROUTING</p>
                <h3>Recipients and verified channels</h3>
              </div>
              <span className="bid-desk__count-badge">
                {verifiedSelectedRecipientRecords.length} verified
              </span>
            </div>
            <p className="bid-desk__panel-intro">
              Participants can come from the indexed record or the on-demand official-source dossier.
              Published emails are suggested, but a person must still verify the exact recipient and
              lawful submission route before approval.
            </p>
            {recipients.length ? (
              <div className="bid-desk__recipient-list">
                {recipients.map((recipient) => {
                  const channel = recipientChannel(recipient, recipientChannels);
                  const channelValid = validDeliveryChannel(channel);
                  const evidenceUrl = recipientEvidenceUrl(recipient, recipientEvidenceUrls);
                  const evidenceUrlValid = validEvidenceUrl(evidenceUrl);
                  const fingerprint = recipientVerificationFingerprint(
                    recipient,
                    recipientChannels,
                    recipientEvidenceUrls,
                  );
                  const selected = selectedRecipients[recipient.id] ?? false;
                  const verified = Boolean(
                    verifiedRecipients[recipient.id] &&
                      fingerprint &&
                      verifiedRecipientFingerprints[recipient.id] === fingerprint,
                  );
                  return (
                    <article
                      className={`bid-desk__recipient${selected ? " bid-desk__recipient--selected" : ""}`}
                      key={recipient.id}
                    >
                      <label className="bid-desk__recipient-select">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={(event) =>
                            handleRecipientSelection(recipient.id, event.target.checked)
                          }
                        />
                        <span>
                          <strong>{recipient.participant.name}</strong>
                          <small>
                            {roleLabel(recipient.participant.role)} ·{" "}
                            {recipient.origin === "on-demand-research"
                              ? "official-source research"
                              : "indexed source record"}
                          </small>
                        </span>
                      </label>
                      <label className="bid-desk__field bid-desk__recipient-channel">
                        <span>Email or official portal URL</span>
                        <input
                          value={channel}
                          placeholder="name@company.com or https://portal…"
                          onChange={(event) =>
                            handleRecipientChannel(recipient.id, event.target.value)
                          }
                        />
                        <small className={channel && !channelValid ? "bid-desk__field-error" : ""}>
                          {channel && !channelValid
                            ? "Enter a valid email address or full https:// URL."
                            : recipient.suggestedChannel
                              ? "Suggested from exact official evidence; human verification is still required."
                              : "Enter only a channel verified against an official or first-party source."}
                        </small>
                      </label>
                      <label className="bid-desk__verification">
                        <input
                          type="checkbox"
                          checked={verified}
                          disabled={!channelValid || !evidenceUrlValid}
                          onChange={(event) =>
                            handleRecipientVerification(recipient, event.target.checked)
                          }
                        />
                        <span>
                          <strong>Team verified</strong>
                          <small>
                            Bound to this exact channel and evidence URL. Any change clears it.
                          </small>
                        </span>
                      </label>
                      <div className="bid-desk__recipient-evidence">
                        <label className="bid-desk__field bid-desk__recipient-evidence-field">
                          <span>Channel verification source URL</span>
                          <input
                            value={evidenceUrl}
                            placeholder="https://official-source.example/contact"
                            onChange={(event) =>
                              handleRecipientEvidenceUrl(recipient.id, event.target.value)
                            }
                          />
                          <small className={evidenceUrl && !evidenceUrlValid ? "bid-desk__field-error" : ""}>
                            {evidenceUrl && !evidenceUrlValid
                              ? "Enter the full https URL where your team verified this exact route."
                              : "Required before the channel can be marked team verified."}
                          </small>
                        </label>
                        {recipient.phone && <span>Published phone: {recipient.phone}</span>}
                        {recipient.sourceEvidence && <span>{recipient.sourceEvidence}</span>}
                        {recipient.sourceUrl && (
                          <a href={recipient.sourceUrl} target="_blank" rel="noreferrer">
                            View discovered contact evidence
                          </a>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="bid-desk__empty-note">
                <strong>No named project participants are available.</strong>
                <p>The on-demand dossier found no source-backed contact to route a package to.</p>
              </div>
            )}
          </section>

          <section className="bid-desk__panel bid-desk__message-preview">
            <div className="bid-desk__panel-heading">
              <div>
                <p className="bid-desk__eyebrow">MESSAGE PREVIEW</p>
                <h3>Cover note</h3>
              </div>
              <button
                className="bid-desk__text-button"
                type="button"
                onClick={() =>
                  updateDraft({
                    messageBody: refreshMessage(selectedProject, draft),
                  })
                }
              >
                Refresh from quote
              </button>
            </div>
            <label className="bid-desk__field">
              <span>Subject</span>
              <input
                value={draft.messageSubject}
                onChange={(event) => updateDraft({ messageSubject: event.target.value })}
              />
            </label>
            <label className="bid-desk__field">
              <span>Message</span>
              <textarea
                rows={12}
                value={draft.messageBody}
                onChange={(event) => updateDraft({ messageBody: event.target.value })}
              />
            </label>
            <div className="bid-desk__draft-actions">
              <button
                className="bid-desk__secondary-button"
                type="button"
                disabled={draftStorageStatus === "saving" || draftStorageStatus === "checking"}
                onClick={saveDraft}
              >
                {draftStorageStatus === "saving" ? "Saving…" : "Save private draft"}
              </button>
              <button className="bid-desk__secondary-button" type="button" onClick={copyDraft}>
                Copy complete draft
              </button>
              <button className="bid-desk__secondary-button" type="button" onClick={downloadDraft}>
                Download .txt draft
              </button>
              {actionStatus && <span role="status">{actionStatus}</span>}
            </div>
          </section>
        </div>

        <aside className="bid-desk__review" aria-label="Readiness and approval">
          <section className="bid-desk__panel bid-desk__readiness">
            <div className="bid-desk__panel-heading">
              <div>
                <p className="bid-desk__eyebrow">READINESS</p>
                <h3>Release checklist</h3>
              </div>
              <span className="bid-desk__readiness-score">
                {readinessItems.filter((item) => draft.readiness[item.id]).length}/
                {readinessItems.length}
              </span>
            </div>
            <div className="bid-desk__readiness-list">
              {readinessItems.map((item) => (
                <label className="bid-desk__readiness-item" key={item.id}>
                  <input
                    type="checkbox"
                    checked={draft.readiness[item.id]}
                    onChange={(event) => updateReadiness(item.id, event.target.checked)}
                  />
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="bid-desk__panel bid-desk__gate">
            <div className="bid-desk__panel-heading">
              <div>
                <p className="bid-desk__eyebrow">APPROVAL GATE</p>
                <h3>{projectApproved ? "Approved for manual delivery" : "Not ready to release"}</h3>
              </div>
              <span
                className={`bid-desk__gate-indicator${readyForApproval ? " bid-desk__gate-indicator--ready" : ""}`}
                aria-hidden="true"
              />
            </div>

            <dl className="bid-desk__gate-summary">
              <div className={officialStatusReady ? "bid-desk__gate-pass" : "bid-desk__gate-blocked"}>
                <dt>Official status</dt>
                <dd>
                  {officialStatusReady
                    ? `Exact non-terminal status: ${activeLifecycleFinding?.officialStatus}`
                    : terminalResearchFinding
                      ? `Blocked by official terminal status: ${terminalResearchFinding.officialStatus}`
                      : "Revalidate the official project status before approval; exact non-terminal evidence is missing"}
                </dd>
              </div>
              <div className={researchCompleted ? "bid-desk__gate-pass" : "bid-desk__gate-blocked"}>
                <dt>Research dossier</dt>
                <dd>
                  {researchCompleted
                    ? `${projectResearch.research?.status} · ${projectResearch.research?.sources.length ?? 0} source attempt${projectResearch.research?.sources.length === 1 ? "" : "s"}`
                    : projectResearch.loadState === "researching" || projectResearch.loadState === "checking"
                      ? "Official-source check in progress"
                      : "Open gaps or research not completed"}
                </dd>
              </div>
              <div className={scopeReady ? "bid-desk__gate-pass" : "bid-desk__gate-blocked"}>
                <dt>Scope</dt>
                <dd>{scopeReady ? "Entered" : "Missing"}</dd>
              </div>
              <div className={pricingReady ? "bid-desk__gate-pass" : "bid-desk__gate-blocked"}>
                <dt>Priced items</dt>
                <dd>{pricingReady ? formatCurrency(total) : "Incomplete"}</dd>
              </div>
              <div className={termsReady ? "bid-desk__gate-pass" : "bid-desk__gate-blocked"}>
                <dt>Terms</dt>
                <dd>{termsReady ? "Entered" : "Incomplete"}</dd>
              </div>
              <div className={recipientReady ? "bid-desk__gate-pass" : "bid-desk__gate-blocked"}>
                <dt>Verified route</dt>
                <dd>
                  {recipientReady
                    ? `${verifiedSelectedRecipientRecords.length} recipient${verifiedSelectedRecipientRecords.length === 1 ? "" : "s"}`
                    : "No verified recipient/channel"}
                </dd>
              </div>
              <div className={checklistComplete ? "bid-desk__gate-pass" : "bid-desk__gate-blocked"}>
                <dt>Release checks</dt>
                <dd>{checklistComplete ? "Complete" : "Incomplete"}</dd>
              </div>
            </dl>

            <button
              className="bid-desk__approval-button"
              type="button"
              disabled={!readyForApproval}
              onClick={approveDraft}
            >
              {projectApproved ? "Draft approved in this session" : "Approve draft for manual delivery"}
            </button>
            <button
              className="bid-desk__submission-button"
              type="button"
              disabled
              aria-describedby="bid-desk-submission-note"
            >
              Submit package · connector not configured
            </button>
            <p id="bid-desk-submission-note" className="bid-desk__gate-note">
              Approval records an in-session review state only. External email and procurement-portal
              submissions remain disabled until an authorized delivery connector and confirmation flow
              are configured.
            </p>
          </section>
        </aside>
      </div>
    </section>
  );
}
