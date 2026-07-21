import type {
  DiscoveredPosting,
  SourceMonitorFormat,
  SourceMonitorRecord,
} from "./contracts";

const MAX_POSTINGS_PER_SCAN = 100;
const BID_LANGUAGE = /\b(bid|bids|bidding|proposal|proposals|quote|quotes|tender|solicitation|invitation to bid|itb|rfp|rfq)\b/i;
const DOCUMENT_LANGUAGE = /\b(plan|plans|drawing|drawings|spec|specs|specification|specifications|addendum|bid documents?|bid package)\b/i;
const POSTING_LINK_LANGUAGE = /\b(bid|project|solicitation|proposal|quote|tender|itb|rfp|rfq|construction|renovation|improvement)\b/i;

type ParseContext = Pick<
  SourceMonitorRecord,
  "publisher" | "city" | "state" | "sourceType" | "feedUrl" | "feedFormat"
>;

type Anchor = { href: string; text: string };

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function textContent(value: unknown, maximum = 5_000): string {
  if (typeof value !== "string") return "";
  return decodeEntities(
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function xmlValue(block: string, names: readonly string[]): string {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i").exec(block);
    if (match) return textContent(match[1]);
  }
  return "";
}

function absolutePublicUrl(value: unknown, base: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(decodeEntities(value.trim()), base);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function anchors(value: string, base: string): Anchor[] {
  const result: Anchor[] = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of value.matchAll(pattern)) {
    const href = absolutePublicUrl(match[1] ?? match[2] ?? match[3], base);
    const text = textContent(match[4], 300);
    if (href && text) result.push({ href, text });
  }
  return result;
}

function normalizedDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  const isoDay = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text)?.[1];
  if (isoDay && !/[T ]\d{1,2}:\d{2}/.test(text)) return isoDay;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function deadlineFromText(value: string): string | undefined {
  const label = String.raw`(?:bid(?:s|ding)?(?:\s+(?:due|date|deadline|opening))?|closing(?:\s+date)?|responses?\s+due|proposals?\s+due|quotes?\s+due|deadline|due\s+date)`;
  const date = String.raw`((?:20\d{2}-\d{1,2}-\d{1,2})|(?:\d{1,2}\/\d{1,2}\/20\d{2})|(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s+20\d{2}))(?:\s+(?:at\s+)?\d{1,2}:\d{2}(?:\s*[ap]m)?)?`;
  const match = new RegExp(`${label}\\s*(?:is|:|-)?\\s*${date}`, "i").exec(value);
  if (!match?.[1]) return undefined;
  const cleaned = match[1].replace(/(\d)(?:st|nd|rd|th)\b/i, "$1");
  const parsed = normalizedDate(cleaned);
  if (!parsed) return undefined;
  return /\d{1,2}:\d{2}/.test(cleaned) ? parsed : parsed.slice(0, 10);
}

function publishedDate(value: unknown): string | undefined {
  const parsed = normalizedDate(value);
  return parsed && /^\d{4}-\d{2}-\d{2}$/.test(parsed)
    ? `${parsed}T00:00:00.000Z`
    : parsed;
}

function emailFromText(value: string): string | undefined {
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.exec(value)?.[0]?.toLowerCase();
}

function phoneFromText(value: string): string | undefined {
  const match = /\b(?:tel|phone|call)\s*[:.-]?\s*(\+?1?[\s.(\-]*\d{3}[\s.)\-]*\d{3}[\s.\-]*\d{4}(?:\s*(?:x|ext\.?|extension)\s*\d{1,6})?)/i.exec(value);
  return match?.[1]?.replace(/\s+/g, " ").trim();
}

function tradeTags(values: unknown[]): string[] {
  const tags = values.flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return value.split(/[,;|]/);
    return [];
  });
  return [...new Set(tags.map((tag) => textContent(String(tag), 80).toLowerCase()).filter(Boolean))].slice(0, 30);
}

