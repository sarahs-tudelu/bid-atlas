import { PLAN_CONTACT_EXTRACTION_CAPABILITY } from "./plan-contact-extraction";

const APOLLO_PERSON_ENRICHMENT_ENDPOINT =
  "https://api.apollo.io/api/v1/people/match";

const PERSONAL_EMAIL_DOMAINS = new Set([
  "aol.com",
  "comcast.net",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
  "ymail.com",
]);

export type IntegrationCapabilityFlags = {
  apolloConfigured: boolean;
  outboundDeliveryConfigured: boolean;
  planContactExtraction: typeof PLAN_CONTACT_EXTRACTION_CAPABILITY;
};

export type EnrichmentRequestProvenance = {
  projectId?: string;
  sourceDocumentId?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  observedAt?: string;
};

export type ProfessionalPersonEnrichmentInput = {
  confirmCreditUse: true;
  firstName?: string;
  lastName?: string;
  name?: string;
  professionalEmail?: string;
  organizationName?: string;
  organizationDomain?: string;
  linkedinUrl?: string;
  providerPersonId?: string;
  provenance?: EnrichmentRequestProvenance;
};

export type ProfessionalPersonEnrichmentResult = {
  provider: "apollo";
  operation: "professional-person-enrichment";
  matched: boolean;
  person: {
    providerPersonId?: string;
    firstName?: string;
    lastName?: string;
    name?: string;
    title?: string;
    headline?: string;
    professionalEmail?: string;
    professionalEmailStatus?: string;
    linkedinUrl?: string;
    city?: string;
    state?: string;
    country?: string;
    organization?: {
      providerOrganizationId?: string;
      name?: string;
      primaryDomain?: string;
      websiteUrl?: string;
      industry?: string;
      estimatedEmployees?: number;
    };
  } | null;
  provenance: {
    provider: "Apollo People Enrichment API";
    providerEndpoint: "people/match";
    providerRecordId?: string;
    retrievedAt: string;
    request: EnrichmentRequestProvenance;
  };
  privacy: {
    professionalEmailOnly: true;
    personalEmailsRequested: false;
    phoneNumbersRequested: false;
    waterfallRequested: false;
  };
  creditUse: {
    confirmedByCaller: true;
    exactCreditsReportedByProvider: false;
  };
};

export class EnrichmentInputError extends Error {
  readonly status = 400;
  readonly code = "invalid_enrichment_request";
}

export class EnrichmentProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function getIntegrationCapabilityFlags(): IntegrationCapabilityFlags {
  return {
    apolloConfigured:
      Boolean(process.env.APOLLO_API_KEY?.trim()) &&
      process.env.APOLLO_ENRICHMENT_ENABLED === "true",
    // No outbound adapter exists in this scaffold. An Apollo API key alone does
    // not prove that a mailbox is linked or that delivery is ready.
    outboundDeliveryConfigured: false,
    planContactExtraction: PLAN_CONTACT_EXTRACTION_CAPABILITY,
  };
}

export function parseProfessionalPersonEnrichmentInput(
  value: unknown,
): ProfessionalPersonEnrichmentInput {
  const body = asRecord(value);
  if (!body) {
    throw new EnrichmentInputError("Request body must be a JSON object.");
  }
  if (body.confirmCreditUse !== true) {
    throw new EnrichmentInputError(
      "confirmCreditUse must be true because Apollo enrichment can consume credits.",
    );
  }

  const name = optionalText(body.name, "name", 160);
  const firstName = optionalText(body.firstName, "firstName", 80);
  const lastName = optionalText(body.lastName, "lastName", 80);
  const professionalEmail = optionalProfessionalEmail(
    body.professionalEmail,
    "professionalEmail",
  );
  const organizationName = optionalText(
    body.organizationName,
    "organizationName",
    180,
  );
  const organizationDomain = optionalDomain(
    body.organizationDomain,
    "organizationDomain",
  );
  const linkedinUrl = optionalLinkedinUrl(body.linkedinUrl, "linkedinUrl");
  const providerPersonId = optionalIdentifier(
    body.providerPersonId,
    "providerPersonId",
  );
  const provenance = parseProvenance(body.provenance);

  const hasFullName = Boolean(name || (firstName && lastName));
  const hasEmployer = Boolean(organizationDomain || organizationName);
  if (
    !professionalEmail &&
    !providerPersonId &&
    !linkedinUrl &&
    !(hasFullName && hasEmployer)
  ) {
    throw new EnrichmentInputError(
      "Provide a professional email, Apollo person ID, LinkedIn URL, or a full name plus employer name/domain.",
    );
  }

  return compact({
    confirmCreditUse: true as const,
    name,
    firstName,
    lastName,
    professionalEmail,
    organizationName,
    organizationDomain,
    linkedinUrl,
    providerPersonId,
    provenance,
  });
}

