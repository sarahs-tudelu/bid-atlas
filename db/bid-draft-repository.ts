import { TUDELU_PUBLIC_PROFILE } from "../app/lib/company-profile.ts";
import {
  BID_DRAFT_PIPELINE_STAGES,
  BID_DRAFT_READINESS_KEYS,
  type BidDraftPipelineStage,
  type BidDraftProjectSnapshot,
  type PersistedBidDraft,
  type PersistedBidRecipient,
  type PersistedQuoteLineItem,
  type SaveBidDraftRequest,
  type SavedBidDraftRecord,
} from "../app/lib/bid-draft-types.ts";
import type { ProjectParticipant, ProjectStage } from "../app/lib/types";

interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface BidDraftD1Database {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

interface StoredPackageRow {
  packageId: string;
  opportunityId: string;
  packageNumber: string;
  title: string;
  scopeDescription: string | null;
  exclusions: string | null;
  terms: string | null;
  coverMessage: string | null;
  updatedAt: string;
  createdBy: string | null;
}

interface StoredDraftIdentityRow {
  opportunityId: string;
  packageId: string | null;
}

interface ParsedDeliveryChannel {
  kind: "email" | "portal";
  normalized: string;
}

interface StoredLineItemRow {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
}

interface StoredTerms {
  leadTime?: unknown;
  validity?: unknown;
  messageSubject?: unknown;
  readiness?: unknown;
  pipelineStage?: unknown;
  recipients?: unknown;
}

const SUPPLIER_PROFILE_ID = "supplier:tudelu-holdings";
const PROJECT_STAGES: ProjectStage[] = [
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
];
const PARTICIPANT_ROLES: ProjectParticipant["role"][] = [
  "owner",
  "agency",
  "architect",
  "engineer",
  "contractor",
  "bidder",
  "plan-holder",
];

export class BidDraftInputError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    status = 400,
  ) {
    super(message);
    this.name = "BidDraftInputError";
    this.code = code;
    this.status = status;
  }
}

export class BidDraftStorageUnavailableError extends Error {
  constructor() {
    super("Private bid-draft storage is not available in this environment.");
    this.name = "BidDraftStorageUnavailableError";
  }
}

export function parseSaveBidDraftRequest(value: unknown): SaveBidDraftRequest {
  const root = objectValue(value, "Request body");
  const projectValue = objectValue(root.project, "project");
  const draftValue = objectValue(root.draft, "draft");
  const project: BidDraftProjectSnapshot = {
    id: requiredString(projectValue.id, "project.id", 300),
    canonicalKey: optionalString(projectValue.canonicalKey, "project.canonicalKey", 300) ??
      requiredString(projectValue.id, "project.id", 300),
    title: requiredString(projectValue.title, "project.title", 500),
    summary: optionalString(projectValue.summary, "project.summary", 4_000) ?? "",
    stage: enumValue(projectValue.stage, "project.stage", PROJECT_STAGES),
    status: requiredString(projectValue.status, "project.status", 200),
    agency: requiredString(projectValue.agency, "project.agency", 500),
    ownerName: optionalString(projectValue.ownerName, "project.ownerName", 500),
    architectName: optionalString(projectValue.architectName, "project.architectName", 500),
    engineerName: optionalString(projectValue.engineerName, "project.engineerName", 500),
    address: optionalString(projectValue.address, "project.address", 500),
    city: optionalString(projectValue.city, "project.city", 200),
    county: optionalString(projectValue.county, "project.county", 200),
    state: optionalString(projectValue.state, "project.state", 40),
    postalCode: optionalString(projectValue.postalCode, "project.postalCode", 24),
    estimatedValue: optionalNumber(projectValue.estimatedValue, "project.estimatedValue"),
    postedAt: optionalIsoDate(projectValue.postedAt, "project.postedAt"),
    bidDate: optionalIsoDate(projectValue.bidDate, "project.bidDate"),
    awardDate: optionalIsoDate(projectValue.awardDate, "project.awardDate"),
    sourceId: requiredString(projectValue.sourceId, "project.sourceId", 300),
    sourceUrl: httpUrl(projectValue.sourceUrl, "project.sourceUrl"),
  };

  const lineItemsValue = arrayValue(draftValue.lineItems, "draft.lineItems", 100);
  if (!lineItemsValue.length) {
    throw new BidDraftInputError("line_items_required", "At least one line item is required.");
  }
  const lineItems = lineItemsValue.map((lineItem, index) =>
    parseLineItem(lineItem, `draft.lineItems[${index}]`),
  );
  const readinessValue = objectValue(draftValue.readiness, "draft.readiness");
  const readiness = Object.fromEntries(
    BID_DRAFT_READINESS_KEYS.map((key) => [key, readinessValue[key] === true]),
  ) as PersistedBidDraft["readiness"];
  const draft: PersistedBidDraft = {
    quoteNumber: requiredString(draftValue.quoteNumber, "draft.quoteNumber", 120),
    packageName: requiredString(draftValue.packageName, "draft.packageName", 300),
    scope: optionalString(draftValue.scope, "draft.scope", 12_000) ?? "",
    exclusions: optionalString(draftValue.exclusions, "draft.exclusions", 12_000) ?? "",
    leadTime: optionalString(draftValue.leadTime, "draft.leadTime", 300) ?? "",
    validity: optionalString(draftValue.validity, "draft.validity", 300) ?? "",
    lineItems,
    messageSubject: optionalString(draftValue.messageSubject, "draft.messageSubject", 500) ?? "",
    messageBody: optionalString(draftValue.messageBody, "draft.messageBody", 20_000) ?? "",
    readiness,
  };

  const recipientsValue = arrayValue(root.recipients, "recipients", 50);
  const recipients = recipientsValue.map((recipient, index) =>
    parseRecipient(recipient, `recipients[${index}]`),
  );
  const uniqueRecipientKeys = new Set<string>();
  for (const recipient of recipients) {
    const key = `${recipient.clientId}\u0000${normalizeDestination(recipient.channel)}`;
    if (uniqueRecipientKeys.has(key)) {
      throw new BidDraftInputError("duplicate_recipient", "Recipients must be unique.");
    }
    uniqueRecipientKeys.add(key);
  }

  return {
    project,
    draft,
    pipelineStage: enumValue(
      root.pipelineStage,
      "pipelineStage",
      [...BID_DRAFT_PIPELINE_STAGES],
    ),
    recipients,
  };
}