function opportunityType(context: ParseContext): DiscoveredPosting["opportunityType"] {
  return context.sourceType === "public-procurement" ? "public-bid" : "company-posted";
}

function documentFromMarkup(markup: string, base: string, fallbackUrl: string, allText: string) {
  const direct = anchors(markup, base).find((anchor) => DOCUMENT_LANGUAGE.test(`${anchor.text} ${anchor.href}`));
  if (direct) return { url: direct.href, name: direct.text };
  if (DOCUMENT_LANGUAGE.test(allText)) {
    return { url: fallbackUrl, name: "Plans, specifications, or bid documents" };
  }
  return {};
}

function submissionFromMarkup(markup: string, base: string): string | undefined {
  return anchors(markup, base).find((anchor) => /\b(submit|submission|respond|proposal portal|bid portal)\b/i.test(anchor.text))?.href;
}

function posting(input: {
  context: ParseContext;
  sourceRecordId: string;
  sourceUrl: string;
  title: string;
  summary: string;
  rawMarkup?: string;
  postedAt?: string;
  bidDate?: string;
  documentUrl?: string;
  documentName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  submissionUrl?: string;
  tags?: string[];
  city?: string;
  state?: string;
  rawType: string;
}): DiscoveredPosting {
  const combined = `${input.title} ${input.summary}`.trim();
  const markup = input.rawMarkup ?? "";
  const sourceHostMatched = new URL(input.sourceUrl).hostname.toLowerCase() ===
    new URL(input.context.feedUrl).hostname.toLowerCase();
  const document = input.documentUrl
    ? { url: input.documentUrl, name: input.documentName }
    : documentFromMarkup(markup, input.context.feedUrl, input.sourceUrl, combined);
  return {
    sourceRecordId: input.sourceRecordId.slice(0, 500),
    title: textContent(input.title, 300),
    summary: textContent(input.summary, 5_000),
    sourceUrl: input.sourceUrl,
    publisher: input.context.publisher,
    ...(input.city ?? input.context.city ? { city: input.city ?? input.context.city } : {}),
    ...(input.state ?? input.context.state ? { state: input.state ?? input.context.state } : {}),
    ...(input.postedAt ? { postedAt: input.postedAt } : {}),
    ...(input.bidDate ?? deadlineFromText(combined)
      ? { bidDate: input.bidDate ?? deadlineFromText(combined) }
      : {}),
    ...(document.url ? { documentUrl: document.url } : {}),
    ...(document.name ? { documentName: document.name } : {}),
    ...(input.contactName ? { contactName: input.contactName } : {}),
    ...(input.contactEmail ?? emailFromText(combined)
      ? { contactEmail: input.contactEmail ?? emailFromText(combined) }
      : {}),
    ...(input.contactPhone ?? phoneFromText(combined)
      ? { contactPhone: input.contactPhone ?? phoneFromText(combined) }
      : {}),
    ...(input.submissionUrl ?? submissionFromMarkup(markup, input.context.feedUrl)
      ? { submissionUrl: input.submissionUrl ?? submissionFromMarkup(markup, input.context.feedUrl) }
      : {}),
    tradeTags: tradeTags([input.tags ?? []]),
    opportunityType: opportunityType(input.context),
    evidence: {
      parser: input.rawType,
      sourceHostMatched,
      bidLanguage: BID_LANGUAGE.test(combined) ? combined.slice(0, 1_000) : "",
      documentLanguage: DOCUMENT_LANGUAGE.test(combined) ? combined.slice(0, 1_000) : "",
      excerpt: combined.slice(0, 2_000),
    },
  };
}

