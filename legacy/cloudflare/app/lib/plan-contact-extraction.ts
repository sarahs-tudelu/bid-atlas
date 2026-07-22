export const PLAN_CONTACT_EXTRACTION_CAPABILITY = {
  status: "queued" as const,
  enabled: false,
  parserReady: true,
  reason:
    "No production service currently retrieves plan/specification binaries or writes successful page-aware document extractions and chunks.",
  activatesAfter: [
    "lawful public-document retrieval",
    "successful page-aware text extraction",
    "document chunk persistence with extraction and version provenance",
  ],
  persistence: "disabled" as const,
} as const;

export type PlanContactRole =
  | "owner"
  | "architect"
  | "engineer"
  | "contractor"
  | "agency";

export type PageAwarePlanTextChunk = {
  id: string;
  projectId: string;
  documentVersionId: string;
  extractionId: string;
  chunkOrder: number;
  pageStart: number | null;
  pageEnd: number | null;
  chunkText: string;
  sourceUrl?: string | null;
};

export type PlanContactCandidate = {
  role: PlanContactRole;
  roleSourceText: string;
  contactType: "person" | "organization";
  displayName: string;
  organizationName?: string;
  jobTitle?: string;
  email?: string;
  phone?: string;
  phoneExtension?: string;
  confidence: number;
  verificationStatus: "unverified";
  evidence: {
    text: string;
    pageStart: number;
    pageEnd: number;
  };
  provenance: {
    method: "explicit-plan-role-label";
    projectId: string;
    documentVersionId: string;
    extractionId: string;
    chunkId: string;
    chunkOrder: number;
    pageStart: number;
    pageEnd: number;
    sourceUrl?: string;
  };
};

type RoleDefinition = {
  role: PlanContactRole;
  label: RegExp;
};

type RoleLineMatch = {
  role: PlanContactRole;
  sourceLabel: string;
  inlineSubject?: string;
};

const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    role: "owner",
    label: /(?:property\s+|building\s+|project\s+)?owner(?:\s*\/\s*client)?/i,
  },
  {
    role: "architect",
    label: /(?:(?:design|project)\s+)?architect(?:\s+of\s+record)?/i,
  },
  {
    role: "engineer",
    label:
      /(?:(?:civil|structural|mechanical|electrical|plumbing|mep|geotechnical|project)\s+)?engineer(?:\s+of\s+record)?/i,
  },
  {
    role: "contractor",
    label: /(?:(?:general|prime|construction)\s+)?contractor/i,
  },
  {
    role: "agency",
    label: /(?:(?:contracting|issuing|lead|public)\s+)?agency/i,
  },
] as const;

const MAX_BLOCK_LINES = 8;
const MAX_EVIDENCE_LENGTH = 1_200;
const FIELD_BOUNDARY =
  /^(?:plan\s+holders?|prospective\s+bidders?|bidders?|subcontractors?|consultants?|developers?|applicants?|drawn\s+by|checked\s+by|prepared\s+by|sheet|project)\s*(?::|\||[-\u2013\u2014])(?:\s|$)/i;
const CONTACT_FIELD = /^(?:contact(?:\s+person)?|attn|attention|name)\s*(?::|[-\u2013\u2014])\s*(.+)$/i;
const ORGANIZATION_FIELD = /^(?:organization|company|firm|office)\s*(?::|[-\u2013\u2014])\s*(.+)$/i;
const TITLE_FIELD = /^(?:title|position)\s*(?::|[-\u2013\u2014])\s*(.+)$/i;
const EMAIL_FIELD = /^(?:e-?mail)\s*(?::|[-\u2013\u2014])\s*(.+)$/i;
const PHONE_FIELD =
  /^(?:phone|telephone|tel|mobile|cell|direct(?:\s+line)?)\s*(?::|#|[-\u2013\u2014])\s*(.+)$/i;
const NON_SUBJECT_FIELD =
  /^(?:address|phone|telephone|tel|mobile|cell|direct|fax|facsimile|e-?mail|website|web|url|license|project|sheet|date)\b/i;
const ORGANIZATION_MARKER =
  /\b(?:llc|l\.l\.c\.?|incorporated|inc\.?|corp(?:oration)?\.?|company|co\.?|lp|llp|pllc|pc|p\.c\.|architects?|architecture|engineers?|engineering|construction|builders?|department|agency|authority|university|college|school|district|county|city\s+of|state\s+of|group|studio|associates?)\b/i;
const PERSON_CREDENTIAL = /(?:,|\s)\s*(?:aia|ncarb|p\.?e\.?|r\.?a\.?)\s*$/i;
const EMAIL_TOKEN =
  /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi;

/**
 * Parses already-extracted, page-aware plan/specification text. It does not
 * retrieve documents, run OCR, infer a role from a name, or persist contacts.
 * A candidate is emitted only when one of the supported roles labels a block.
 */
export function parsePlanContactCandidates(
  chunks: readonly PageAwarePlanTextChunk[],
): PlanContactCandidate[] {
  const candidates: PlanContactCandidate[] = [];

  for (const chunk of chunks) {
    if (!hasUsablePageRange(chunk) || !chunk.chunkText.trim()) continue;
    const lines = chunk.chunkText
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/\u00a0/g, " ").trim());

    for (let index = 0; index < lines.length; index += 1) {
      const heading = matchRoleLine(lines[index]);
      if (!heading) continue;

      const blockLines: string[] = [];
      let blankRun = 0;
      for (
        let cursor = index + 1;
        cursor < lines.length && blockLines.length < MAX_BLOCK_LINES;
        cursor += 1
      ) {
        const line = lines[cursor];
        if (matchRoleLine(line) || FIELD_BOUNDARY.test(line)) break;
        if (!line) {
          blankRun += 1;
          if (blankRun >= 2) break;
          continue;
        }
        blankRun = 0;
        blockLines.push(line);
      }

      const candidate = candidateFromBlock(chunk, heading, lines[index], blockLines);
      if (candidate) candidates.push(candidate);
    }
  }

  return deduplicateCandidates(candidates);
}