export async function enrichProfessionalPersonWithApollo(
  input: ProfessionalPersonEnrichmentInput,
  apiKey: string,
): Promise<ProfessionalPersonEnrichmentResult> {
  const requestPayload: Record<string, string | boolean> = {};

  if (input.name) {
    requestPayload.name = input.name;
  } else {
    if (input.firstName) requestPayload.first_name = input.firstName;
    if (input.lastName) requestPayload.last_name = input.lastName;
  }
  if (input.professionalEmail) requestPayload.email = input.professionalEmail;
  if (input.organizationName) {
    requestPayload.organization_name = input.organizationName;
  }
  if (input.organizationDomain) requestPayload.domain = input.organizationDomain;
  if (input.linkedinUrl) requestPayload.linkedin_url = input.linkedinUrl;
  if (input.providerPersonId) requestPayload.id = input.providerPersonId;

  // Keep all personal-data and waterfall controls explicitly disabled even
  // though Apollo currently defaults them to false.
  requestPayload.reveal_personal_emails = false;
  requestPayload.reveal_phone_number = false;
  requestPayload.run_waterfall_email = false;
  requestPayload.run_waterfall_phone = false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(APOLLO_PERSON_ENRICHMENT_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(requestPayload),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new EnrichmentProviderError(
        504,
        "apollo_timeout",
        "Apollo did not respond before the enrichment request timed out.",
      );
    }
    throw new EnrichmentProviderError(
      502,
      "apollo_unavailable",
      `Apollo could not be reached: ${safeErrorMessage(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw providerHttpError(response.status);
  }

  let responsePayload: unknown;
  try {
    responsePayload = await response.json();
  } catch {
    throw new EnrichmentProviderError(
      502,
      "apollo_invalid_response",
      "Apollo returned a response that was not valid JSON.",
    );
  }

  const root = asRecord(responsePayload);
  const rawPerson = root ? asRecord(root.person) : null;
  const person = rawPerson ? sanitizeApolloPerson(rawPerson) : null;
  const providerRecordId = person?.providerPersonId;

  return {
    provider: "apollo",
    operation: "professional-person-enrichment",
    matched: Boolean(person),
    person,
    provenance: compact({
      provider: "Apollo People Enrichment API" as const,
      providerEndpoint: "people/match" as const,
      providerRecordId,
      retrievedAt: new Date().toISOString(),
      request: input.provenance ?? {},
    }),
    privacy: {
      professionalEmailOnly: true,
      personalEmailsRequested: false,
      phoneNumbersRequested: false,
      waterfallRequested: false,
    },
    creditUse: {
      confirmedByCaller: true,
      exactCreditsReportedByProvider: false,
    },
  };
}

function sanitizeApolloPerson(
  person: Record<string, unknown>,
): NonNullable<ProfessionalPersonEnrichmentResult["person"]> {
  const organization = asRecord(person.organization);
  const providerPersonId = safeOutputIdentifier(person.id);
  const firstName = safeOutputText(person.first_name, 80);
  const lastName = safeOutputText(person.last_name, 80);
  const name = safeOutputText(person.name, 160);
  const professionalEmail = safeOutputProfessionalEmail(person.email);

  return compact({
    providerPersonId,
    firstName,
    lastName,
    name:
      name ?? ([firstName, lastName].filter(Boolean).join(" ") || undefined),
    title: safeOutputText(person.title, 180),
    headline: safeOutputText(person.headline, 240),
    professionalEmail,
    professionalEmailStatus: professionalEmail
      ? safeOutputText(person.email_status, 40)
      : undefined,
    linkedinUrl: safeOutputLinkedinUrl(person.linkedin_url),
    city: safeOutputText(person.city, 100),
    state: safeOutputText(person.state, 100),
    country: safeOutputText(person.country, 100),
    organization: organization
      ? compact({
          providerOrganizationId: safeOutputIdentifier(organization.id),
          name: safeOutputText(organization.name, 180),
          primaryDomain: safeOutputDomain(organization.primary_domain),
          websiteUrl: safeOutputHttpUrl(organization.website_url),
          industry: safeOutputText(organization.industry, 120),
          estimatedEmployees: safeOutputInteger(
            organization.estimated_num_employees,
          ),
        })
      : undefined,
  });
}

function parseProvenance(value: unknown): EnrichmentRequestProvenance {
  if (value === undefined || value === null) return {};
  const provenance = asRecord(value);
  if (!provenance) {
    throw new EnrichmentInputError("provenance must be a JSON object.");
  }

  return compact({
    projectId: optionalText(provenance.projectId, "provenance.projectId", 120),
    sourceDocumentId: optionalText(
      provenance.sourceDocumentId,
      "provenance.sourceDocumentId",
      160,
    ),
    sourceLabel: optionalText(
      provenance.sourceLabel,
      "provenance.sourceLabel",
      180,
    ),
    sourceUrl: optionalHttpUrl(
      provenance.sourceUrl,
      "provenance.sourceUrl",
    ),
    observedAt: optionalTimestamp(
      provenance.observedAt,
      "provenance.observedAt",
    ),
  });
}

function providerHttpError(status: number): EnrichmentProviderError {
  if (status === 401 || status === 403) {
    return new EnrichmentProviderError(
      502,
      "apollo_credentials_or_permissions",
      "Apollo rejected the configured credentials or account permissions.",
    );
  }
  if (status === 429) {
    return new EnrichmentProviderError(
      429,
      "apollo_rate_limited",
      "Apollo rate-limited the enrichment request. No enrichment result was returned.",
    );
  }
  if (status >= 500) {
    return new EnrichmentProviderError(
      502,
      "apollo_provider_error",
      `Apollo returned a provider error (${status}).`,
    );
  }
  return new EnrichmentProviderError(
    502,
    "apollo_request_rejected",
    `Apollo rejected the enrichment request (${status}).`,
  );
}

function optionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new EnrichmentInputError(`${field} must be a string.`);
  }
  const cleaned = cleanText(value, maxLength);
  if (!cleaned) throw new EnrichmentInputError(`${field} cannot be blank.`);
  return cleaned;
}

function optionalProfessionalEmail(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new EnrichmentInputError(`${field} must be a string.`);
  }
  const email = normalizeProfessionalEmail(value);
  if (!email) {
    throw new EnrichmentInputError(
      `${field} must be a valid professional email on a non-personal domain.`,
    );
  }
  return email;
}

function optionalDomain(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new EnrichmentInputError(`${field} must be a string.`);
  }
  const domain = normalizeDomain(value);
  if (!domain) throw new EnrichmentInputError(`${field} must be a valid domain.`);
  return domain;
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new EnrichmentInputError(`${field} must be a string.`);
  }
  const identifier = value.trim();
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(identifier)) {
    throw new EnrichmentInputError(`${field} has an invalid format.`);
  }
  return identifier;
}

function optionalLinkedinUrl(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const url = optionalHttpUrl(value, field);
  if (!url) return undefined;
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com")) {
    throw new EnrichmentInputError(`${field} must use a LinkedIn domain.`);
  }
  return url;
}

function optionalHttpUrl(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new EnrichmentInputError(`${field} must be a string.`);
  }
  const url = normalizeHttpUrl(value);
  if (!url) throw new EnrichmentInputError(`${field} must be a valid HTTP(S) URL.`);
  return url;
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new EnrichmentInputError(`${field} must be a string.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new EnrichmentInputError(`${field} must be a valid timestamp.`);
  }
  return parsed.toISOString();
}