export async function persistBidDraft(
  db: BidDraftD1Database,
  input: SaveBidDraftRequest,
  savedBy: string,
  savedAt = new Date().toISOString(),
): Promise<SavedBidDraftRecord> {
  const ownerKey = normalizeOwnerKey(savedBy);
  const stableKey = await sha256Hex(
    `${SUPPLIER_PROFILE_ID}\u0000${ownerKey}\u0000${input.project.id}`,
  );
  const existingDraft = await db.prepare(
    `SELECT
       opportunities.id AS opportunityId,
       packages.id AS packageId
     FROM bid_opportunities opportunities
     LEFT JOIN bid_packages packages
       ON packages.bid_opportunity_id=opportunities.id
       AND packages.owner_key=?
     WHERE opportunities.supplier_profile_id=?
       AND opportunities.owner_key=?
       AND opportunities.project_id=?
       AND opportunities.scope_key='primary'
     ORDER BY packages.version DESC, packages.updated_at DESC
     LIMIT 1`,
  ).bind(ownerKey, SUPPLIER_PROFILE_ID, ownerKey, input.project.id)
    .first<StoredDraftIdentityRow>();
  const opportunityId = existingDraft?.opportunityId ?? `bidopp:${stableKey.slice(0, 32)}`;
  const packageId = existingDraft?.packageId ?? `bidpkg:${stableKey.slice(0, 32)}:draft`;
  const contentHash = await sha256Hex(JSON.stringify(input));
  const subtotal = input.draft.lineItems.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0,
  );
  const storedTerms = JSON.stringify({
    leadTime: input.draft.leadTime,
    validity: input.draft.validity,
    messageSubject: input.draft.messageSubject,
    readiness: input.draft.readiness,
    pipelineStage: input.pipelineStage,
    recipients: input.recipients,
  });
  const exclusions = input.draft.exclusions ? JSON.stringify([input.draft.exclusions]) : "[]";
  const statements: D1PreparedStatementLike[] = [
    db.prepare(
      `INSERT INTO supplier_profiles (
         id, legal_name, website, address_line_1, city, state, postal_code,
         public_phone, public_email, products, source_url, verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         legal_name=excluded.legal_name,
         website=excluded.website,
         address_line_1=excluded.address_line_1,
         city=excluded.city,
         state=excluded.state,
         postal_code=excluded.postal_code,
         public_phone=excluded.public_phone,
         public_email=excluded.public_email,
         products=excluded.products,
         source_url=excluded.source_url,
         verified_at=excluded.verified_at,
         updated_at=excluded.updated_at`,
    ).bind(
      SUPPLIER_PROFILE_ID,
      TUDELU_PUBLIC_PROFILE.legalName,
      TUDELU_PUBLIC_PROFILE.website,
      TUDELU_PUBLIC_PROFILE.addressLine1,
      TUDELU_PUBLIC_PROFILE.city,
      TUDELU_PUBLIC_PROFILE.state,
      TUDELU_PUBLIC_PROFILE.postalCode,
      TUDELU_PUBLIC_PROFILE.phone,
      TUDELU_PUBLIC_PROFILE.publicEmail,
      JSON.stringify(TUDELU_PUBLIC_PROFILE.products),
      TUDELU_PUBLIC_PROFILE.sourceUrl,
      TUDELU_PUBLIC_PROFILE.verifiedAt,
      savedAt,
      savedAt,
    ),
    db.prepare(
      `INSERT INTO projects (
         id, canonical_key, title, summary, stage, status, agency, owner_name,
         architect_name, engineer_name, address, city, county, state, postal_code,
         estimated_value, posted_at, bid_date, award_date, first_seen_at, last_seen_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      input.project.id,
      input.project.canonicalKey,
      input.project.title,
      input.project.summary,
      input.project.stage,
      input.project.status,
      input.project.agency,
      input.project.ownerName ?? null,
      input.project.architectName ?? null,
      input.project.engineerName ?? null,
      input.project.address ?? null,
      input.project.city ?? null,
      input.project.county ?? null,
      input.project.state ?? null,
      input.project.postalCode ?? null,
      input.project.estimatedValue ?? null,
      input.project.postedAt ?? null,
      input.project.bidDate ?? null,
      input.project.awardDate ?? null,
      savedAt,
      savedAt,
      savedAt,
    ),
    db.prepare(
      `INSERT INTO bid_opportunities (
         id, supplier_profile_id, owner_key, project_id, scope_key, status, priority,
         project_title_snapshot, project_stage_snapshot, scope_summary, decision,
         bid_due_at, source_url, provenance, confidence, discovered_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'primary', 'drafting', 'normal', ?, ?, ?, 'pursue', ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status='drafting',
         project_title_snapshot=excluded.project_title_snapshot,
         project_stage_snapshot=excluded.project_stage_snapshot,
         scope_summary=excluded.scope_summary,
         decision='pursue',
         bid_due_at=excluded.bid_due_at,
         source_url=excluded.source_url,
         provenance=excluded.provenance,
         updated_at=excluded.updated_at`,
    ).bind(
      opportunityId,
      SUPPLIER_PROFILE_ID,
      ownerKey,
      input.project.id,
      input.project.title,
      input.project.stage,
      input.draft.scope || null,
      input.project.bidDate ?? null,
      input.project.sourceUrl,
      JSON.stringify({ sourceId: input.project.sourceId, sourceUrl: input.project.sourceUrl }),
      savedAt,
      savedAt,
      savedAt,
    ),
    db.prepare(
      `INSERT INTO bid_packages (
         id, bid_opportunity_id, owner_key, package_number, version, title, status,
         scope_description, currency, direct_cost, subtotal, tax, total,
         cover_message, assumptions, exclusions, terms, requires_approval,
         approval_status, content_hash, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, 'draft', ?, 'USD', 0, ?, 0, ?, ?, '[]', ?, ?, 1, 'pending', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         package_number=excluded.package_number,
         title=excluded.title,
         status='draft',
         scope_description=excluded.scope_description,
         subtotal=excluded.subtotal,
         total=excluded.total,
         cover_message=excluded.cover_message,
         exclusions=excluded.exclusions,
         terms=excluded.terms,
         approval_status='pending',
         approved_by=NULL,
         approved_at=NULL,
         approval_note=NULL,
         content_hash=excluded.content_hash,
         updated_at=excluded.updated_at`,
    ).bind(
      packageId,
      opportunityId,
      ownerKey,
      input.draft.quoteNumber,
      input.draft.packageName,
      input.draft.scope || null,
      subtotal,
      subtotal,
      input.draft.messageBody || null,
      exclusions,
      storedTerms,
      contentHash,
      ownerKey,
      savedAt,
      savedAt,
    ),
    db.prepare("DELETE FROM bid_line_items WHERE bid_package_id=?").bind(packageId),
    db.prepare("DELETE FROM bid_recipients WHERE bid_package_id=?").bind(packageId),
  ];

  input.draft.lineItems.forEach((item, index) => {
    statements.push(
      db.prepare(
        `INSERT INTO bid_line_items (
           id, bid_package_id, line_number, item_type, description, quantity,
           unit, unit_price, amount, taxable, is_alternate, created_at, updated_at
         ) VALUES (?, ?, ?, 'product', ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      ).bind(
        `${packageId}:line:${index + 1}`,
        packageId,
        index + 1,
        item.description,
        item.quantity,
        item.unit,
        item.unitPrice,
        item.quantity * item.unitPrice,
        savedAt,
        savedAt,
      ),
    );
  });
  for (let index = 0; index < input.recipients.length; index += 1) {
    const recipient = input.recipients[index];
    const normalizedDestination = recipient.channel
      ? normalizeDestination(recipient.channel)
      : `unresolved:${await sha256Hex(recipient.clientId)}`;
    const recipientKey = await sha256Hex(`${recipient.clientId}\u0000${normalizedDestination}`);
    const verifiedAt = recipient.verified ? savedAt : null;
    statements.push(
      db.prepare(
        `INSERT INTO bid_recipients (
           id, bid_package_id, recipient_role, delivery_channel, destination,
           normalized_destination, is_primary, status, verification_status,
           verified_at, verified_by, consent_basis, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `${packageId}:recipient:${recipientKey.slice(0, 20)}`,
        packageId,
        recipient.role,
        recipient.channel ? deliveryChannelKind(recipient.channel) : "unresolved",
        recipient.channel,
        normalizedDestination,
        index === 0 ? 1 : 0,
        recipient.verified && recipient.channel ? "team-verified" : "unverified",
        verifiedAt,
        recipient.verified && recipient.channel ? ownerKey : null,
        recipient.verified && recipient.verificationSourceUrl
          ? `Channel verified against ${recipient.verificationSourceUrl}; no delivery authorization implied.`
          : "Project-specific route saved for review; no delivery authorization implied.",
        savedAt,
        savedAt,
      ),
    );
  }

  await db.batch(statements);
  return {
    projectId: input.project.id,
    packageId,
    opportunityId,
    savedAt,
    savedBy: ownerKey,
    pipelineStage: input.pipelineStage,
    draft: input.draft,
    recipients: input.recipients,
    notice: "Draft saved privately. Nothing was emailed, uploaded, or submitted.",
  };
}

export async function loadBidDraft(
  db: BidDraftD1Database,
  projectId: string,
  savedBy: string,
): Promise<SavedBidDraftRecord | null> {
  const normalizedProjectId = requiredString(projectId, "projectId", 300);
  const ownerKey = normalizeOwnerKey(savedBy);
  const packageRow = await db.prepare(
    `SELECT
       packages.id AS packageId,
       packages.bid_opportunity_id AS opportunityId,
       packages.package_number AS packageNumber,
       packages.title AS title,
       packages.scope_description AS scopeDescription,
       packages.exclusions AS exclusions,
       packages.terms AS terms,
       packages.cover_message AS coverMessage,
       packages.updated_at AS updatedAt,
       packages.created_by AS createdBy
     FROM bid_packages packages
     JOIN bid_opportunities opportunities ON opportunities.id=packages.bid_opportunity_id
     WHERE opportunities.supplier_profile_id=?
       AND opportunities.owner_key=?
       AND opportunities.project_id=?
       AND packages.owner_key=?
     ORDER BY packages.version DESC, packages.updated_at DESC
     LIMIT 1`,
  ).bind(SUPPLIER_PROFILE_ID, ownerKey, normalizedProjectId, ownerKey).first<StoredPackageRow>();
  if (!packageRow) return null;

  const lineResult = await db.prepare(
    `SELECT id, description, quantity, unit, unit_price AS unitPrice
     FROM bid_line_items
     WHERE bid_package_id=?
     ORDER BY line_number ASC`,
  ).bind(packageRow.packageId).all<StoredLineItemRow>();
  const terms = parseStoredTerms(packageRow.terms);
  const recipients = parseStoredRecipients(terms.recipients);
  const lineItems = (lineResult.results ?? []).map((row) => ({
    id: row.id,
    description: row.description,
    quantity: Number(row.quantity),
    unit: row.unit,
    unitPrice: Number(row.unitPrice),
  }));
  const readinessValue = objectOrEmpty(terms.readiness);
  const readiness = Object.fromEntries(
    BID_DRAFT_READINESS_KEYS.map((key) => [key, readinessValue[key] === true]),
  ) as PersistedBidDraft["readiness"];
  const pipelineStage = isPipelineStage(terms.pipelineStage) ? terms.pipelineStage : "research";
  return {
    projectId: normalizedProjectId,
    packageId: packageRow.packageId,
    opportunityId: packageRow.opportunityId,
    savedAt: packageRow.updatedAt,
    savedBy: packageRow.createdBy ?? "workspace user",
    pipelineStage,
    draft: {
      quoteNumber: packageRow.packageNumber,
      packageName: packageRow.title,
      scope: packageRow.scopeDescription ?? "",
      exclusions: firstJsonString(packageRow.exclusions),
      leadTime: stringOrEmpty(terms.leadTime),
      validity: stringOrEmpty(terms.validity),
      lineItems,
      messageSubject: stringOrEmpty(terms.messageSubject),
      messageBody: packageRow.coverMessage ?? "",
      readiness,
    },
    recipients,
    notice: "Private draft restored. Nothing was emailed, uploaded, or submitted.",
  };
}

export async function persistBidDraftToConfiguredStorage(
  input: SaveBidDraftRequest,
  savedBy: string,
): Promise<SavedBidDraftRecord> {
  const db = await configuredD1();
  if (!db) throw new BidDraftStorageUnavailableError();
  return persistBidDraft(db, input, savedBy);
}

export async function loadBidDraftFromConfiguredStorage(
  projectId: string,
  savedBy: string,
): Promise<SavedBidDraftRecord | null> {
  const db = await configuredD1();
  if (!db) throw new BidDraftStorageUnavailableError();
  return loadBidDraft(db, projectId, savedBy);
}

function parseLineItem(value: unknown, field: string): PersistedQuoteLineItem {
  const item = objectValue(value, field);
  return {
    id: requiredString(item.id, `${field}.id`, 200),
    description: requiredString(item.description, `${field}.description`, 1_000),
    quantity: boundedNumber(item.quantity, `${field}.quantity`),
    unit: requiredString(item.unit, `${field}.unit`, 40),
    unitPrice: boundedNumber(item.unitPrice, `${field}.unitPrice`),
  };
}

function parseRecipient(value: unknown, field: string): PersistedBidRecipient {
  const recipient = objectValue(value, field);
  const rawChannel = optionalString(recipient.channel, `${field}.channel`, 2_048) ?? "";
  const parsedChannel = rawChannel ? parseDeliveryChannel(rawChannel) : null;
  if (rawChannel && !parsedChannel) {
    throw new BidDraftInputError(
      "invalid_recipient_channel",
      `${field}.channel must be an email address or an https URL.`,
    );
  }
  const channel = parsedChannel?.normalized ?? "";
  const rawVerificationSourceUrl =
    optionalString(recipient.verificationSourceUrl, `${field}.verificationSourceUrl`, 2_048) ?? "";
  const parsedVerificationSource = rawVerificationSourceUrl
    ? parseDeliveryChannel(rawVerificationSourceUrl)
    : null;
  if (rawVerificationSourceUrl && parsedVerificationSource?.kind !== "portal") {
    throw new BidDraftInputError(
      "invalid_recipient_verification_source",
      `${field}.verificationSourceUrl must be a full https URL.`,
    );
  }
  const verificationSourceUrl = parsedVerificationSource?.normalized;
  return {
    clientId: requiredString(recipient.clientId, `${field}.clientId`, 500),
    participantName: requiredString(recipient.participantName, `${field}.participantName`, 500),
    role: enumValue(recipient.role, `${field}.role`, PARTICIPANT_ROLES),
    channel,
    ...(verificationSourceUrl ? { verificationSourceUrl } : {}),
    verified: Boolean(channel && verificationSourceUrl && recipient.verified === true),
  };
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BidDraftInputError("invalid_object", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value)) {
    throw new BidDraftInputError("invalid_array", `${field} must be an array.`);
  }
  if (value.length > max) {
    throw new BidDraftInputError("too_many_items", `${field} may contain at most ${max} items.`);
  }
  return value;
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BidDraftInputError("required_field", `${field} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new BidDraftInputError("field_too_long", `${field} may contain at most ${max} characters.`);
  }
  return normalized;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new BidDraftInputError("invalid_string", `${field} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new BidDraftInputError("field_too_long", `${field} may contain at most ${max} characters.`);
  }
  return normalized || undefined;
}

function enumValue<T extends string>(value: unknown, field: string, allowed: T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new BidDraftInputError("invalid_enum", `${field} contains an unsupported value.`);
  }
  return value as T;
}

function boundedNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
    throw new BidDraftInputError(
      "invalid_number",
      `${field} must be a finite number from 0 through 1,000,000,000.`,
    );
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedNumber(value, field);
}

function optionalIsoDate(value: unknown, field: string): string | undefined {
  const normalized = optionalString(value, field, 80);
  if (!normalized) return undefined;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new BidDraftInputError("invalid_date", `${field} must contain a valid date.`);
  }
  return new Date(parsed).toISOString();
}

function httpUrl(value: unknown, field: string): string {
  const normalized = requiredString(value, field, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new BidDraftInputError("invalid_url", `${field} must contain a valid URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new BidDraftInputError("invalid_url", `${field} must use http or https.`);
  }
  return parsed.toString();
}

function normalizeDestination(value: string): string {
  return parseDeliveryChannel(value)?.normalized ?? value.trim();
}

function normalizeOwnerKey(value: string): string {
  const normalized = requiredString(value, "savedBy", 254);
  const channel = parseDeliveryChannel(normalized);
  if (channel?.kind !== "email") {
    throw new BidDraftInputError(
      "invalid_owner_key",
      "The authenticated bid-draft owner must have a valid email address.",
    );
  }
  return channel.normalized;
}

function deliveryChannelKind(value: string): ParsedDeliveryChannel["kind"] {
  const channel = parseDeliveryChannel(value);
  if (!channel) {
    throw new BidDraftInputError(
      "invalid_recipient_channel",
      "Recipient delivery routes must be a valid email address or an https URL.",
    );
  }
  return channel.kind;
}

function parseDeliveryChannel(value: string): ParsedDeliveryChannel | null {
  const normalized = value.trim();
  if (!normalized || /[\s\u0000-\u001f\u007f\\]/.test(normalized)) return null;

  const email = normalizeEmailAddress(normalized);
  if (email) return { kind: "email", normalized: email };

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    !validPublicHostname(url.hostname)
  ) {
    return null;
  }
  return { kind: "portal", normalized: url.toString() };
}

function normalizeEmailAddress(value: string): string | null {
  if (value.length > 254) return null;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase();
  if (
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) ||
    !validDomainName(domain)
  ) {
    return null;
  }
  return `${local.toLowerCase()}@${domain}`;
}

function validPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return /^[0-9a-f:.]+$/i.test(normalized.slice(1, -1));
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized.split(".").every((part) => Number(part) <= 255);
  }
  return validDomainName(normalized);
}

function validDomainName(domain: string): boolean {
  if (domain.length > 253 || !domain.includes(".")) return false;
  const labels = domain.split(".");
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

function parseStoredTerms(value: string | null): StoredTerms {
  if (!value) return {};
  try {
    return objectOrEmpty(JSON.parse(value));
  } catch {
    return {};
  }
}

function parseStoredRecipients(value: unknown): PersistedBidRecipient[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    try {
      return [parseRecipient(item, "stored recipient")];
    } catch {
      return [];
    }
  });
}

function firstJsonString(value: string | null): string {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === "string").join("\n");
  } catch {
    return value;
  }
  return "";
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isPipelineStage(value: unknown): value is BidDraftPipelineStage {
  return typeof value === "string" && BID_DRAFT_PIPELINE_STAGES.includes(value as BidDraftPipelineStage);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function configuredD1(): Promise<BidDraftD1Database | null> {
  try {
    const { env } = await import("cloudflare:workers");
    return ((env as unknown as { DB?: BidDraftD1Database }).DB ?? null);
  } catch {
    return null;
  }
}