function candidateFromBlock(
  chunk: PageAwarePlanTextChunk & { pageStart: number; pageEnd: number },
  heading: RoleLineMatch,
  headingLine: string,
  blockLines: readonly string[],
): PlanContactCandidate | null {
  const segments = blockLines.flatMap(splitFields);
  const contactName = firstFieldValue(segments, CONTACT_FIELD);
  const explicitOrganization = firstFieldValue(segments, ORGANIZATION_FIELD);
  const jobTitle = firstFieldValue(segments, TITLE_FIELD);
  const fallbackSubject = segments.find(isPlausibleSubject);
  const subject = cleanFieldValue(
    heading.inlineSubject ?? explicitOrganization ?? fallbackSubject ?? "",
  );
  const displayName = cleanFieldValue(contactName ?? subject);
  if (!displayName) return null;

  const subjectIsOrganization = Boolean(subject && looksLikeOrganization(subject));
  const contactType: "person" | "organization" = contactName
    ? "person"
    : subjectIsOrganization
      ? "organization"
      : "person";
  const organizationName = cleanFieldValue(
    explicitOrganization ?? (contactName && subjectIsOrganization ? subject : ""),
  );
  const email = uniqueEmail(segments);
  const phone = firstPhone(segments);
  const evidenceText = [headingLine, ...blockLines]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_EVIDENCE_LENGTH);

  let confidence = 0.68;
  if (contactName) confidence += 0.08;
  if (organizationName || contactType === "organization") confidence += 0.05;
  if (email) confidence += 0.08;
  if (phone) confidence += 0.06;

  return {
    role: heading.role,
    roleSourceText: heading.sourceLabel,
    contactType,
    displayName,
    ...(organizationName ? { organizationName } : {}),
    ...(jobTitle ? { jobTitle } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone: phone.value } : {}),
    ...(phone?.extension ? { phoneExtension: phone.extension } : {}),
    confidence: Math.min(0.95, Number(confidence.toFixed(2))),
    verificationStatus: "unverified",
    evidence: {
      text: evidenceText,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
    },
    provenance: {
      method: "explicit-plan-role-label",
      projectId: chunk.projectId,
      documentVersionId: chunk.documentVersionId,
      extractionId: chunk.extractionId,
      chunkId: chunk.id,
      chunkOrder: chunk.chunkOrder,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      ...(chunk.sourceUrl ? { sourceUrl: chunk.sourceUrl } : {}),
    },
  };
}

function matchRoleLine(line: string): RoleLineMatch | null {
  if (!line) return null;
  for (const definition of ROLE_DEFINITIONS) {
    const match = new RegExp(
      `^\\s*(${definition.label.source})\\s*(?:(?::|\\||[-\\u2013\\u2014])\\s*(.*))?\\s*$`,
      "i",
    ).exec(line);
    if (!match) continue;
    const inlineSubject = cleanFieldValue(match[2] ?? "");
    return {
      role: definition.role,
      sourceLabel: match[1].trim(),
      ...(inlineSubject ? { inlineSubject } : {}),
    };
  }
  return null;
}

