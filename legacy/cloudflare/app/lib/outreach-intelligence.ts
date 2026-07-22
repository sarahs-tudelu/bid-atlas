import type {
  FreshnessFilter,
  ProjectFreshness,
  ProjectParticipant,
  ProjectRecord,
} from "./types";

export const NEW_ACTIVITY_DAYS = 14;
export const STALE_ACTIVITY_DAYS = 180;
export const PASSED_BID_GRACE_DAYS = 7;

export const INACTIVE_STATUS_TOKENS = [
  "cancelled",
  "canceled",
  "withdrawn",
  "void",
  "abandoned",
  "inactive",
  "not active",
  "paused",
  "on hold",
  "rejected",
  "denied",
  "expired",
  "revoked",
  "suspended",
] as const;

export const CLOSED_STATUS_TOKENS = [
  "bid opened",
  "bids opened",
  "awarded",
  "contracted",
  "completed",
  "complete",
  "closed",
  "finaled",
  "final permit",
] as const;

export const ACTIVE_STATUS_TOKENS = [
  "active",
  "open",
  "pending",
  "in progress",
  "under review",
  "submitted",
  "issued",
] as const;

const ACTIVE_STAGES = new Set<ProjectRecord["stage"]>([
  "planning",
  "design",
  "permitting",
  "bidding",
  "bid-opened",
  "awarded",
  "construction",
]);

const CONTACT_ROLES: Array<{
  role: ProjectParticipant["role"];
  label: string;
  purpose: string;
}> = [
  { role: "owner", label: "Owner", purpose: "Project decisions and purchasing authority" },
  { role: "agency", label: "Agency", purpose: "Public procurement and official submission path" },
  { role: "architect", label: "Architect / designer", purpose: "Design intent and specifications" },
  { role: "engineer", label: "Engineer / consultant", purpose: "Technical requirements and review" },
  { role: "contractor", label: "Contractor / GC", purpose: "Estimating, procurement, and construction" },
  { role: "bidder", label: "Bidder", purpose: "Bid invitation and estimate recipient" },
  {
    role: "plan-holder",
    label: "Plan holder / authorized proposal requester",
    purpose: "Published interest in the bid package; not proof that a bid was submitted",
  },
];

const DAY_MS = 86_400_000;
const MAX_EPOCH_SENTINEL_MS = DAY_MS;

export interface ProjectFreshnessAssessment {
  freshness: ProjectFreshness;
  label: string;
  reasons: string[];
  latestActivityAt?: string;
  ageDays?: number;
  buildStatus: {
    label: string;
    confidence: "source-reported" | "inferred" | "unknown";
    explanation: string;
  };
}

export interface OutreachRecommendation {
  action: "reach-out-now" | "reach-out-soon" | "verify-first" | "monitor" | "do-not-contact";
  window: string;
  audience: ProjectParticipant["role"][];
  explanation: string;
  externalDeliveryAllowed: false;
}

export interface ProjectOutreachAssessment {
  freshness: ProjectFreshnessAssessment;
  recommendation: OutreachRecommendation;
}

export interface ContactSheetContact {
  id: string;
  name: string;
  sourceNamed: boolean;
  role: ProjectParticipant["role"];
  provenance: "public-project-record";
  channels: Array<{
    kind: "email" | "phone" | "official portal";
    value: string;
  }>;
  missingChannels: Array<"email" | "phone" | "official portal">;
}

export interface ContactSheetRoleGroup {
  role: ProjectParticipant["role"];
  label: string;
  purpose: string;
  contacts: ContactSheetContact[];
  missingRole: boolean;
}

export interface ProjectContactSheet {
  projectId: string;
  groups: ContactSheetRoleGroup[];
  namedContacts: number;
  missingRoles: ProjectParticipant["role"][];
  notice: string;
}

export interface ContactRoutingCandidate {
  rank: number;
  role: ProjectParticipant["role"];
  roleLabel: string;
  name?: string;
  sourceNamed: boolean;
  authorityStatus: "unverified";
  email?: string;
  phone?: string;
  sourceUrl?: string;
  channelStatus: "published" | "missing";
  verifyBeforeOutreach: true;
  reason: string;
}

function parsedTime(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > MAX_EPOCH_SENTINEL_MS
    ? parsed
    : undefined;
}

