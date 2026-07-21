import { cleanResearchText, normalizeOfficialHttpsUrl } from "./contracts.ts";
import type {
  OfficialResearchSource,
  PlanExtractionHandoff,
  ResearchContactFinding,
  ResearchDocumentFinding,
  ResearchFinding,
  ResearchLifecycleFinding,
  ResearchScopeFinding,
} from "./types.ts";

type ExtractionResult = {
  findings: ResearchFinding[];
  handoffs: Omit<PlanExtractionHandoff, "id" | "requestedAt" | "updatedAt">[];
};

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function visibleText(html: string): string {
  return cleanResearchText(
    decodeHtml(
      html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
    200_000,
  );
}

function findingBase(
  source: OfficialResearchSource,
  sourceUrl: string,
  observedAt: string,
  evidence: string,
  method: "official-page" | "official-api" | "official-document-link",
) {
  return {
    id: crypto.randomUUID(),
    sourceUrl,
    ...(source.sourceId ? { sourceId: source.sourceId } : {}),
    sourceLabel: source.sourceLabel,
    evidence: cleanResearchText(evidence, 700),
    observedAt,
    confidence: 0.9,
    provenance: {
      sourceUrl,
      ...(source.sourceId ? { sourceId: source.sourceId } : {}),
      sourceLabel: source.sourceLabel,
      retrievedAt: observedAt,
      method,
      strategy: source.strategy,
    },
  } as const;
}

function canonicalEmail(value: string): string | undefined {
  const email = value.trim().replace(/^mailto:/i, "").split("?", 1)[0].toLowerCase();
  return email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : undefined;
}

function exactPhone(value: string): string | undefined {
  const phone = cleanResearchText(value.replace(/^tel:/i, ""), 80);
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? phone : undefined;
}

const EXPLICIT_PROJECT_CONTACT_ROLE = /\b(?:project\s+(?:manager|contact|coordinator|architect|engineer|lead)|architect|engineer|contract(?:ing)?\s+officer|procurement\s+contact|purchasing\s+contact|solicitation\s+contact|bid\s+contact|permit\s+contact|applicant\s+contact|owner\s+contact|developer\s+contact|construction\s+manager|design\s+manager|contact\s+person|primary\s+contact|general\s+contractor\s+contact|contractor\s+contact)\b/i;

type ContactContext = {
  text: string;
  role: string;
  roleIndex: number;
};

function contactContextLines(html: string): string[] {
  const withLiteralChannels = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(
      /<a\b[^>]*href\s*=\s*["']mailto:([^"']+)["'][^>]*>/gi,
      (_, value: string) => ` Email: ${decodeHtml(value).split("?", 1)[0]} `,
    )
    .replace(
      /<a\b[^>]*href\s*=\s*["']tel:([^"']+)["'][^>]*>/gi,
      (_, value: string) => ` Phone: ${decodeHtml(value)} `,
    )
    .replace(
      /<\/(?:p|li|tr|dd|address|div|section|article|header|footer|main|form|table|h[1-6])\s*>|<br\b[^>]*\/?\s*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");

  const unique = new Set<string>();
  for (const line of decodeHtml(withLiteralChannels).split(/\n+/)) {
    // A role and a channel must occur in the same bounded structural block.
    // Rejecting oversized blocks prevents a project-role label near the top of
    // a page from being paired with an unrelated footer/webmaster address.
    if (line.length > 1_200) continue;
    const text = cleanResearchText(line, 1_200);
    if (text) unique.add(text);
  }
  return [...unique];
}

function explicitContactContext(text: string): ContactContext | undefined {
  const match = EXPLICIT_PROJECT_CONTACT_ROLE.exec(text);
  if (!match || match.index === undefined) return undefined;
  const context = {
    text,
    role: cleanResearchText(match[0], 100),
    roleIndex: match.index,
  };
  const afterRole = text.slice(match.index + match[0].length);
  const channelImmediatelyAfterRole = /^\s*(?::|[-|,])?\s*(?:e-?mail|phone|telephone|tel|mobile)\b/i.test(afterRole);
  return associatedContactName(context) || channelImmediatelyAfterRole ? context : undefined;
}

function plausibleAssociatedName(value: string): string | undefined {
  const name = cleanResearchText(value, 160);
  if (
    !name ||
    /\b(?:contact|email|phone|telephone|official|project|manager|architect|engineer|officer|procurement|purchasing|solicitation|permit|applicant|owner|developer|contractor)\b/i.test(name)
  ) {
    return undefined;
  }
  return name;
}

function associatedContactName(context: ContactContext): string | undefined {
  const roleEnd = context.roleIndex + context.role.length;
  const afterRole = context.text.slice(roleEnd);
  const afterMatch = /^\s*(?::|[-|,])?\s*([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3}?)(?=\s+(?:e-?mail|phone|telephone|tel|mobile)\b|\s*[,;|]\s*(?:e-?mail|phone|telephone|tel|mobile)\b|\s*$)/i.exec(afterRole);
  if (afterMatch) return plausibleAssociatedName(afterMatch[1]);

  const beforeRole = context.text.slice(0, context.roleIndex);
  const beforeMatch = /([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3})\s*(?:[,;|:-])?\s*$/.exec(beforeRole);
  const channelAfterRole = /^\s*(?::|[-|,])?\s*(?:e-?mail|phone|telephone|tel|mobile)\b/i.test(afterRole);
  return beforeMatch && channelAfterRole ? plausibleAssociatedName(beforeMatch[1]) : undefined;
}

function labeledPhoneValues(text: string): string[] {
  const phones = new Set<string>();
  for (const match of text.matchAll(
    /\b(?:phone|telephone|tel|mobile)\s*(?::|#|-)?\s*(\+?(?:\d[\s().-]*){9,}\d(?:\s*(?:x|ext\.?)\s*\d{1,6})?)/gi,
  )) {
    const phone = exactPhone(match[1]);
    if (phone) phones.add(phone);
  }
  return [...phones];
}

function documentType(label: string): ResearchDocumentFinding["documentType"] | undefined {
  const value = label.toLowerCase();
  if (/\b(?:user manual|user guide|help guide|website guide|privacy policy|terms of use)\b/.test(value)) {
    return undefined;
  }
  if (/\b(?:plan[-_\s]*holders?|plan[-_\s]*takers?|prospective[-_\s]+bidders?|bidder[-_\s]+lists?|list[-_\s]+of[-_\s]+bidders?|bid[-_\s]+tab(?:s|ulation)?|tabulation[-_\s]+of[-_\s]+bids?|bid[-_\s]+results?)\b/.test(value)) {
    return "other";
  }
  if (/\baddend(?:a|um)\b/.test(value)) return "addenda";
  if (/\b(?:spec(?:ification)?s?|special provisions?)\b/.test(value)) return "specifications";
  if (/\bnotice to bidders?\b/.test(value)) return "other";
  if (/\b(?:drawing|blueprint|sheet set)\b/.test(value)) return "drawings";
  if (/\b(?:cad|dwg|dxf|dgn|ifc|rvt|revit)\b/.test(value)) return "cad";
  if (/\b(?:bid form|proposal form|schedule of values)\b/.test(value)) return "bid-form";
  if (/\bplans?\b/.test(value)) return "plans";
  if (/\.(?:pdf|zip|docx?|xlsx?)\b/.test(value)) return "other";
  return undefined;
}

function safeDiscoveredUrl(href: string, baseUrl: string, allowedHosts: readonly string[]): string | undefined {
  if (/^(?:mailto|tel|javascript|data):/i.test(href.trim())) return undefined;
  try {
    const normalized = normalizeOfficialHttpsUrl(new URL(decodeHtml(href), baseUrl).toString());
    const host = new URL(normalized).hostname.toLowerCase();
    return allowedHosts.map((value) => value.toLowerCase()).includes(host) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function lifecycleFromStatus(
  source: OfficialResearchSource,
  sourceUrl: string,
  observedAt: string,
  rawStatus: string,
  evidence: string,
  method: "official-page" | "official-api",
): ResearchLifecycleFinding {
  const status = cleanResearchText(rawStatus, 120);
  const normalized = status.toLowerCase();
  const terminal = /\b(?:complete(?:d)?|closed[ -]?out|finaled|cancelled|canceled|withdrawn)\b/.test(normalized);
  const stage = /\b(?:complete|closed[ -]?out|finaled)\b/.test(normalized)
    ? "completed"
    : /\b(?:cancelled|canceled|withdrawn)\b/.test(normalized)
      ? "cancelled"
      : /\baward/.test(normalized)
        ? "awarded"
        : /\b(?:advertised|open|bidding|solicitation)\b/.test(normalized)
          ? "bidding"
          : /\b(?:upcoming|scheduled|planning)\b/.test(normalized)
            ? "planning"
            : undefined;
  return {
    ...findingBase(source, sourceUrl, observedAt, evidence, method),
    kind: "lifecycle",
    ...(stage ? { stage } : {}),
    officialStatus: status,
    terminal,
    terminalBasis: terminal ? "official-status-field" : "none",
  };
}

function dedupeFindings(findings: ResearchFinding[]): ResearchFinding[] {
  const unique = new Map<string, ResearchFinding>();
  for (const finding of findings) {
    const value = finding.kind === "contact"
      ? `${finding.email ?? ""}|${finding.phone ?? ""}|${finding.displayName ?? ""}`
      : finding.kind === "document"
        ? finding.url
        : finding.kind === "scope"
          ? `${finding.factType}|${finding.value.toLowerCase()}`
          : `${finding.officialStatus.toLowerCase()}|${finding.sourceUrl}`;
    const key = `${finding.kind}|${value}`;
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()];
}

export function extractGenericOfficialPage(
  body: string,
  finalUrl: string,
  source: OfficialResearchSource,
  observedAt: string,
): ExtractionResult {
  const text = visibleText(body);
  const findings: ResearchFinding[] = [];
  const handoffs: ExtractionResult["handoffs"] = [];
  const sourceMethod = source.strategy === "configured-exact-record"
    ? "official-api" as const
    : "official-page" as const;

  for (const line of contactContextLines(body)) {
    const context = explicitContactContext(line);
    if (!context) continue;
    const emails = new Set<string>();
    for (const match of line.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
      const email = canonicalEmail(match[0]);
      if (email) emails.add(email);
    }
    const phones = labeledPhoneValues(line);
    if (!emails.size && !phones.length) continue;
    const displayName = associatedContactName(context);
    const evidence = cleanResearchText(line, 700);
    for (const email of [...emails].slice(0, 4)) {
      findings.push({
        ...findingBase(source, finalUrl, observedAt, evidence, sourceMethod),
        confidence: displayName ? 0.94 : 0.86,
        kind: "contact",
        ...(displayName ? { displayName } : {}),
        email,
        role: context.role,
      } satisfies ResearchContactFinding);
    }
    for (const phone of phones.slice(0, 3)) {
      findings.push({
        ...findingBase(source, finalUrl, observedAt, evidence, sourceMethod),
        confidence: displayName ? 0.94 : 0.86,
        kind: "contact",
        ...(displayName ? { displayName } : {}),
        phone,
        role: context.role,
      } satisfies ResearchContactFinding);
    }
  }

  for (const anchor of body.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = cleanResearchText(visibleText(anchor[2]), 240) || "Official project document";
    const url = safeDiscoveredUrl(anchor[1], finalUrl, source.allowedHosts);
    const type = documentType(`${label} ${anchor[1]}`);
    if (!url || !type) continue;
    const finding: ResearchDocumentFinding = {
      ...findingBase(source, finalUrl, observedAt, `Official link: ${label} — ${url}`, "official-document-link"),
      kind: "document",
      name: label,
      documentType: type,
      url,
      access: "public-link",
      textExtractionStatus: "awaiting-extractor",
    };
    findings.push(finding);
    handoffs.push({
      findingId: finding.id,
      handoffType: "plan-text-extraction",
      status: "awaiting-extractor",
      sourceUrl: url,
      detail: "Official document link discovered. Byte retrieval, OCR, PDF text extraction, and CAD conversion are intentionally delegated to the authorized document-extraction pipeline.",
    });
  }

  const sentencePattern = /[^.!?\n]{0,80}\b(?:scope of work|work includes|project consists|project description|construct(?:ion)?|install|replace|renovat|improvements?)\b[^.!?\n]{10,500}[.!?]?/gi;
  for (const match of text.matchAll(sentencePattern)) {
    const value = cleanResearchText(match[0], 600);
    if (value.length < 25) continue;
    findings.push({
      ...findingBase(source, finalUrl, observedAt, value, sourceMethod),
      kind: "scope",
      factType: "scope-clause",
      value,
    } satisfies ResearchScopeFinding);
    if (findings.filter((finding) => finding.kind === "scope").length >= 10) break;
  }

  for (const match of text.matchAll(
    /\b(?:project\s+)?status\s*:\s*((?:upcoming projects?|scheduled|advertised|bidding|open|solicitation|awarded|completed?|closed[ -]?out|finaled|cancelled|canceled|withdrawn))\b/gi,
  )) {
    findings.push(lifecycleFromStatus(source, finalUrl, observedAt, match[1], cleanResearchText(match[0], 180), sourceMethod));
    break;
  }
  if (!findings.some((finding) => finding.kind === "lifecycle")) {
    const noticeType = /\b(solicitation|intent to award|award)\s+notice type\b/i.exec(text);
    if (noticeType) {
      findings.push(
        lifecycleFromStatus(
          source,
          finalUrl,
          observedAt,
          noticeType[1],
          cleanResearchText(noticeType[0], 180),
          sourceMethod,
        ),
      );
    }
  }

  return { findings: dedupeFindings(findings), handoffs };
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function walkJson(root: unknown): JsonRecord[] {
  const records: JsonRecord[] = [];
  const queue: unknown[] = [root];
  let visited = 0;
  while (queue.length && visited < 20_000) {
    const value = queue.shift();
    visited += 1;
    if (Array.isArray(value)) {
      queue.push(...value.slice(0, 2_000));
      continue;
    }
    const record = asRecord(value);
    if (!record) continue;
    records.push(record);
    queue.push(...Object.values(record));
  }
  return records;
}

function fieldMap(record: JsonRecord): Map<string, string> {
  const result = new Map<string, string>();
  const primary = asRecord(record.display_field);
  if (primary && typeof primary.label === "string") {
    const value = typeof primary.display_value === "string" ? primary.display_value : primary.value;
    if (typeof value === "string" && value.trim()) result.set(primary.label.toLowerCase(), cleanResearchText(value, 700));
  }
  if (Array.isArray(record.secondary_fields)) {
    for (const item of record.secondary_fields) {
      const field = asRecord(item);
      if (!field || typeof field.label !== "string") continue;
      const value = typeof field.display_value === "string" ? field.display_value : field.value;
      if (typeof value === "string" && value.trim()) result.set(field.label.toLowerCase(), cleanResearchText(value, 700));
    }
  }
  return result;
}

function mapped(fields: Map<string, string>, ...labels: string[]): string | undefined {
  for (const label of labels) {
    const value = fields.get(label.toLowerCase());
    if (value) return value;
  }
  return undefined;
}

export function extractCaltransContractDetail(
  body: string,
  finalUrl: string,
  source: OfficialResearchSource,
  contractId: string,
  observedAt: string,
): ExtractionResult {
  const parsed = JSON.parse(body) as unknown;
  const records = walkJson(parsed);
  const findings: ResearchFinding[] = [];
  const handoffs: ExtractionResult["handoffs"] = [];

  for (const record of records) {
    const fields = fieldMap(record);
    if (!fields.size) continue;
    const displayedId = mapped(fields, "District EA");
    if (displayedId === contractId) {
      const work = mapped(fields, "Work Description");
      const location = mapped(fields, "Location Description", "County-Route-PM");
      const license = [mapped(fields, "License Callout"), typeof record.licenses === "string" ? record.licenses : undefined]
        .filter(Boolean).join(" ");
      for (const [factType, value] of [
        ["work-description", work],
        ["location", location],
        ["license", license || undefined],
      ] as const) {
        if (!value) continue;
        findings.push({
          ...findingBase(source, finalUrl, observedAt, `${factType}: ${value}`, "official-api"),
          kind: "scope",
          factType,
          value,
        } satisfies ResearchScopeFinding);
      }
      const status = mapped(fields, "Status");
      if (status) findings.push(lifecycleFromStatus(source, finalUrl, observedAt, status, `Official Status: ${status}`, "official-api"));
    }

    const className = typeof record.className === "string" ? record.className.toLowerCase() : "";
    if (className.includes("proposal_items")) {
      const description = mapped(fields, "Description");
      if (description && findings.filter((finding) => finding.kind === "scope" && finding.factType === "quantity-item").length < 40) {
        const line = mapped(fields, "Item Line Number");
        const quantity = mapped(fields, "Quantity");
        const unit = mapped(fields, "Unit");
        const value = [line ? `Item ${line}` : undefined, description, quantity ? `Quantity ${quantity}${unit ? ` ${unit}` : ""}` : undefined]
          .filter(Boolean).join(" — ");
        findings.push({
          ...findingBase(source, finalUrl, observedAt, value, "official-api"),
          kind: "scope",
          factType: "quantity-item",
          value,
        } satisfies ResearchScopeFinding);
      }
    }

    const email = canonicalEmail(mapped(
      fields,
      "Email",
      "Contact Email",
      "Alternate Contact Email",
      "Alt Contact Email",
    ) ?? "");
    const phone = exactPhone(mapped(fields, "Phone", "Telephone") ?? "");
    if (email || phone) {
      const alternateName = [
          mapped(fields, "Alternate Contact First Name", "Alt Contact First Name"),
          mapped(fields, "Alternate Contact Last Name", "Alt Contact Last Name"),
        ].filter(Boolean).join(" ") || undefined;
      const displayName = mapped(fields, "Contact", "Contact Name", "Name") ?? alternateName;
      const organization = mapped(fields, "Contractor", "Vendor", "Firm");
      const evidence = [displayName, organization, email, phone].filter(Boolean).join(" — ");
      findings.push({
        ...findingBase(source, finalUrl, observedAt, evidence, "official-api"),
        kind: "contact",
        ...(displayName ? { displayName } : {}),
        ...(organization ? { organization } : {}),
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        role: className.includes("contractor") ? "contractor / plan-holder contact" : "official project contact",
      } satisfies ResearchContactFinding);
    }
  }

  for (const record of records) {
    const fileName = typeof record.fileName === "string"
      ? cleanResearchText(record.fileName, 240)
      : typeof record.file_name === "string"
        ? cleanResearchText(record.file_name, 240)
        : undefined;
    const fileId = typeof record.file_sys_id === "string" ? record.file_sys_id.trim() : undefined;
    if (!fileName || !fileId || !/^[a-f0-9]{32}$/i.test(fileId)) continue;
    const type = documentType(fileName) ?? "other";
    const url = `https://cdotprod.service-now.com/api/x_cado2_contractor/public_attachment_downloader_api/${fileId}`;
    const finding: ResearchDocumentFinding = {
      ...findingBase(source, finalUrl, observedAt, `Caltrans attachment: ${fileName}`, "official-document-link"),
      kind: "document",
      name: fileName,
      documentType: type,
      url,
      access: "public-link",
      textExtractionStatus: "awaiting-extractor",
    };
    findings.push(finding);
    handoffs.push({
      findingId: finding.id,
      handoffType: "plan-text-extraction",
      status: "awaiting-extractor",
      sourceUrl: url,
      detail: "Caltrans public attachment discovered. An authorized extraction worker must retrieve and process its plan/specification text; this research pass does not perform OCR or CAD conversion.",
    });
  }

  return { findings: dedupeFindings(findings), handoffs };
}