function parseXml(body: string, context: ParseContext): DiscoveredPosting[] {
  const isAtom = /<feed\b/i.test(body);
  const blocks = [...body.matchAll(isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi)]
    .map((match) => match[0]);
  const results: DiscoveredPosting[] = [];
  for (const block of blocks.slice(0, MAX_POSTINGS_PER_SCAN)) {
    const title = xmlValue(block, ["title"]);
    const summary = xmlValue(block, ["description", "content:encoded", "summary", "content"]);
    const linkElement = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i.exec(block)?.[1];
    const linkText = xmlValue(block, ["link"]);
    const sourceUrl = absolutePublicUrl(linkElement ?? linkText, context.feedUrl);
    if (!sourceUrl || !title) continue;
    const guid = xmlValue(block, ["guid", "id"]) || sourceUrl;
    results.push(posting({
      context,
      sourceRecordId: guid,
      sourceUrl,
      title,
      summary: summary || title,
      rawMarkup: block,
      postedAt: publishedDate(xmlValue(block, ["pubDate", "published", "updated", "dc:date"])),
      tags: [...block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)].map((match) => textContent(match[1], 80)),
      rawType: isAtom ? "atom" : "rss",
    }));
  }
  return results;
}

function jsonString(record: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJson(body: string, context: ParseContext): DiscoveredPosting[] {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    return [];
  }
  const root = jsonObject(value);
  const items = Array.isArray(value)
    ? value
    : Array.isArray(root?.items)
      ? root.items
      : Array.isArray(root?.projects)
        ? root.projects
        : [];
  const results: DiscoveredPosting[] = [];
  for (const raw of items.slice(0, MAX_POSTINGS_PER_SCAN)) {
    const item = jsonObject(raw);
    if (!item) continue;
    const title = jsonString(item, ["title", "name"]);
    const sourceUrl = absolutePublicUrl(jsonString(item, ["url", "external_url", "source_url", "link"]), context.feedUrl);
    if (!title || !sourceUrl) continue;
    const summaryMarkup = jsonString(item, ["summary", "content_text", "content_html", "description", "scope"]) ?? title;
    const attachment = Array.isArray(item.attachments)
      ? item.attachments.map(jsonObject).find((entry) => entry && DOCUMENT_LANGUAGE.test(String(entry.title ?? entry.url ?? "")))
      : undefined;
    const location = jsonObject(item.location);
    const contact = jsonObject(item.contact);
    results.push(posting({
      context,
      sourceRecordId: jsonString(item, ["id", "guid", "solicitation_number", "project_number"]) ?? sourceUrl,
      sourceUrl,
      title,
      summary: summaryMarkup,
      rawMarkup: jsonString(item, ["content_html", "description"]) ?? "",
      postedAt: publishedDate(jsonString(item, ["date_published", "published_at", "posted_at"])),
      bidDate: normalizedDate(jsonString(item, ["bid_date", "bidDate", "deadline", "due_date", "date_due"])),
      documentUrl: absolutePublicUrl(
        jsonString(item, ["document_url", "plans_url", "specifications_url"]) ?? jsonString(attachment ?? {}, ["url"]),
        context.feedUrl,
      ),
      documentName: jsonString(item, ["document_name"]) ?? jsonString(attachment ?? {}, ["title"]),
      contactName: jsonString(item, ["contact_name"]) ?? jsonString(contact ?? {}, ["name"]),
      contactEmail: jsonString(item, ["contact_email"]) ?? jsonString(contact ?? {}, ["email"]),
      contactPhone: jsonString(item, ["contact_phone"]) ?? jsonString(contact ?? {}, ["phone"]),
      submissionUrl: absolutePublicUrl(jsonString(item, ["submission_url", "bid_portal_url"]), context.feedUrl),
      tags: tradeTags([item.tags, item.categories, item.trades]),
      city: jsonString(item, ["city"]) ?? jsonString(location ?? {}, ["city", "addressLocality"]),
      state: jsonString(item, ["state"]) ?? jsonString(location ?? {}, ["state", "addressRegion"]),
      rawType: "json-feed",
    }));
  }
  return results;
}