function phoneIdentity(value?: string): string {
  return value?.replace(/\D/g, "") ?? "";
}

/**
 * Some public APIs put an email address or phone number in a required name
 * field when the publisher did not supply a person or organization name. Keep
 * that literal channel as evidence, but never describe it as a named contact.
 */
export function publishedParticipantName(
  participant: ProjectParticipant,
): string | undefined {
  const name = participant.name.trim();
  if (!name) return undefined;
  if (participant.email && name.toLowerCase() === participant.email.trim().toLowerCase()) {
    return undefined;
  }
  const namePhone = phoneIdentity(name);
  const publishedPhone = phoneIdentity(participant.phone);
  if (namePhone && publishedPhone && namePhone === publishedPhone) return undefined;
  return name;
}

export function participantHasPublishedName(participant: ProjectParticipant): boolean {
  return publishedParticipantName(participant) !== undefined;
}

function normalizedStatus(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function statusIncludes(status: string, tokens: readonly string[]): boolean {
  const boundedStatus = ` ${status} `;
  return tokens.some((token) => boundedStatus.includes(` ${token} `));
}

function isoDate(time: number): string {
  return new Date(time).toISOString();
}

function latestActivity(project: ProjectRecord): number | undefined {
  const candidates = [parsedTime(project.postedAt), parsedTime(project.updatedAt)].filter(
    (value): value is number => value !== undefined,
  );
  return candidates.length ? Math.max(...candidates) : undefined;
}

function activityAgeDays(activity: number | undefined, reference: number): number | undefined {
  if (activity === undefined) return undefined;
  return Math.floor((reference - activity) / DAY_MS);
}

function activeSignal(project: ProjectRecord, status: string): boolean {
  return ACTIVE_STAGES.has(project.stage) || statusIncludes(status, ACTIVE_STATUS_TOKENS);
}

/**
 * Classifies opportunity freshness from source-provided lifecycle and date signals only.
 * It never treats record age alone as proof that a building was constructed.
 */
export function classifyProjectFreshness(
  project: ProjectRecord,
  referenceDate: string | Date = new Date(),
): ProjectFreshnessAssessment {
  const reference =
    referenceDate instanceof Date ? referenceDate.getTime() : Date.parse(referenceDate);
  const now = Number.isFinite(reference) ? reference : Date.now();
  const status = normalizedStatus(project.status);
  const activity = latestActivity(project);
  const ageDays = activityAgeDays(activity, now);
  const bidTime = parsedTime(project.bidDate);
  const shared = {
    latestActivityAt: activity === undefined ? undefined : isoDate(activity),
    ageDays,
  };

  if (project.stage === "cancelled" || statusIncludes(status, INACTIVE_STATUS_TOKENS)) {
    return {
      freshness: "inactive",
      label: "Inactive",
      reasons: [
        project.stage === "cancelled"
          ? "The source lifecycle stage is cancelled."
          : `The source status is “${project.status},” which contains an inactive lifecycle signal.`,
      ],
      ...shared,
      buildStatus: {
        label: "Not proven built",
        confidence: "unknown",
        explanation: "Cancellation or inactivity does not show that construction was completed.",
      },
    };
  }

  const activePostBidStage = project.stage === "bid-opened" || project.stage === "awarded";
  if (
    project.stage === "completed" ||
    (!activePostBidStage && statusIncludes(status, CLOSED_STATUS_TOKENS))
  ) {
    const completed =
      project.stage === "completed" ||
      statusIncludes(status, ["completed", "complete", "finaled", "final permit"]);
    return {
      freshness: "closed",
      label: "Closed opportunity",
      reasons: [
        project.stage === "completed"
          ? `The source lifecycle stage is ${project.stage}.`
          : `The source status is “${project.status},” which contains a closed lifecycle signal.`,
      ],
      ...shared,
      buildStatus: completed
        ? {
            label: "Source reports complete",
            confidence: "source-reported",
            explanation:
              "The public source reports a completed/final state. Confirm occupancy or actual construction separately.",
          }
        : {
            label: "Not proven built",
            confidence: "unknown",
            explanation:
              "A closed source status does not prove the building is complete.",
          },
    };
  }

  const hasActiveSignal = activeSignal(project, status);
  if (!hasActiveSignal) {
    return {
      freshness: "unclassified",
      label: "Unclassified",
      reasons: ["The source does not provide a recognized active, closed, or inactive lifecycle signal."],
      ...shared,
      buildStatus: {
        label: "Unknown",
        confidence: "unknown",
        explanation: "There is not enough source evidence to infer whether construction occurred.",
      },
    };
  }

  const bidAgeDays = bidTime === undefined ? undefined : Math.floor((now - bidTime) / DAY_MS);
  const passedBidGrace =
    project.stage === "bidding" &&
    bidTime !== undefined &&
    now - bidTime > PASSED_BID_GRACE_DAYS * DAY_MS;
  if (passedBidGrace) {
    return {
      freshness: "stale",
      label: "Stale — verify",
      reasons: [
        `The published bid date passed ${bidAgeDays} days ago while the source still appears active.`,
      ],
      ...shared,
      buildStatus: {
        label: "Possibly progressed or abandoned",
        confidence: "inferred",
        explanation:
          "The expired bid window suggests the record may no longer be current, but it does not prove the building was built. Verify the official source.",
      },
    };
  }

  if (
    activity !== undefined &&
    activity >= now - NEW_ACTIVITY_DAYS * DAY_MS &&
    activity <= now + 2 * DAY_MS
  ) {
    return {
      freshness: "new",
      label: "New",
      reasons: [
        `The latest source activity is ${Math.max(0, ageDays ?? 0)} day${ageDays === 1 ? "" : "s"} old.`,
      ],
      ...shared,
      buildStatus: {
        label: "No completion signal",
        confidence: "unknown",
        explanation: "The source currently shows an active opportunity, not completed construction.",
      },
    };
  }

  if (bidTime !== undefined && bidTime >= now) {
    return {
      freshness: "current",
      label: "Current",
      reasons: [
        `The published bid date is ${isoDate(bidTime).slice(0, 10)}, so an old activity timestamp alone does not make the opportunity stale.`,
      ],
      ...shared,
      buildStatus: {
        label: "No completion signal",
        confidence: "unknown",
        explanation: "A future source-published bid date is an active opportunity signal, not proof of construction.",
      },
    };
  }

  if (activity === undefined) {
    return {
      freshness: "unclassified",
      label: "Verify activity",
      reasons: [
        "The source appears active but does not publish a usable activity date or future deadline.",
      ],
      ...shared,
      buildStatus: {
        label: "Unknown",
        confidence: "unknown",
        explanation:
          "An active stage without a dated source event cannot establish that the project is current or that construction occurred.",
      },
    };
  }

  const passedActivityStale =
    activity !== undefined && now - activity > STALE_ACTIVITY_DAYS * DAY_MS;
  if (passedActivityStale) {
    const reasons: string[] = [];
    if (passedActivityStale && ageDays !== undefined) {
      reasons.push(`The latest source activity is ${ageDays} days old.`);
    }
    return {
      freshness: "stale",
      label: "Stale — verify",
      reasons,
      ...shared,
      buildStatus: {
        label: "Possibly progressed or abandoned",
        confidence: "inferred",
        explanation:
          "Age suggests the record may no longer be current, but it does not prove the building was built. Verify the official source.",
      },
    };
  }

  return {
    freshness: "current",
    label: "Current",
    reasons: [
      bidTime !== undefined && bidTime >= now
        ? `The published bid date is ${isoDate(bidTime).slice(0, 10)}.`
        : `The source stage is ${project.stage} and no stale or terminal signal was found.`,
    ],
    ...shared,
    buildStatus: {
      label: "No completion signal",
      confidence: "unknown",
      explanation: "The source currently shows an active opportunity, not completed construction.",
    },
  };
}

export function freshnessMatchesFilter(
  freshness: ProjectFreshness,
  filter: FreshnessFilter | undefined,
): boolean {
  if (!filter || filter === "all") return true;
  if (filter === "actionable") return freshness === "new" || freshness === "current";
  if (filter === "closed-or-inactive") return freshness === "closed" || freshness === "inactive";
  return freshness === filter;
}

export function recommendProjectOutreach(
  project: ProjectRecord,
  freshness: ProjectFreshnessAssessment,
): OutreachRecommendation {
  if (freshness.freshness === "new") {
    return {
      action: "reach-out-now",
      window: "Reach out now — ideally within 1 business day",
      audience:
        project.stage === "planning" || project.stage === "design"
          ? ["owner", "agency", "architect"]
          : project.stage === "bidding"
            ? ["contractor", "bidder", "plan-holder", "agency"]
            : ["owner", "agency", "architect", "contractor"],
      explanation:
        project.stage === "planning" || project.stage === "design"
          ? "Early contact can happen before specifications and product selections are locked."
          : "The source has recent activity; verify the correct decision-maker and current documents before sending a package.",
      externalDeliveryAllowed: false,
    };
  }

  if (freshness.freshness === "current") {
    const bidTime = parsedTime(project.bidDate);
    return {
      action: "reach-out-soon",
      window:
        project.stage === "bidding"
          ? bidTime
            ? `Reach out now, before the published ${isoDate(bidTime).slice(0, 10)} bid date`
            : "Reach out now after confirming the bid deadline"
          : "Reach out within 2 business days",
      audience:
        project.stage === "planning" || project.stage === "design"
          ? ["owner", "agency", "architect"]
          : project.stage === "bidding"
            ? ["contractor", "bidder", "plan-holder", "agency"]
            : ["owner", "agency", "architect", "engineer", "contractor"],
      explanation:
        "Confirm the latest status, plans, addenda, and recipient channel before sending a quote or rendering.",
      externalDeliveryAllowed: false,
    };
  }

  if (freshness.freshness === "stale") {
    return {
      action: "verify-first",
      window: "Verify the official source before any outreach",
      audience: ["agency", "owner"],
      explanation:
        "Do not send a quote based on this record until an official source confirms that the project and buying window are active.",
      externalDeliveryAllowed: false,
    };
  }

  if (freshness.freshness === "closed") {
    return {
      action: "monitor",
      window: "Do not treat as an open bid; verify any post-award buying window",
      audience: project.stage === "awarded" ? ["contractor", "agency"] : ["agency"],
      explanation:
        "The active opportunity appears closed. Monitor a documented next phase or contact a sourced award recipient only after verification.",
      externalDeliveryAllowed: false,
    };
  }

  if (freshness.freshness === "inactive") {
    return {
      action: "do-not-contact",
      window: "Do not contact for this opportunity unless the source shows reactivation",
      audience: [],
      explanation: "The public lifecycle signal is cancelled or inactive.",
      externalDeliveryAllowed: false,
    };
  }

  return {
    action: "verify-first",
    window: "Research the lifecycle before outreach",
    audience: ["agency", "owner"],
    explanation:
      "There is not enough source evidence to identify a safe outreach window. No automatic contact should be attempted.",
    externalDeliveryAllowed: false,
  };
}

export function assessProjectOutreach(
  project: ProjectRecord,
  referenceDate: string | Date = new Date(),
): ProjectOutreachAssessment {
  const freshness = classifyProjectFreshness(project, referenceDate);
  return { freshness, recommendation: recommendProjectOutreach(project, freshness) };
}

export function buildProjectContactSheet(project: ProjectRecord): ProjectContactSheet {
  const seen = new Set<string>();
  const participants = project.participants.filter((participant) => {
    const publishedName = publishedParticipantName(participant);
    const channelIdentity = [participant.email, participant.phone]
      .filter(Boolean)
      .join("|")
      .toLowerCase();
    if (!publishedName && !channelIdentity) return false;
    const key = `${participant.role}:${publishedName?.toLowerCase() ?? `channel:${channelIdentity}`}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const groups = CONTACT_ROLES.map(({ role, label, purpose }) => {
    const contacts = participants
      .filter((participant) => participant.role === role)
      .map<ContactSheetContact>((participant, index) => {
        const publishedName = publishedParticipantName(participant);
        const channels: ContactSheetContact["channels"] = [
          ...(participant.email ? [{ kind: "email" as const, value: participant.email }] : []),
          ...(participant.phone ? [{ kind: "phone" as const, value: participant.phone }] : []),
          ...(participant.sourceUrl
            ? [{ kind: "official portal" as const, value: participant.sourceUrl }]
            : []),
        ];
        const publishedKinds = new Set(channels.map((channel) => channel.kind));
        return {
          id: `${project.id}:${role}:${index}:${participant.name}`,
          name: publishedName ?? "Name not published",
          sourceNamed: Boolean(publishedName),
          role,
          provenance: "public-project-record",
          channels,
          missingChannels: (["email", "phone", "official portal"] as const).filter(
            (kind) => !publishedKinds.has(kind),
          ),
        };
      });
    return { role, label, purpose, contacts, missingRole: contacts.length === 0 };
  });

  return {
    projectId: project.id,
    groups,
    namedContacts: participants.filter(participantHasPublishedName).length,
    missingRoles: groups.filter((group) => group.missingRole).map((group) => group.role),
    notice:
      "Names and literal contact channels come only from the public project record. Channel-only evidence is labeled when the source does not name a person or organization, and it is not treated as a bid recipient. No email, phone number, homeowner identity, or delivery channel is inferred. Verify authority and the lawful business channel before outreach.",
  };
}

function routingRoles(project: ProjectRecord): ProjectParticipant["role"][] {
  if (project.stage === "planning") {
    return ["owner", "architect", "agency", "engineer"];
  }
  if (project.stage === "design") {
    return ["architect", "owner", "agency", "engineer"];
  }
  if (project.stage === "permitting") {
    return ["architect", "owner", "agency", "engineer", "contractor"];
  }
  if (project.stage === "bidding") {
    return ["bidder", "contractor", "plan-holder", "agency", "architect"];
  }
  if (
    project.stage === "bid-opened" ||
    project.stage === "awarded" ||
    project.stage === "construction"
  ) {
    return ["contractor", "bidder", "plan-holder", "agency", "owner"];
  }
  return ["agency", "owner"];
}

export function rankProjectContactRoutes(project: ProjectRecord): ContactRoutingCandidate[] {
  let rank = 0;
  return routingRoles(project).flatMap((role) => {
    const definition = CONTACT_ROLES.find((candidate) => candidate.role === role)!;
    const participants = project.participants.filter(
      (participant) =>
        participant.role === role &&
        (participantHasPublishedName(participant) || participant.email || participant.phone),
    );
    const routedParticipants: Array<ProjectParticipant | undefined> = participants.length
      ? participants
      : [undefined];
    return routedParticipants.map((participant) => {
      const publishedName = participant ? publishedParticipantName(participant) : undefined;
      return {
        rank: ++rank,
        role,
        roleLabel: definition.label,
        name: publishedName,
        sourceNamed: Boolean(publishedName),
        ...(participant?.email ? { email: participant.email } : {}),
        ...(participant?.phone ? { phone: participant.phone } : {}),
        ...(participant?.sourceUrl ? { sourceUrl: participant.sourceUrl } : {}),
        authorityStatus: "unverified" as const,
        channelStatus:
          participant?.email || participant?.phone || participant?.sourceUrl
            ? "published" as const
            : "missing" as const,
        verifyBeforeOutreach: true as const,
        reason: publishedName
          ? `${definition.purpose}; name${participant?.email || participant?.phone ? " and contact channel" : ""} found in the public project record.`
          : participant?.email || participant?.phone
            ? `${definition.purpose}; a contact channel is published, but the source does not identify a named person or organization.`
            : `${definition.purpose}; no named participant with this role is in the source record.`,
      };
    });
  });
}

function csvCell(value: string): string {
  const spreadsheetSafe = /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
  return `"${spreadsheetSafe.replace(/"/g, '""')}"`;
}

export function contactSheetAsCsv(sheet: ProjectContactSheet): string {
  const rows = [
    ["role", "name", "email", "phone", "official_portal", "provenance"],
    ...sheet.groups.flatMap((group) =>
      group.contacts.length
        ? group.contacts.map((contact) => [
            group.label,
            contact.name,
            contact.channels.find((channel) => channel.kind === "email")?.value ?? "missing from source",
            contact.channels.find((channel) => channel.kind === "phone")?.value ?? "missing from source",
            contact.channels.find((channel) => channel.kind === "official portal")?.value ?? "missing from source",
            "public project record",
          ])
        : [[
            group.label,
            "missing from source",
            "missing from source",
            "missing from source",
            "missing from source",
            "public project record",
          ]],
    ),
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}
