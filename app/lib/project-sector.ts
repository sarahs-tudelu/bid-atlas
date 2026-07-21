function normalizedSectorText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const RESIDENTIAL_TERMS = /\b(?:residential|single family|one family|two family|three family|1 family|2 family|3 family|1 or 2 family|1 2fam|1 3fam|dwelling|duplex|triplex|townhome|townhouse|apartment|apartments|condominium|condo|multi family|multifamily|adu|accessory dwelling)\b/;
const COMMERCIAL_TERMS = /\b(?:commercial|comm|retail|office|warehouse|hotel|motel|restaurant|industrial|mercantile|shopping center|storefront|business occupancy)\b/;
const MIXED_USE_TERM = /\bmixed use\b/;

/**
 * Compact values published by authoritative sector/occupancy columns. These
 * must not run against free-form scope, agency, contact, or document text:
 * "Multi" and "Mixed", for example, are too ambiguous outside that context.
 */
const RESIDENTIAL_SECTOR_FIELD_CODE =
  /^(?:multi|\d+(?: \d+)?fam|\d+(?:unit|more))$/;

export interface ProjectSectorInferenceOptions {
  sectorField?: boolean;
}

/**
 * Add conservative normalized search tags for official source categories that
 * describe a sector without literally spelling "residential" or "commercial".
 * These are search aids, not proof of ownership, privacy, or bid availability.
 */
export function inferredProjectSectorTags(
  value: string,
  options: ProjectSectorInferenceOptions = {},
): Array<"residential" | "commercial"> {
  const text = normalizedSectorText(value);
  const tags: Array<"residential" | "commercial"> = [];
  const mixedUse = MIXED_USE_TERM.test(text) || (options.sectorField && text === "mixed");
  const residentialSectorCode =
    options.sectorField && RESIDENTIAL_SECTOR_FIELD_CODE.test(text);
  if (RESIDENTIAL_TERMS.test(text) || residentialSectorCode || mixedUse) {
    tags.push("residential");
  }
  if (COMMERCIAL_TERMS.test(text) || mixedUse) tags.push("commercial");
  return tags;
}