function normalizeProfessionalEmail(value: string): string | undefined {
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return undefined;
  }
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (PERSONAL_EMAIL_DOMAINS.has(domain)) return undefined;
  return email;
}

function normalizeDomain(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//, "");
  const candidate = trimmed.split(/[/?#]/, 1)[0].replace(/\.$/, "");
  if (
    candidate.length < 3 ||
    candidate.length > 253 ||
    candidate.includes("@") ||
    candidate.includes(":") ||
    !candidate.includes(".") ||
    !/^[a-z0-9.-]+$/.test(candidate) ||
    candidate.split(".").some((label) =>
      !label || label.length > 63 || label.startsWith("-") || label.endsWith("-")
    )
  ) {
    return undefined;
  }
  return candidate.replace(/^www\./, "");
}

function normalizeHttpUrl(value: string): string | undefined {
  if (value.length > 2_048) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeOutputText(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" ? cleanText(value, maxLength) || undefined : undefined;
}

function safeOutputProfessionalEmail(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeProfessionalEmail(value) : undefined;
}

function safeOutputIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const identifier = value.trim();
  return /^[A-Za-z0-9_-]{1,160}$/.test(identifier) ? identifier : undefined;
}

function safeOutputLinkedinUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const url = normalizeHttpUrl(value);
  if (!url) return undefined;
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")
    ? url
    : undefined;
}

function safeOutputHttpUrl(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeHttpUrl(value) : undefined;
}

function safeOutputDomain(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeDomain(value) : undefined;
}

function safeOutputInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function cleanText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "network request failed";
  return cleanText(error.message, 160) || "network request failed";
}