function jsonLdObjects(body: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const match of body.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      const values = Array.isArray(parsed)
        ? parsed
        : Array.isArray(jsonObject(parsed)?.["@graph"])
          ? jsonObject(parsed)!["@graph"] as unknown[]
          : [parsed];
      for (const value of values) {
        const record = jsonObject(value);
        if (record) results.push(record);
      }
    } catch {
      // Malformed structured data falls back to bounded HTML link discovery.
    }
  }
  return results;
}

function parseHtml(body: string, context: ParseContext): DiscoveredPosting[] {
  const results: DiscoveredPosting[] = [];
  for (const record of jsonLdObjects(body)) {
    const type = String(record["@type"] ?? "");
    if (!/(Event|Project|GovernmentService|Service|Offer)/i.test(type)) continue;
    const title = jsonString(record, ["name", "headline"]);
    const sourceUrl = absolutePublicUrl(jsonString(record, ["url", "sameAs"]), context.feedUrl);
    if (!title || !sourceUrl) continue;
    const location = jsonObject(record.location);
    const address = jsonObject(location?.address) ?? jsonObject(record.address);
    results.push(posting({
      context,
      sourceRecordId: jsonString(record, ["identifier", "@id"]) ?? sourceUrl,
      sourceUrl,
      title,
      summary: jsonString(record, ["description", "abstract"]) ?? title,
      postedAt: publishedDate(jsonString(record, ["datePosted", "datePublished"])),
      bidDate: normalizedDate(jsonString(record, ["endDate", "validThrough", "expires"])),
      city: jsonString(address ?? {}, ["addressLocality"]),
      state: jsonString(address ?? {}, ["addressRegion"]),
      rawType: "html-jsonld",
    }));
  }

  const seenUrls = new Set(results.map((result) => result.sourceUrl));
  const rows = [...body.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
  const blocks = rows.length > 0 ? rows : [body];
  for (const block of blocks) {
    const blockText = textContent(block, 5_000);
    if (!BID_LANGUAGE.test(blockText)) continue;
    for (const anchor of anchors(block, context.feedUrl)) {
      if (results.length >= MAX_POSTINGS_PER_SCAN) return results;
      if (seenUrls.has(anchor.href) || DOCUMENT_LANGUAGE.test(anchor.text)) continue;
      if (!POSTING_LINK_LANGUAGE.test(`${anchor.text} ${blockText}`)) continue;
      seenUrls.add(anchor.href);
      results.push(posting({
        context,
        sourceRecordId: anchor.href,
        sourceUrl: anchor.href,
        title: anchor.text,
        summary: blockText || anchor.text,
        rawMarkup: block,
        rawType: rows.length > 0 ? "html-table" : "html-links",
      }));
    }
  }
  return results;
}

function detectedFormat(body: string, contentType: string, configured: SourceMonitorFormat): SourceMonitorFormat {
  if (configured !== "auto") return configured;
  const trimmed = body.trimStart();
  if (/json/i.test(contentType) || trimmed.startsWith("{") || trimmed.startsWith("[")) return "json-feed";
  if (/rss/i.test(contentType) || /<rss\b|<channel\b/i.test(trimmed)) return "rss";
  if (/atom/i.test(contentType) || /<feed\b/i.test(trimmed)) return "atom";
  return "html";
}

export function parsePostedProjectFeed(
  body: string,
  contentType: string,
  context: ParseContext,
): DiscoveredPosting[] {
  const format = detectedFormat(body, contentType, context.feedFormat);
  const records = format === "json-feed"
    ? parseJson(body, context)
    : format === "rss" || format === "atom"
      ? parseXml(body, context)
      : parseHtml(body, context);
  const unique = new Map<string, DiscoveredPosting>();
  for (const record of records) {
    if (!record.title || !record.sourceUrl) continue;
    unique.set(record.sourceRecordId || record.sourceUrl, record);
  }
  return [...unique.values()].slice(0, MAX_POSTINGS_PER_SCAN);
}