function splitFields(line: string): string[] {
  return line
    .split(/\s+\|\s+|\t+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function firstFieldValue(segments: readonly string[], pattern: RegExp): string | undefined {
  for (const segment of segments) {
    const match = pattern.exec(segment);
    const value = cleanFieldValue(match?.[1] ?? "");
    if (value) return value;
  }
  return undefined;
}

function isPlausibleSubject(value: string): boolean {
  const clean = cleanFieldValue(value);
  if (!clean || clean.length < 2 || clean.length > 180) return false;
  if (NON_SUBJECT_FIELD.test(clean) || FIELD_BOUNDARY.test(clean)) return false;
  if (/^(?:n\/?a|none|unknown|not\s+(?:available|listed)|tbd)$/i.test(clean)) return false;
  if (/^\d{1,6}\s+\S+/.test(clean)) return false;
  if (EMAIL_TOKEN.test(clean)) {
    EMAIL_TOKEN.lastIndex = 0;
    return false;
  }
  EMAIL_TOKEN.lastIndex = 0;
  return /[A-Za-z]/.test(clean);
}

function cleanFieldValue(value: string): string {
  return value
    .replace(/^mailto:/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:|\-\u2013\u2014]+|[\s|]+$/g, "")
    .trim()
    .slice(0, 180);
}

function looksLikeOrganization(value: string): boolean {
  if (ORGANIZATION_MARKER.test(value)) return true;
  if (PERSON_CREDENTIAL.test(value)) return false;
  return /\b(?:services|design|development|properties|partners|holdings)\b/i.test(value);
}

function uniqueEmail(segments: readonly string[]): string | undefined {
  const labeledValues = segments
    .map((segment) => EMAIL_FIELD.exec(segment)?.[1])
    .filter((value): value is string => Boolean(value));
  const searchable = labeledValues.length ? labeledValues : segments;
  const matches = new Set<string>();
  for (const value of searchable) {
    const tokens = value.match(EMAIL_TOKEN) ?? [];
    for (const token of tokens) {
      const normalized = normalizeEmail(token);
      if (normalized) matches.add(normalized);
    }
  }
  return matches.size === 1 ? Array.from(matches)[0] : undefined;
}

function normalizeEmail(value: string): string | undefined {
  const email = value.toLowerCase().replace(/[),.;:]+$/g, "");
  if (email.length > 254 || email.includes("..")) return undefined;
  const [local, domain, extra] = email.split("@");
  if (extra || !local || !domain || local.length > 64) return undefined;
  if (local.startsWith(".") || local.endsWith(".")) return undefined;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.at(-1)!.length < 2) return undefined;
  if (labels.some((label) => !label || label.startsWith("-") || label.endsWith("-"))) {
    return undefined;
  }
  return email;
}

function firstPhone(
  segments: readonly string[],
): { value: string; extension?: string } | undefined {
  for (const segment of segments) {
    if (/^(?:fax|facsimile)\b/i.test(segment)) continue;
    const match = PHONE_FIELD.exec(segment);
    if (!match) continue;
    const beforeFax = match[1].split(/\b(?:fax|facsimile)\b/i)[0].trim();
    const extensionMatch = /(?:\s|,)*(?:ext\.?|extension|x)\s*#?\s*(\d{1,6})\s*$/i.exec(beforeFax);
    const base = extensionMatch
      ? beforeFax.slice(0, extensionMatch.index).trim()
      : beforeFax;
    let digits = base.replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    if (digits.length !== 10) continue;
    if (digits.startsWith("000") || digits.slice(3, 6) === "000") continue;
    return {
      value: `+1 ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`,
      ...(extensionMatch ? { extension: extensionMatch[1] } : {}),
    };
  }
  return undefined;
}

function hasUsablePageRange(
  chunk: PageAwarePlanTextChunk,
): chunk is PageAwarePlanTextChunk & { pageStart: number; pageEnd: number } {
  return (
    Number.isInteger(chunk.pageStart) &&
    Number.isInteger(chunk.pageEnd) &&
    (chunk.pageStart ?? 0) >= 1 &&
    (chunk.pageEnd ?? 0) >= (chunk.pageStart ?? Number.POSITIVE_INFINITY)
  );
}

function deduplicateCandidates(
  candidates: readonly PlanContactCandidate[],
): PlanContactCandidate[] {
  const unique = new Map<string, PlanContactCandidate>();
  for (const candidate of candidates) {
    const key = [
      candidate.provenance.documentVersionId,
      candidate.evidence.pageStart,
      candidate.evidence.pageEnd,
      candidate.role,
      candidate.displayName.toLowerCase(),
      candidate.email ?? "",
      candidate.phone ?? "",
    ].join("|");
    const previous = unique.get(key);
    if (!previous || candidate.confidence > previous.confidence) unique.set(key, candidate);
  }
  return Array.from(unique.values());
}
