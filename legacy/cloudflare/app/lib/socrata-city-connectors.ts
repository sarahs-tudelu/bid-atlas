import type {
  ProjectParticipant,
  ProjectRecord,
  ProjectStage,
  SourceCursorRecord,
  SourcePageRecord,
  SourceRecord,
} from "./types";
import {
  addCalendarYears,
  calendarDateInTimeZone,
  NYC_CITY_RECORD_TIME_ZONE,
  sourceLocalDateTimeToIso,
} from "./deadline-time.ts";

const REQUEST_TIMEOUT_MS = 8_000;
const INGEST_PAGE_SIZE = 50;
const VIEW_PAGE_SIZE = 40;
const NYC_CITY_RECORD_CURRENT_MAX = 500;
const NYC_CITY_RECORD_ADMINISTRATIVE_YEAR = 2090;
const NYC_CITY_RECORD_LONG_DEADLINE_YEARS = 5;
// Construction work is not reliably classified under a Construction category
// in CROL. Architecture, engineering, renovation, and building-product notices
// are also published as Services, Goods, or Goods and Services. Keep the
// official Procurement section as the source universe so those records are not
// silently dropped; product/scope filters are applied by BidAtlas search.
const NYC_CITY_RECORD_PROCUREMENT_BASE_WHERE = "section_name = 'Procurement'";
const NYC_DOB_PLAN_RECORD_REQUEST_URL =
  "https://www.nyc.gov/assets/buildings/pdf/records_request_user_guide.pdf";
const NJ_MUNICIPAL_CONSTRUCTION_CONTACTS_URL =
  "https://www.nj.gov/dca/codes/publications/pdf_ora/muniroster.pdf";
const NYC_DOB_ROW_ID = /^row-[a-z0-9._~-]{4,80}$/i;
const NYC_DOB_TERMINAL_STATUSES = [
  "LOC Issued",
  "CO Issued",
  "TA Certificate of Operation Issued",
  "PA Certificate of Operation Issued",
  "Full Demolition Signed-off",
  "Inspection Complete",
  "Filing Withdrawn",
  "Revoked",
  "LL 158-2017-Denied",
] as const;
const NYC_DOB_GOVERNMENT_OWNER_TYPES = [
  "NYCHA/HHC Owned and Operated",
  "School Construction Authority",
  "NYC Agency",
  "Other Government Owned and Operated",
  "HPD",
] as const;
const NYC_DOB_ACTIVE_PRIVATE_WHERE = [
  `filing_status not in (${NYC_DOB_TERMINAL_STATUSES.map((status) => `'${status}'`).join(",")})`,
  "job_type <> 'No Work'",
  `(owner_type is null OR owner_type not in (${NYC_DOB_GOVERNMENT_OWNER_TYPES.map((type) => `'${type}'`).join(",")}))`,
].join(" AND ");

export const SOCRATA_CITY_SOURCE_IDS = [
  "nyc-dob-now-job-filings",
  "nyc-dob-now-approved-permits",
  "new-jersey-construction-permits",
  "nyc-city-record-construction-procurement",
  "los-angeles-building-permits-submitted",
  "chicago-building-permits",
  "austin-issued-construction-permits",
  "san-francisco-building-permits",
] as const;

export type SocrataCitySourceId = (typeof SOCRATA_CITY_SOURCE_IDS)[number];
export type SocrataCityFeedMode = "view" | "ingest";
export type SocrataCityIngestionLane = "backfill" | "refresh";
export type SocrataCitySourceTemplate = Omit<
  SourceRecord,
  "status" | "recordCount" | "lastChecked"
>;

export interface SocrataCityFeedOptions {
  mode?: SocrataCityFeedMode;
  lane?: SocrataCityIngestionLane;
  sourceCursors?: Record<string, SourceCursorRecord>;
  sourceId?: string;
}

export interface SocrataCityConnectorResult {
  projects: ProjectRecord[];
  source: SourceRecord;
  page: SourcePageRecord;
}

export interface NycCityRecordCurrentSolicitationUniverse {
  sourceId: "nyc-city-record-construction-procurement";
  projects: ProjectRecord[];
  sourceReportedMatches: number;
  resultLimitReached: boolean;
  returnedProjects: number;
  sourceTimeZone: typeof NYC_CITY_RECORD_TIME_ZONE;
  asOfSourceDayStart: string;
}

export const SOCRATA_CITY_SOURCE_TEMPLATES: Record<
  SocrataCitySourceId,
  SocrataCitySourceTemplate
> = {
  "nyc-dob-now-job-filings": {
    id: "nyc-dob-now-job-filings",
    name: "NYC DOB NOW job application filings",
    owner: "New York City Department of Buildings",
    level: "local",
    sourceClass: "permits",
    stages: [
      "design",
      "permitting",
      "construction",
      "completed",
      "cancelled",
      "unclassified",
    ],
    access: "open",
    cadence: "Daily",
    recordCountUnit: "rows",
    url: "https://data.cityofnewyork.us/d/w9ak-ipjd",
    jurisdiction: "New York City, New York",
    note:
      "Official DOB NOW job-application rows; the source count is filing rows, not a count of unique buildings or projects. The live dashboard view is limited to non-terminal private residential and commercial construction filings, which can include old unresolved rows and therefore is not itself a freshness claim; ingestion retains lifecycle history so later completion or withdrawal is not hidden. Plans are not in Open Data and require the official DOB records-request process. This source excludes separately published electrical, elevator, and LAA job families.",
  },
  "nyc-dob-now-approved-permits": {
    id: "nyc-dob-now-approved-permits",
    name: "NYC DOB NOW approved construction permits",
    owner: "New York City Department of Buildings",
    level: "local",
    sourceClass: "permits",
    stages: ["construction", "completed", "cancelled", "unclassified"],
    access: "open",
    cadence: "Daily",
    recordCountUnit: "rows",
    url: "https://data.cityofnewyork.us/d/rbx6-tga4",
    jurisdiction: "New York City, New York",
    note:
      "Official DOB NOW approved-permit rows. BidAtlas exposes only organization-valued owners and contractors; person-only owner and applicant names are suppressed. A contractor role requires a published GC permittee license type. Electrical, elevator, and limited-alteration permits are published by NYC in separate datasets.",
  },
  "new-jersey-construction-permits": {
    id: "new-jersey-construction-permits",
    name: "New Jersey construction permit activity",
    owner: "New Jersey Department of Community Affairs",
    level: "state",
    sourceClass: "permits",
    stages: ["permitting", "completed", "unclassified"],
    access: "open",
    cadence: "Monthly",
    recordCountUnit: "rows",
    url: "https://data.nj.gov/d/w9se-dmra",
    jurisdiction: "New Jersey",
    note:
      "Official municipality-reported permit and certificate activity retained for 60 months. The statewide dataset intentionally omits property addresses, work descriptions, owner names, and contractor names. BidAtlas therefore uses it for project discovery and links to the issuing municipality for the underlying permit record instead of inferring private parties.",
  },
  "nyc-city-record-construction-procurement": {
    id: "nyc-city-record-construction-procurement",
    name: "NYC City Record procurement notices",
    owner: "New York City Department of Citywide Administrative Services",
    level: "local",
    sourceClass: "procurement",
    stages: ["planning", "bidding", "bid-opened", "awarded", "unclassified"],
    access: "open",
    cadence: "Daily",
    url: "https://data.cityofnewyork.us/d/dg92-zbpx",
    jurisdiction: "New York City, New York",
    note:
      "City Record Online Procurement-section notices. The universe intentionally includes Services, Goods, and Goods and Services because NYC publishes some architecture, engineering, renovation, and building-product opportunities outside the Construction categories. Search filters narrow the scope; official lifecycle labels are retained.",
  },
  "los-angeles-building-permits-submitted": {
    id: "los-angeles-building-permits-submitted",
    name: "Los Angeles building permits submitted",
    owner: "Los Angeles Department of Building and Safety",
    level: "local",
    sourceClass: "permits",
    stages: ["design", "permitting", "construction", "completed", "cancelled", "unclassified"],
    access: "open",
    cadence: "Daily",
    url: "https://data.lacity.org/d/gwh9-jnip",
    jurisdiction: "Los Angeles, California",
    note:
      "Official LADBS building-permit applications submitted from 2020 forward, including 1- or 2-family dwellings, apartments, commercial buildings, plan-check status, use, valuation, and scope. The open-data row does not itself establish that submitted plan sheets are publicly downloadable.",
  },
  "chicago-building-permits": {
    id: "chicago-building-permits",
    name: "Chicago building permits",
    owner: "City of Chicago",
    level: "local",
    sourceClass: "permits",
    stages: ["permitting", "completed", "cancelled", "unclassified"],
    access: "open",
    cadence: "Daily",
    url: "https://data.cityofchicago.org/d/ydr8-5enu",
    jurisdiction: "Chicago, Illinois",
    note:
      "Full-history issued building permits from 2006 onward, including active, suspended, completed, cancelled, and revoked lifecycle states.",
  },
  "austin-issued-construction-permits": {
    id: "austin-issued-construction-permits",
    name: "Austin issued construction permits",
    owner: "City of Austin Development Services Department",
    level: "local",
    sourceClass: "permits",
    stages: ["design", "permitting", "completed", "cancelled", "unclassified"],
    access: "open",
    cadence: "Daily",
    url: "https://data.austintexas.gov/d/3syk-w9eu",
    jurisdiction: "Austin, Texas",
    note:
      "Full-history building, electrical, mechanical, plumbing, driveway, and sidewalk permits, with all published lifecycle states retained.",
  },
  "san-francisco-building-permits": {
    id: "san-francisco-building-permits",
    name: "San Francisco building permits",
    owner: "San Francisco Department of Building Inspection",
    level: "local",
    sourceClass: "permits",
    stages: ["design", "permitting", "completed", "cancelled", "unclassified"],
    access: "open",
    cadence: "Nightly",
    url: "https://data.sfgov.org/d/i98e-djp9",
    jurisdiction: "San Francisco, California",
    note:
      "Full-history permit applications at one official primary-address row per permit. Secondary address rows remain available in the source dataset.",
  },
};

type SocrataRow = Record<string, unknown>;

type SocrataCityDefinition = {
  domain: string;
  datasetId: string;
  uniqueKey: string;
  uniqueKeyOrder?: "opaque-source-order";
  refreshSortKey: string;
  refreshSortExpression?: string;
  baseWhere?: string;
  viewWhere?: string;
  select: readonly string[];
  map: (row: SocrataRow) => ProjectRecord;
};

function textValue(row: SocrataRow, field: string): string | undefined {
  const value = row[field];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function decodeHtmlEntity(entity: string): string {
  const normalized = entity.toLowerCase();
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  if (named[normalized]) return named[normalized];
  const codePoint = normalized.startsWith("#x")
    ? Number.parseInt(normalized.slice(2), 16)
    : normalized.startsWith("#")
      ? Number.parseInt(normalized.slice(1), 10)
      : Number.NaN;
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return `&${entity};`;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return `&${entity};`;
  }
}

function safePlainText(value: string | undefined, maxLength = 4_000): string | undefined {
  if (!value) return undefined;
  const text = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>|<\/p\s*>|<\/li\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity: string) => decodeHtmlEntity(entity))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return text || undefined;
}

function publicContactEmail(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  return email && email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
    ? email
    : undefined;
}

function publicContactPhone(value: string | undefined): string | undefined {
  const phone = value?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!phone || phone.length > 80) return undefined;
  const digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (digits.length !== 10 || digits.startsWith("000") || digits.slice(3, 6) === "000") {
    return undefined;
  }
  return phone;
}

function linkValue(row: SocrataRow, field: string): string | undefined {
  const value = row[field];
  if (typeof value === "string") return value || undefined;
  if (value && typeof value === "object" && "url" in value) {
    const url = (value as { url?: unknown }).url;
    return typeof url === "string" && url ? url : undefined;
  }
  return undefined;
}

function trustedHttpsUrl(
  value: string | undefined,
  allowedHost: (hostname: string) => boolean,
): string | undefined {
  if (!value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || !allowedHost(hostname)) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Socrata commonly returns floating ISO timestamps. Parsing those in the
  // host timezone makes a row change between a workstation and the UTC worker.
  // Preserve a supplied zone; otherwise normalize explicitly to UTC.
  const normalized = /(?:z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value
    : /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T00:00:00.000Z`
      : `${value}Z`;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function moneyValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compact(values: Array<string | undefined>, separator = " · "): string {
  return values.filter((value): value is string => Boolean(value)).join(separator);
}

function uniqueParticipants(
  values: Array<ProjectParticipant | undefined>,
): ProjectParticipant[] {
  const seen = new Set<string>();
  return values.filter((value): value is ProjectParticipant => {
    if (!value?.name) return false;
    const key = `${value.role}:${value.name.trim().toLocaleLowerCase("en-US")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const ORGANIZATION_NAME_MARKER =
  /\b(?:llc|l\.l\.c\.?|incorporated|inc\.?|corp(?:oration)?\.?|company|co\.?|lp|llp|pllc|pc|p\.c\.|architects|architecture|engineers|engineering|construction|contracting|contractors?|builders?|building|consulting|enterprises?|management|realty|department|agency|authority|university|college|school|district|county|city\s+of|state\s+of|group|studio|associates?|services|design|development|properties|partners|holdings)\b/i;

function looksLikeOrganizationName(value: string): boolean {
  return ORGANIZATION_NAME_MARKER.test(value);
}

function normalizedLifecycleStatus(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function permittingStage(
  sourceId: SocrataCitySourceId,
  primaryStatus: string | undefined,
  secondaryStatus?: string,
): ProjectStage {
  const status = normalizedLifecycleStatus(primaryStatus);
  const secondary = normalizedLifecycleStatus(secondaryStatus);

  if (sourceId === "nyc-dob-now-job-filings") {
    if (status === "filing withdrawn" || status === "revoked" || /\bdenied$/.test(status)) {
      return "cancelled";
    }
    if (
      status === "loc issued" ||
      status === "co issued" ||
      status.endsWith("certificate of operation issued") ||
      status === "full demolition signed off" ||
      status === "inspection complete"
    ) {
      return "completed";
    }
    if (/objection|review|pending|\bqa\b|incomplete|on\s*hold|onhold|appeal|intent to revoke|awaiting/i.test(status)) {
      return "design";
    }
    if (status === "permit issued" || status.startsWith("permit entire")) {
      return "construction";
    }
    if (/approved|permit|issued/.test(status)) return "permitting";
    return "unclassified";
  }

  if (sourceId === "nyc-dob-now-approved-permits") {
    if (/withdrawn|revoked|expired|cancelled|canceled/.test(status)) return "cancelled";
    if (/signed off|complete|completed/.test(status)) return "completed";
    if (/permit issued|issued|approved/.test(status)) return "construction";
    return "unclassified";
  }

  if (sourceId === "new-jersey-construction-permits") {
    if (/certificate|complete|completed/.test(status)) return "completed";
    if (/permit|issued|active/.test(status)) return "permitting";
    return "unclassified";
  }

  if (sourceId === "chicago-building-permits") {
    if (secondary === "cancelled" || secondary === "denied") return "cancelled";
    if (status === "complete") return "completed";
    if (["expired", "suspended", "cancelled", "revoked"].includes(status)) {
      return "cancelled";
    }
    if (status === "active" || status === "phased permitting") return "permitting";
    return "unclassified";
  }

  if (sourceId === "los-angeles-building-permits-submitted") {
    if (/permit expired|revoked|withdrawn|cancelled|canceled/.test(status)) {
      return "cancelled";
    }
    if (/permit finaled|cofo issued|cofc issued|permit closed/.test(status)) {
      return "completed";
    }
    if (/^issued$|permit extended|re activate permit|cofo in progress|tco issued/.test(status)) {
      return "construction";
    }
    if (/pc approved|ready to issue|ok for cofc|ok to issue cofc|hold released/.test(status)) {
      return "permitting";
    }
    if (
      /submitted|quality review|verification|correction|pc info|pc assigned|pc in progress|reviewed by supervisor|plans on hold|not ready to issue|re submittal|required|no progress|intent to revoke/.test(
        status,
      )
    ) {
      return "design";
    }
    return "unclassified";
  }

  if (sourceId === "austin-issued-construction-permits") {
    if (status === "final" || status === "closed") return "completed";
    if (
      /^(expired|void|withdrawn|cancelled|aborted|inactive|denied but closed|suspended|revoked|rejected)/.test(
        status,
      )
    ) {
      return "cancelled";
    }
    if (/pending|on hold|re review|new permit required|incomplete|awaiting upload/.test(status)) {
      return "design";
    }
    if (status === "active") return "permitting";
    return "unclassified";
  }

  if (status === "complete") return "completed";
  if (["expired", "cancelled", "withdrawn", "suspend", "disapproved", "revoked", "denied"].includes(status)) {
    return "cancelled";
  }
  if (["filed", "filing", "triage", "plancheck", "appeal", "incomplete"].includes(status)) {
    return "design";
  }
  if (["issued", "reinstated", "approved", "issuing", "inspection", "upheld", "granted", "overruled"].includes(status)) {
    return "permitting";
  }
  return "unclassified";
}

function officialRowUrl(
  domain: string,
  datasetId: string,
  field: string,
  value: string,
): string {
  const params = new URLSearchParams({
    "$where": `${field} = '${escapeSocrataLiteral(value)}'`,
    "$limit": "1",
  });
  return `https://${domain}/resource/${datasetId}.json?${params}`;
}

function chicagoContactParticipants(row: SocrataRow): ProjectParticipant[] {
  const result: Array<ProjectParticipant | undefined> = [];
  for (let index = 1; index <= 15; index += 1) {
    const name = textValue(row, `contact_${index}_name`);
    const type = textValue(row, `contact_${index}_type`) ?? "";
    let role: ProjectParticipant["role"] | undefined;
    if (/owner/i.test(type)) role = "owner";
    else if (/architect/i.test(type)) role = "architect";
    else if (/engineer/i.test(type)) role = "engineer";
    else if (/contractor/i.test(type)) role = "contractor";
    // Contact names can be private people at residential addresses. Only
    // expose a role when the source label is explicit and the value itself is
    // recognizably an organization; the official row remains linked for review.
    if (name && role && looksLikeOrganizationName(name)) result.push({ name, role });
  }
  result.push({ name: "City of Chicago", role: "agency" });
  return uniqueParticipants(result);
}

function nycDobBusinessName(row: SocrataRow, field: string): string | undefined {
  const value = safePlainText(textValue(row, field), 240);
  if (!value || /^(?:n\/?a|none|not applicable|private|pr)$/i.test(value)) {
    return undefined;
  }
  return value;
}

function nycDobOrganizationName(row: SocrataRow, field: string): string | undefined {
  const value = nycDobBusinessName(row, field);
  return value && looksLikeOrganizationName(value) ? value : undefined;
}

function nycDobApplicantRole(
  professionalTitle: string | undefined,
): ProjectParticipant["role"] | undefined {
  const title = normalizedLifecycleStatus(professionalTitle);
  if (title === "ra" || title === "la" || /architect/.test(title)) return "architect";
  if (title === "pe" || /engineer/.test(title)) return "engineer";
  if (title === "gc" || /contractor/.test(title)) return "contractor";
  return undefined;
}

function nycDobParticipants(row: SocrataRow, sourceUrl: string): ProjectParticipant[] {
  const ownerBusiness = nycDobOrganizationName(row, "owner_s_business_name");
  const applicantBusiness = nycDobOrganizationName(row, "applicant_business_name");
  const applicantRole = nycDobApplicantRole(textValue(row, "applicant_professional_title"));
  return uniqueParticipants([
    {
      name: "New York City Department of Buildings",
      role: "agency",
      participantType: "organization",
      organization: "New York City Department of Buildings",
      sourceUrl,
    },
    ownerBusiness
      ? {
          name: ownerBusiness!,
          role: "owner",
          participantType: "organization",
          organization: ownerBusiness!,
          sourceUrl,
        }
      : undefined,
    applicantBusiness && applicantRole
      ? {
          name: applicantBusiness,
          role: applicantRole,
          participantType: "organization",
          organization: applicantBusiness,
          sourceUrl,
        }
      : undefined,
  ]);
}

function mapNyc(row: SocrataRow): ProjectRecord {
  const sourceId = "nyc-dob-now-job-filings" as const;
  const rowId = requiredIdentity(row, ":id", sourceId);
  const filingNumber = textValue(row, "job_filing_number") ?? rowId;
  const jobNumber = filingNumber.split("-", 1)[0];
  const status = textValue(row, "filing_status") ?? "Status not published";
  const description = textValue(row, "job_description");
  const jobType = textValue(row, "job_type");
  const buildingType = textValue(row, "building_type");
  const ownerType = textValue(row, "owner_type");
  const firstPermitDate = isoDate(textValue(row, "first_permit_date"));
  const address = compact(
    [textValue(row, "house_no"), textValue(row, "street_name")],
    " ",
  );
  const applicantBusiness = nycDobOrganizationName(row, "applicant_business_name");
  const filingRepresentativeBusiness = nycDobOrganizationName(
    row,
    "filing_representative_business_name",
  );
  const ownerBusiness = nycDobOrganizationName(row, "owner_s_business_name");
  const sourceUrl = officialRowUrl(
    "data.cityofnewyork.us",
    "w9ak-ipjd",
    ":id",
    rowId,
  );
  const workTypes = [
    "general_construction_work_type_",
    "mechanical_systems_work_type_",
    "structural_work_type_",
    "foundation_work_type_",
    "earth_work_work_type_",
    "plumbing_work_type",
    "sprinkler_work_type",
    "standpipe",
    "solar_work_type_",
    "green_roof_work_type_",
  ].map((field) => textValue(row, field));
  return {
    id: `${sourceId}:${rowId}`,
    sourceId,
    sourceRecordId: rowId,
    title: description ?? `NYC DOB filing ${filingNumber}`,
    summary: compact([
      filingNumber,
      jobType,
      buildingType,
      address || undefined,
      status,
      firstPermitDate ? `First permit ${firstPermitDate.slice(0, 10)}` : undefined,
    ]),
    stage: permittingStage(sourceId, status),
    status,
    agency: "New York City Department of Buildings",
    address: address || undefined,
    city: "New York",
    state: "NY",
    postalCode: textValue(row, "postcode"),
    value: moneyValue(textValue(row, "initial_cost")),
    postedAt: isoDate(textValue(row, "filing_date")),
    updatedAt:
      isoDate(
        textValue(row, "current_status_date") ??
          textValue(row, "approved_date") ??
          textValue(row, "filing_date"),
      ) ?? new Date(0).toISOString(),
    sourceName: SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].name,
    sourceUrl,
    provenance: "live-api",
    confidence: "official",
    documents: [
      {
        name: "Official DOB NOW filing record",
        kind: "source-record",
        url: sourceUrl,
        access: "public",
        indexStatus: "metadata-only",
      },
      {
        name: `Plan access for DOB NOW job ${jobNumber} — official records-request guide`,
        kind: "source-record",
        url: NYC_DOB_PLAN_RECORD_REQUEST_URL,
        // The guide itself is public. It explains that actual plan sets are
        // absent from Open Data and must be requested through DOB NOW with an
        // eFiling account; never present the guide as the project's drawings.
        access: "public",
        indexStatus: "metadata-only",
      },
    ],
    participants: nycDobParticipants(row, sourceUrl),
    searchableFields: [
      jobNumber,
      filingNumber,
      description,
      status,
      jobType,
      buildingType,
      ownerType,
      textValue(row, "work_on_floor"),
      address || undefined,
      textValue(row, "borough"),
      applicantBusiness,
      textValue(row, "applicant_professional_title"),
      textValue(row, "applicant_license"),
      filingRepresentativeBusiness,
      ownerBusiness,
      textValue(row, "total_construction_floor_area"),
      textValue(row, "existing_dwelling_units"),
      textValue(row, "proposed_dwelling_units"),
      firstPermitDate,
      ...workTypes,
    ].filter((value): value is string => Boolean(value)),
    documentTextIndexed: false,
  };
}

function mapNycApprovedPermit(row: SocrataRow): ProjectRecord {
  const sourceId = "nyc-dob-now-approved-permits" as const;
  const rowId = requiredIdentity(row, ":id", sourceId);
  const filingNumber = textValue(row, "job_filing_number") ?? "Filing number not published";
  const workPermit = textValue(row, "work_permit") ?? filingNumber;
  const status = textValue(row, "permit_status") ?? "Approved permit";
  const description = safePlainText(textValue(row, "job_description"));
  const sourceUrl = officialRowUrl(
    "data.cityofnewyork.us",
    "rbx6-tga4",
    ":id",
    rowId,
  );
  const address = compact(
    [textValue(row, "house_no"), textValue(row, "street_name")],
    " ",
  );
  const ownerBusiness = nycDobOrganizationName(row, "owner_business_name");
  const applicantBusiness = nycDobOrganizationName(row, "applicant_business_name");
  const licenseType = textValue(row, "permittee_s_license_type");
  const licenseNumber = textValue(row, "applicant_license");
  const isGeneralContractor = normalizedLifecycleStatus(licenseType) === "gc";
  return {
    id: `${sourceId}:${rowId}`,
    sourceId,
    sourceRecordId: rowId,
    title: description ?? `NYC approved permit ${workPermit}`,
    summary: compact([
      filingNumber,
      workPermit,
      textValue(row, "work_type"),
      address || undefined,
      status,
      isGeneralContractor && licenseNumber ? `GC license ${licenseNumber}` : undefined,
    ]),
    stage: permittingStage(sourceId, status),
    status,
    agency: "New York City Department of Buildings",
    address: address || undefined,
    city: "New York",
    state: "NY",
    postalCode: textValue(row, "zip_code"),
    value: moneyValue(textValue(row, "estimated_job_costs")),
    postedAt: isoDate(textValue(row, "issued_date") ?? textValue(row, "approved_date")),
    updatedAt:
      isoDate(
        textValue(row, "issued_date") ??
          textValue(row, "approved_date"),
      ) ?? new Date(0).toISOString(),
    sourceName: SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].name,
    sourceUrl,
    provenance: "live-api",
    confidence: "official",
    documents: [
      {
        name: "Official DOB NOW approved-permit record",
        kind: "permit",
        url: sourceUrl,
        access: "public",
        indexStatus: "metadata-only",
      },
    ],
    participants: uniqueParticipants([
      {
        name: "New York City Department of Buildings",
        role: "agency",
        participantType: "organization",
        organization: "New York City Department of Buildings",
        sourceUrl,
      },
      ownerBusiness
        ? {
            name: ownerBusiness,
            role: "owner",
            participantType: "organization",
            organization: ownerBusiness,
            sourceUrl,
          }
        : undefined,
      applicantBusiness && isGeneralContractor
        ? {
            name: applicantBusiness,
            role: "contractor",
            participantType: "organization",
            organization: applicantBusiness,
            sourceUrl,
          }
        : undefined,
    ]),
    searchableFields: [
      filingNumber,
      workPermit,
      description,
      status,
      address || undefined,
      textValue(row, "borough"),
      textValue(row, "work_type"),
      ownerBusiness,
      applicantBusiness,
      licenseType,
      licenseNumber,
      textValue(row, "filing_reason"),
    ].filter((value): value is string => Boolean(value)),
    documentTextIndexed: false,
  };
}

function mapNewJerseyPermit(row: SocrataRow): ProjectRecord {
  const sourceId = "new-jersey-construction-permits" as const;
  const rowId = requiredIdentity(row, "pk", sourceId);
  const permitNumber = textValue(row, "permitno") ?? textValue(row, "recordid") ?? rowId;
  const municipality = safePlainText(textValue(row, "muniname"), 160) ?? "New Jersey municipality";
  const permitType = safePlainText(textValue(row, "permittypedesc"), 200) ?? "Construction permit";
  const status = textValue(row, "permitstatusdesc") ?? textValue(row, "status") ?? "Permit";
  const sourceUrl = officialRowUrl(
    "data.nj.gov",
    "w9se-dmra",
    "pk",
    rowId,
  );
  return {
    id: `${sourceId}:${rowId}`,
    sourceId,
    sourceRecordId: rowId,
    title: `${municipality} ${permitType.toLowerCase()} permit ${permitNumber}`,
    summary: compact([
      permitNumber,
      permitType,
      textValue(row, "usegroupdesc"),
      textValue(row, "squarefeet") ? `${textValue(row, "squarefeet")} sq ft` : undefined,
      "Owner, contractor, address, and work description require the municipal permit record",
    ]),
    stage: permittingStage(sourceId, status),
    status,
    agency: `${municipality} construction office`,
    city: municipality,
    county: textValue(row, "county"),
    state: "NJ",
    value: moneyValue(textValue(row, "constcost")),
    postedAt: isoDate(textValue(row, "permitdate")),
    updatedAt:
      isoDate(
        textValue(row, "processdate") ??
          textValue(row, "certdate") ??
          textValue(row, "permitdate"),
      ) ?? new Date(0).toISOString(),
    sourceName: SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].name,
    sourceUrl,
    provenance: "live-api",
    confidence: "official",
    documents: [
      {
        name: "Official New Jersey permit activity row",
        kind: "permit",
        url: sourceUrl,
        access: "public",
        indexStatus: "metadata-only",
      },
      {
        name: "Issuing municipal construction office directory",
        kind: "source-record",
        url: NJ_MUNICIPAL_CONSTRUCTION_CONTACTS_URL,
        access: "public",
        indexStatus: "metadata-only",
      },
    ],
    participants: [
      {
        name: `${municipality} construction office`,
        role: "agency",
        participantType: "organization",
        organization: `${municipality} construction office`,
        sourceUrl: NJ_MUNICIPAL_CONSTRUCTION_CONTACTS_URL,
      },
    ],
    searchableFields: [
      permitNumber,
      textValue(row, "recordid"),
      textValue(row, "block"),
      textValue(row, "lot"),
      municipality,
      textValue(row, "county"),
      permitType,
      textValue(row, "usegroup"),
      textValue(row, "usegroupdesc"),
      textValue(row, "censusdesc"),
      textValue(row, "public"),
    ].filter((value): value is string => Boolean(value)),
    documentTextIndexed: false,
  };
}

function cityRecordStage(noticeType: string | undefined): ProjectStage {
  const normalized = normalizedLifecycleStatus(noticeType);
  if (normalized === "award" || normalized === "contract award") return "awarded";
  if (/intent to award|notice of award|recommended award/.test(normalized)) return "bid-opened";
  if (/solicitation|bid extension|request for/.test(normalized)) return "bidding";
  if (/vendor list|pre qualified|forecast/.test(normalized)) return "planning";
  return "unclassified";
}

function cityRecordAttachments(row: SocrataRow): ProjectRecord["documents"] {
  const raw = linkValue(row, "document_links");
  if (!raw) return [];
  const unique = new Set<string>();
  for (const candidate of raw
    .replace(/&amp;/gi, "&")
    .split(/\s*,\s*(?=https:\/\/)/i)) {
    const url = trustedHttpsUrl(
      candidate.trim(),
      (hostname) => hostname === "a856-cityrecord.nyc.gov",
    );
    if (!url || new URL(url).pathname.toLowerCase() !== "/search/getfile") continue;
    unique.add(url);
    if (unique.size >= 20) break;
  }
  return [...unique].map((url, index) => ({
    name: `City Record attachment ${index + 1}`,
    // The dataset publishes attachment links but does not classify their
    // contents as plans, drawings, or specifications. Keep them truthful.
    kind: "source-record" as const,
    url,
    access: "free-account" as const,
    indexStatus: "account-gated" as const,
  }));
}

function cityRecordBidDeadline(
  row: SocrataRow,
  referenceTime: Date,
): { bidDate?: string; administrative: boolean; sourceValue?: string } {
  const sourceValue = textValue(row, "due_date");
  const bidDate = sourceLocalDateTimeToIso(sourceValue, NYC_CITY_RECORD_TIME_ZONE);
  if (!bidDate || !sourceValue) return { administrative: false };
  const dueYear = Number(sourceValue.slice(0, 4));
  const postedAt = sourceLocalDateTimeToIso(
    textValue(row, "start_date"),
    NYC_CITY_RECORD_TIME_ZONE,
  );
  const sourceDay = calendarDateInTimeZone(referenceTime, NYC_CITY_RECORD_TIME_ZONE);
  const longDeadlineDay = addCalendarYears(
    sourceDay,
    NYC_CITY_RECORD_LONG_DEADLINE_YEARS,
  );
  const longDeadline = sourceLocalDateTimeToIso(
    `${longDeadlineDay}T00:00:00.000`,
    NYC_CITY_RECORD_TIME_ZONE,
  );
  const oldNoticeBoundary = new Date(referenceTime);
  oldNoticeBoundary.setUTCFullYear(
    oldNoticeBoundary.getUTCFullYear() - NYC_CITY_RECORD_LONG_DEADLINE_YEARS,
  );
  const administrative =
    dueYear >= NYC_CITY_RECORD_ADMINISTRATIVE_YEAR ||
    Boolean(
      postedAt &&
      longDeadline &&
      bidDate >= longDeadline &&
      postedAt < oldNoticeBoundary.toISOString(),
    );
  return administrative
    ? { administrative: true, sourceValue }
    : { bidDate, administrative: false, sourceValue };
}

function mapNycCityRecordAt(
  row: SocrataRow,
  referenceTime: Date,
): ProjectRecord {
  const sourceId = "nyc-city-record-construction-procurement" as const;
  const requestId = requiredIdentity(row, "request_id", sourceId);
  const noticeType = safePlainText(textValue(row, "type_of_notice_description"), 120) ??
    "Notice type not published";
  const agency = safePlainText(textValue(row, "agency_name"), 240) ?? "City of New York";
  const category = safePlainText(textValue(row, "category_description"), 180);
  const title = safePlainText(textValue(row, "short_title"), 500) ??
    `NYC City Record procurement ${requestId}`;
  const descriptionParts = [
    "additional_description_1",
    // The display label is misspelled in the catalog, but the API field is not.
    "additional_description_2",
    "additional_description_3",
    "other_info_1",
    "other_info_2",
    "other_info_3",
  ].flatMap((field) => {
    const text = safePlainText(textValue(row, field));
    return text ? [text] : [];
  });
  const description = descriptionParts.join(" ").slice(0, 12_000) || undefined;
  const sourceUrl = `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(requestId)}`;
  const pin = safePlainText(textValue(row, "pin"), 100);
  const email = publicContactEmail(textValue(row, "email"));
  const phone = publicContactPhone(textValue(row, "contact_phone"));
  const contactName = safePlainText(textValue(row, "contact_name"), 180);
  const vendor = safePlainText(textValue(row, "vendor_name"), 240);
  const postedAt = sourceLocalDateTimeToIso(
    textValue(row, "start_date"),
    NYC_CITY_RECORD_TIME_ZONE,
  );
  const deadline = cityRecordBidDeadline(row, referenceTime);
  const bidDate = deadline.bidDate;
  const updatedAt = sourceLocalDateTimeToIso(
    textValue(row, "start_date") ?? textValue(row, "end_date"),
    NYC_CITY_RECORD_TIME_ZONE,
  );
  const isAward = ["award", "contract award"].includes(
    normalizedLifecycleStatus(noticeType),
  );
  const documents: ProjectRecord["documents"] = [
    {
      name: "Official NYC City Record notice",
      kind: isAward ? "award" : "source-record",
      url: sourceUrl,
      access: "public",
      indexStatus: "metadata-only",
    },
    ...(description && /\bpassport\b/i.test(description)
      ? [{
          name: `PASSPort solicitation documents${pin ? ` — search ${pin}` : ""}`,
          kind: "source-record" as const,
          url: "https://passport.cityofnewyork.us/page.aspx/en/rfp/request_browse_public",
          access: "free-account" as const,
          indexStatus: "account-gated" as const,
        }]
      : []),
    ...(description && /\bisupplier\b/i.test(description)
      ? [{
          name: "NYCHA iSupplier registration and bid-submission route",
          kind: "source-record" as const,
          url: "https://www.nyc.gov/site/nycha/business/isupplier-vendor-registration.page",
          access: "free-account" as const,
          indexStatus: "account-gated" as const,
        }]
      : []),
    ...cityRecordAttachments(row),
  ];
  return {
    id: `${sourceId}:${requestId}`,
    sourceId,
    sourceRecordId: requestId,
    title,
    summary: compact([
      pin ? `PIN ${pin}` : undefined,
      noticeType,
      category,
      safePlainText(textValue(row, "selection_method_description"), 180),
      deadline.administrative
        ? "Open-ended or administrative source deadline; verify the active response window."
        : undefined,
      description?.slice(0, 800),
    ]),
    stage: cityRecordStage(noticeType),
    status: noticeType,
    agency,
    city: "New York",
    state: "NY",
    value: moneyValue(textValue(row, "contract_amount")),
    postedAt,
    bidDate,
    ...(bidDate ? { bidDateTimeZone: NYC_CITY_RECORD_TIME_ZONE } : {}),
    updatedAt: updatedAt ?? new Date(0).toISOString(),
    sourceName: SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].name,
    sourceUrl,
    provenance: "live-api",
    confidence: "official",
    documents,
    participants: uniqueParticipants([
      {
        name: agency,
        role: "agency",
        participantType: "organization",
        organization: agency,
        sourceUrl,
      },
      contactName || email || phone
        ? {
            name: contactName ?? email ?? phone!,
            role: "agency",
            participantType: "person",
            organization: agency,
            ...(email ? { email } : {}),
            ...(phone ? { phone } : {}),
            sourceUrl,
          }
        : undefined,
      isAward && vendor
        ? {
            name: vendor,
            role: "contractor",
            participantType: "organization",
            organization: vendor,
            sourceUrl,
          }
        : undefined,
    ]),
    searchableFields: [
      requestId,
      pin,
      title,
      noticeType,
      category,
      safePlainText(textValue(row, "selection_method_description"), 180),
      deadline.administrative
        ? `open-ended administrative source deadline ${deadline.sourceValue ?? ""}`.trim()
        : undefined,
      description,
      safePlainText(textValue(row, "address_to_request"), 500),
      contactName,
      email,
      phone,
      vendor,
      safePlainText(textValue(row, "vendor_address"), 500),
    ].filter((value): value is string => Boolean(value)),
    documentTextIndexed: false,
  };
}

function mapNycCityRecord(row: SocrataRow): ProjectRecord {
  return mapNycCityRecordAt(row, new Date());
}

function mapChicago(row: SocrataRow): ProjectRecord {
  const sourceId = "chicago-building-permits" as const;
  const rowId = requiredIdentity(row, "id", sourceId);
  const permitNumber = textValue(row, "permit_") ?? rowId;
  const permitStatus = textValue(row, "permit_status");
  const permitMilestone = textValue(row, "permit_milestone");
  const status = compact([permitStatus, permitMilestone], " / ") || "Status not published";
  const description = textValue(row, "work_description");
  const address = compact(
    [
      textValue(row, "street_number"),
      textValue(row, "street_direction"),
      textValue(row, "street_name"),
    ],
    " ",
  );
  const sourceUrl = officialRowUrl(
    "data.cityofchicago.org",
    "ydr8-5enu",
    "id",
    rowId,
  );
  const projectParticipants = chicagoContactParticipants(row);
  return {
    id: `${sourceId}:${rowId}`,
    sourceId,
    sourceRecordId: rowId,
    title: description ?? `Chicago building permit ${permitNumber}`,
    summary: compact([
      permitNumber,
      textValue(row, "permit_type"),
      textValue(row, "work_type"),
      address || undefined,
    ]),
    stage: permittingStage(sourceId, permitStatus, permitMilestone),
    status,
    agency: "City of Chicago",
    address: address || undefined,
    city: "Chicago",
    state: "IL",
    value: moneyValue(textValue(row, "reported_cost")),
    postedAt: isoDate(textValue(row, "application_start_date")),
    updatedAt:
      isoDate(
        textValue(row, ":updated_at") ??
          textValue(row, "issue_date") ??
          textValue(row, "application_start_date"),
      ) ??
      new Date(0).toISOString(),
    sourceName: SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].name,
    sourceUrl,
    provenance: "live-api",
    confidence: "official",
    documents: [
      {
        name: "Official Chicago permit record",
        kind: "permit",
        url: sourceUrl,
        access: "public",
        indexStatus: "metadata-only",
      },
    ],
    participants: projectParticipants,
    searchableFields: [
      permitNumber,
      description,
      status,
      textValue(row, "permit_type"),
      textValue(row, "review_type"),
      textValue(row, "work_type"),
      textValue(row, "permit_condition"),
      address || undefined,
      ...projectParticipants
        .filter((participant) => participant.role !== "agency")
        .map((participant) => participant.name),
    ].filter((value): value is string => Boolean(value)),
    documentTextIndexed: false,
  };
}

function mapLosAngeles(row: SocrataRow): ProjectRecord {
  const sourceId = "los-angeles-building-permits-submitted" as const;
  const permitNumber = requiredIdentity(row, "permit_nbr", sourceId);
  const status = textValue(row, "status_desc") ?? "Status not published";
  const workDescription = textValue(row, "work_desc");
  const permitType = textValue(row, "permit_type");
  const buildingType = textValue(row, "permit_sub_type");
  const useDescription = textValue(row, "use_desc");
  const sourceUrl = officialRowUrl(
    "data.lacity.org",
    "gwh9-jnip",
    "permit_nbr",
    permitNumber,
  );
  return {
    id: `${sourceId}:${permitNumber}`,
    sourceId,
    sourceRecordId: permitNumber,
    title:
      workDescription ??
      compact([buildingType, permitType, `Los Angeles permit ${permitNumber}`], " — "),
    summary: compact([
      permitNumber,
      buildingType,
      permitType,
      useDescription,
      textValue(row, "business_unit"),
    ]),
    stage: permittingStage(sourceId, status),
    status,
    agency: "Los Angeles Department of Building and Safety",
    address: textValue(row, "primary_address"),
    city: "Los Angeles",
    state: "CA",
    postalCode: textValue(row, "zip_code"),
    value: moneyValue(textValue(row, "valuation")),
    postedAt: isoDate(textValue(row, "submitted_date")),
    updatedAt:
      isoDate(textValue(row, "status_date")) ??
      isoDate(textValue(row, "submitted_date")) ??
      new Date(0).toISOString(),
    sourceName: SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].name,
    sourceUrl,
    provenance: "live-api",
    confidence: "official",
    documents: [
      {
        name: "Official Los Angeles permit data record",
        kind: "permit",
        url: sourceUrl,
        access: "public",
        indexStatus: "metadata-only",
      },
      {
        name: "LADBS online building records search",
        kind: "source-record",
        url: "https://ladbsdoc.lacity.org/",
        access: "public",
        indexStatus: "metadata-only",
      },
    ],
    participants: [
      {
        name: "Los Angeles Department of Building and Safety",
        role: "agency",
        participantType: "organization",
        organization: "Los Angeles Department of Building and Safety",
        sourceUrl,
      },
    ],
    searchableFields: [
      permitNumber,
      textValue(row, "pin_nbr"),
      textValue(row, "apn"),
      permitType,
      buildingType,
      useDescription,
      workDescription,
      status,
      textValue(row, "permit_group"),
      textValue(row, "permit_sub_type"),
      textValue(row, "construction"),
      textValue(row, "square_footage"),
      textValue(row, "business_unit"),
      textValue(row, "cpa"),
      textValue(row, "cnc"),
    ].filter((value): value is string => Boolean(value)),
    documentTextIndexed: false,
  };
}

function mapAustin(row: SocrataRow): ProjectRecord {
  const sourceId = "austin-issued-construction-permits" as const;
  const permitNumber = requiredIdentity(row, "permit_number", sourceId);
  const status = textValue(row, "status_current") ?? "Status not published";
  const description = textValue(row, "description");
  const address = textValue(row, "original_address1") ?? textValue(row, "permit_location");
  const sourceUrl =
    trustedHttpsUrl(
      linkValue(row, "link"),
      (hostname) => hostname === "austintexas.gov" || hostname.endsWith(".austintexas.gov"),
    ) ??
    officialRowUrl(
      "data.austintexas.gov",
      "3syk-w9eu",
      "permit_number",
      permitNumber,
    );
  const contractor = textValue(row, "contractor_company_name");
  const applicantBusiness = textValue(row, "applicant_org");
  return {
    id: `${sourceId}:${permitNumber}`,
    sourceId,
    sourceRecordId: permitNumber,
    title: description ?? textValue(row, "permit_location") ?? `Austin permit ${permitNumber}`,
    summary: compact([
      permitNumber,
      textValue(row, "permit_type_desc"),
      textValue(row, "work_class"),
      address,
    ]),
    stage: permittingStage(sourceId, status),
    status,
    agency: "City of Austin Development Services Department",
    address,
    city: textValue(row, "original_city") ?? "Austin",
    state: textValue(row, "original_state") ?? "TX",
    postalCode: textValue(row, "original_zip"),
    value: moneyValue(textValue(row, "total_job_valuation")),
    postedAt: isoDate(textValue(row, "applieddate")),
    updatedAt:
      isoDate(
        textValue(row, "statusdate") ??
          textValue(row, "issue_date") ??
          textValue(row, "applieddate"),
      ) ?? new Date(0).toISOString(),
    sourceName: SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].name,
    sourceUrl,
    provenance: "live-api",
    confidence: "official",
    documents: [
      {
        name: "Official Austin permit-detail record",
        kind: "permit",
        url: sourceUrl,
        access: "public",
        indexStatus: "metadata-only",
      },
    ],
    participants: uniqueParticipants([
      { name: "City of Austin Development Services Department", role: "agency" },
      contractor ? { name: contractor, role: "contractor" } : undefined,
    ]),
    searchableFields: [
      permitNumber,
      textValue(row, "project_id"),
      textValue(row, "masterpermitnum"),
      description,
      status,
      textValue(row, "permit_type_desc"),
      textValue(row, "permit_class"),
      textValue(row, "work_class"),
      textValue(row, "contractor_trade"),
      contractor,
      applicantBusiness,
      address,
    ].filter((value): value is string => Boolean(value)),
    documentTextIndexed: false,
  };
}

function mapSanFrancisco(row: SocrataRow): ProjectRecord {
  const sourceId = "san-francisco-building-permits" as const;
  const rowId = requiredIdentity(row, "record_id", sourceId);
  const permitNumber = textValue(row, "permit_number") ?? rowId;
  const status = textValue(row, "status") ?? "Status not published";
  const description = textValue(row, "description");
  const address = compact(
    [
      textValue(row, "street_number"),
      textValue(row, "street_number_suffix"),
      textValue(row, "street_name"),
      textValue(row, "street_suffix"),
      textValue(row, "unit") ? `Unit ${textValue(row, "unit")}` : undefined,
    ],
    " ",
  );
  const sourceUrl = officialRowUrl(
    "data.sfgov.org",
    "i98e-djp9",
    "record_id",
    rowId,
  );
  return {
    id: `${sourceId}:${rowId}`,
    sourceId,
    sourceRecordId: rowId,
    title: description ?? `San Francisco building permit ${permitNumber}`,
    summary: compact([
      permitNumber,
      textValue(row, "permit_type_definition"),
      address || undefined,
      status,
    ]),
    stage: permittingStage(sourceId, status),
    status,
    agency: "San Francisco Department of Building Inspection",
    address: address || undefined,
    city: "San Francisco",
    county: "San Francisco",
    state: "CA",
    postalCode: textValue(row, "zipcode"),
    value:
      moneyValue(textValue(row, "revised_cost")) ??
      moneyValue(textValue(row, "estimated_cost")),
    postedAt: isoDate(textValue(row, "filed_date")),
    updatedAt:
      isoDate(
        textValue(row, "last_permit_activity_date") ??
          textValue(row, "completed_date") ??
          textValue(row, "issued_date") ??
          textValue(row, "approved_date") ??
          textValue(row, "status_date") ??
          textValue(row, "filed_date"),
      ) ?? new Date(0).toISOString(),
    sourceName: SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].name,
    sourceUrl,
    provenance: "live-api",
    confidence: "official",
    documents: [
      {
        name: "Official San Francisco permit record",
        kind: "permit",
        url: sourceUrl,
        access: "public",
        indexStatus: "metadata-only",
      },
    ],
    participants: [
      {
        name: "San Francisco Department of Building Inspection",
        role: "agency",
      },
    ],
    searchableFields: [
      permitNumber,
      description,
      status,
      textValue(row, "permit_type"),
      textValue(row, "permit_type_definition"),
      textValue(row, "existing_use"),
      textValue(row, "proposed_use"),
      textValue(row, "existing_occupancy"),
      textValue(row, "proposed_occupancy"),
      textValue(row, "neighborhoods_analysis_boundaries"),
      address || undefined,
      textValue(row, "plansets"),
    ].filter((value): value is string => Boolean(value)),
    documentTextIndexed: false,
  };
}

const chicagoContactFields = Array.from({ length: 15 }, (_, index) => [
  `contact_${index + 1}_type`,
  `contact_${index + 1}_name`,
]).flat();

const DEFINITIONS: Record<SocrataCitySourceId, SocrataCityDefinition> = {
  "nyc-dob-now-job-filings": {
    domain: "data.cityofnewyork.us",
    datasetId: "w9ak-ipjd",
    uniqueKey: ":id",
    // Socrata's system row IDs have a stable server-side order/comparator, but
    // their rendered tokens are intentionally opaque and are not JS-lexical.
    uniqueKeyOrder: "opaque-source-order",
    refreshSortKey: "current_status_date",
    // Dashboard views should be actionable: omit terminal/no-work/public-owner
    // filings while the ingestion lanes retain every lifecycle row so a later
    // completion or withdrawal can still close an already indexed project.
    viewWhere: NYC_DOB_ACTIVE_PRIVATE_WHERE,
    select: [
      ":id",
      "job_filing_number",
      "filing_status",
      "house_no",
      "street_name",
      "borough",
      "postcode",
      "work_on_floor",
      "applicant_professional_title",
      "applicant_license",
      "applicant_business_name",
      "filing_representative_business_name",
      "owner_s_business_name",
      "owner_type",
      "initial_cost",
      "total_construction_floor_area",
      "building_type",
      "existing_dwelling_units",
      "proposed_dwelling_units",
      "filing_date",
      "current_status_date",
      "first_permit_date",
      "approved_date",
      "signoff_date",
      "job_description",
      "job_type",
      "general_construction_work_type_",
      "mechanical_systems_work_type_",
      "structural_work_type_",
      "foundation_work_type_",
      "earth_work_work_type_",
      "plumbing_work_type",
      "sprinkler_work_type",
      "standpipe",
      "solar_work_type_",
      "green_roof_work_type_",
    ],
    map: mapNyc,
  },
  "nyc-dob-now-approved-permits": {
    domain: "data.cityofnewyork.us",
    datasetId: "rbx6-tga4",
    uniqueKey: ":id",
    uniqueKeyOrder: "opaque-source-order",
    // NYC removed the former `dobrundate` field from this dataset in 2026.
    // Issued date is the current authoritative lifecycle watermark.
    refreshSortKey: "issued_date",
    baseWhere:
      "issued_date is not null AND job_filing_number not in ('Permit is no','Permit is not yet issued') AND work_permit not in ('Permit is no','Permit is not yet issued')",
    viewWhere: "permit_status = 'Permit Issued'",
    select: [
      ":id",
      "job_filing_number",
      "work_permit",
      "sequence_number",
      "filing_reason",
      "house_no",
      "street_name",
      "borough",
      "zip_code",
      "work_on_floor",
      "work_type",
      "permittee_s_license_type",
      "applicant_license",
      "applicant_business_name",
      "filing_representative_business_name",
      "approved_date",
      "issued_date",
      "expired_date",
      "job_description",
      "estimated_job_costs",
      "owner_business_name",
      "permit_status",
      "tracking_number",
    ],
    map: mapNycApprovedPermit,
  },
  "new-jersey-construction-permits": {
    domain: "data.nj.gov",
    datasetId: "w9se-dmra",
    uniqueKey: "pk",
    refreshSortKey: "processdate",
    viewWhere: "permitstatusdesc = 'Permit'",
    select: [
      "pk",
      "comu",
      "muniname",
      "munitype",
      "county",
      "recordid",
      "block",
      "lot",
      "permitno",
      "status",
      "permitstatusdesc",
      "permitdate",
      "certdate",
      "permittype",
      "permittypedesc",
      "constcost",
      "squarefeet",
      "salegained",
      "rentgained",
      "usegroup",
      "usegroupdesc",
      "censusnumber",
      "censusdesc",
      "public",
      "source",
      "sourcedesc",
      "processdate",
    ],
    map: mapNewJerseyPermit,
  },
  "nyc-city-record-construction-procurement": {
    domain: "data.cityofnewyork.us",
    datasetId: "dg92-zbpx",
    uniqueKey: "request_id",
    refreshSortKey: "start_date",
    baseWhere: NYC_CITY_RECORD_PROCUREMENT_BASE_WHERE,
    select: [
      "request_id",
      "start_date",
      "end_date",
      "agency_name",
      "type_of_notice_description",
      "category_description",
      "short_title",
      "selection_method_description",
      "section_name",
      "special_case_reason_description",
      "pin",
      "due_date",
      "address_to_request",
      "contact_name",
      "contact_phone",
      "email",
      "contract_amount",
      "additional_description_1",
      "additional_description_2",
      "additional_description_3",
      "other_info_1",
      "other_info_2",
      "other_info_3",
      "vendor_name",
      "vendor_address",
      "document_links",
    ],
    map: mapNycCityRecord,
  },
  "los-angeles-building-permits-submitted": {
    domain: "data.lacity.org",
    datasetId: "gwh9-jnip",
    uniqueKey: "permit_nbr",
    // refresh_time is a dataset-wide extract timestamp and does not prove that
    // an individual permit changed. Use the permit's status date, falling back
    // to its submission date for brand-new applications without a status date.
    refreshSortKey: "lifecycle_activity_date",
    refreshSortExpression: "coalesce(status_date, submitted_date)",
    select: [
      "permit_nbr",
      "primary_address",
      "zip_code",
      "pin_nbr",
      "apn",
      "zone",
      "apc",
      "cpa",
      "cnc",
      "permit_group",
      "permit_type",
      "permit_sub_type",
      "use_code",
      "use_desc",
      "submitted_date",
      "issue_date",
      "cofo_date",
      "du_changed",
      "adu_changed",
      "junior_adu",
      "square_footage",
      "status_desc",
      "status_date",
      "valuation",
      "construction",
      "height",
      "work_desc",
      "ev",
      "solar",
      "business_unit",
      "refresh_time",
      "coalesce(status_date, submitted_date) AS lifecycle_activity_date",
    ],
    map: mapLosAngeles,
  },
  "chicago-building-permits": {
    domain: "data.cityofchicago.org",
    datasetId: "ydr8-5enu",
    uniqueKey: "id",
    // Permit status and milestone continue changing after issue. Socrata's
    // source row update clock is the only published field that lets refreshes
    // revisit an older permit when it becomes COMPLETE, revoked, or suspended.
    refreshSortKey: ":updated_at",
    select: [
      ":updated_at",
      "id",
      "permit_",
      "permit_status",
      "permit_milestone",
      "permit_type",
      "review_type",
      "application_start_date",
      "issue_date",
      "street_number",
      "street_direction",
      "street_name",
      "work_type",
      "work_description",
      "permit_condition",
      "reported_cost",
      ...chicagoContactFields,
    ],
    map: mapChicago,
  },
  "austin-issued-construction-permits": {
    domain: "data.austintexas.gov",
    datasetId: "3syk-w9eu",
    uniqueKey: "permit_number",
    refreshSortKey: "statusdate",
    select: [
      "permit_number",
      "project_id",
      "masterpermitnum",
      "permit_type_desc",
      "permit_class",
      "work_class",
      "permit_location",
      "description",
      "applieddate",
      "issue_date",
      "status_current",
      "statusdate",
      "total_job_valuation",
      "original_address1",
      "original_city",
      "original_state",
      "original_zip",
      "contractor_trade",
      "contractor_company_name",
      "applicant_org",
      "link",
    ],
    map: mapAustin,
  },
  "san-francisco-building-permits": {
    domain: "data.sfgov.org",
    datasetId: "i98e-djp9",
    uniqueKey: "record_id",
    refreshSortKey: "data_loaded_at",
    baseWhere: "primary_address_flag = 'Y'",
    select: [
      "record_id",
      "permit_number",
      "permit_type",
      "permit_type_definition",
      "description",
      "status",
      "status_date",
      "permit_creation_date",
      "filed_date",
      "issued_date",
      "approved_date",
      "completed_date",
      "first_construction_document_date",
      "last_permit_activity_date",
      "estimated_cost",
      "revised_cost",
      "existing_use",
      "proposed_use",
      "existing_occupancy",
      "proposed_occupancy",
      "street_number",
      "street_number_suffix",
      "street_name",
      "street_suffix",
      "unit",
      "zipcode",
      "plansets",
      "primary_address_flag",
      "neighborhoods_analysis_boundaries",
      "data_as_of",
      "data_loaded_at",
    ],
    map: mapSanFrancisco,
  },
};

function requiredIdentity(
  row: SocrataRow,
  field: string,
  sourceId: SocrataCitySourceId,
): string {
  const identity = textValue(row, field);
  if (!identity) throw new Error(`${sourceId} returned a row without ${field}`);
  return identity;
}

function escapeSocrataLiteral(value: string | number): string {
  return String(value).replace(/'/g, "''");
}

function normalizedOffset(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function refreshSortTerm(definition: SocrataCityDefinition): string {
  return definition.refreshSortExpression ?? definition.refreshSortKey;
}

function cursorTokens(
  definition: SocrataCityDefinition,
  lane: SocrataCityIngestionLane,
  cursor: SourceCursorRecord,
): { uniqueId?: string | number; sortValue?: string | number } {
  const offset = normalizedOffset(cursor.offset);
  const uniqueId = cursor.lastRecordUniqueId;
  const sortValue = cursor.lastRecordSortValue;
  const hasUniqueId =
    (typeof uniqueId === "string" && uniqueId.trim().length > 0) ||
    (typeof uniqueId === "number" && Number.isFinite(uniqueId));
  const hasSortValue =
    (typeof sortValue === "string" && sortValue.trim().length > 0) ||
    (typeof sortValue === "number" && Number.isFinite(sortValue));
  const refreshAfter = cursor.refreshAfter === true;
  const inconsistentBackfill =
    lane === "backfill" &&
    (refreshAfter || hasSortValue || (offset === 0 && hasUniqueId) || (offset > 0 && !hasUniqueId));
  const inconsistentRefreshWatermark =
    lane === "refresh" &&
    refreshAfter &&
    (offset !== 0 || !hasUniqueId || !hasSortValue);
  const inconsistentLegacyRefresh =
    lane === "refresh" &&
    !refreshAfter &&
    ((offset === 0 && (hasUniqueId || hasSortValue)) ||
      (offset > 0 && (!hasUniqueId || !hasSortValue)));
  if (inconsistentBackfill || inconsistentRefreshWatermark || inconsistentLegacyRefresh) {
    throw new Error(`${definition.datasetId}: inconsistent Socrata continuation cursor.`);
  }
  return {
    uniqueId: hasUniqueId ? uniqueId : undefined,
    sortValue: hasSortValue ? sortValue : undefined,
  };
}

function keysetWhere(
  definition: SocrataCityDefinition,
  lane: SocrataCityIngestionLane,
  cursor: SourceCursorRecord,
): string | undefined {
  const { uniqueId, sortValue } = cursorTokens(definition, lane, cursor);
  if (lane === "backfill") {
    return uniqueId === undefined
      ? undefined
      : `${definition.uniqueKey} > '${escapeSocrataLiteral(uniqueId)}'`;
  }

  if (uniqueId === undefined || sortValue === undefined) return undefined;
  const sort = escapeSocrataLiteral(sortValue);
  const id = escapeSocrataLiteral(uniqueId);
  const sortTerm = refreshSortTerm(definition);
  const comparison = cursor.refreshAfter === true ? ">" : "<";
  return `(${sortTerm} ${comparison} '${sort}' OR (${sortTerm} = '${sort}' AND ${definition.uniqueKey} > '${id}'))`;
}

function compareSourceValues(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function uniqueKeyAdvanced(
  definition: SocrataCityDefinition,
  current: string,
  previous: string,
): boolean {
  return definition.uniqueKeyOrder === "opaque-source-order"
    ? current !== previous
    : compareSourceValues(current, previous) > 0;
}

function validateDeterministicOrder(
  definition: SocrataCityDefinition,
  sourceId: SocrataCitySourceId,
  lane: SocrataCityIngestionLane,
  requestedCursor: SourceCursorRecord,
  rows: SocrataRow[],
): void {
  const seenIds = new Set<string>();
  for (const row of rows) {
    const id = requiredIdentity(row, definition.uniqueKey, sourceId);
    if (seenIds.has(id)) {
      throw new Error(`${sourceId}: source page repeated identity ${id}.`);
    }
    seenIds.add(id);
  }
  for (let index = 1; index < rows.length; index += 1) {
    const previousId = requiredIdentity(rows[index - 1], definition.uniqueKey, sourceId);
    const currentId = requiredIdentity(rows[index], definition.uniqueKey, sourceId);
    if (lane === "backfill") {
      if (!uniqueKeyAdvanced(definition, currentId, previousId)) {
        throw new Error(`${sourceId}: source identities are not strictly ascending.`);
      }
      continue;
    }
    const previousSort = requiredIdentity(
      rows[index - 1],
      definition.refreshSortKey,
      sourceId,
    );
    const currentSort = requiredIdentity(rows[index], definition.refreshSortKey, sourceId);
    const sortComparison = compareSourceValues(currentSort, previousSort);
    const refreshAscending = requestedCursor.refreshAfter === true;
    const sortOutOfOrder = refreshAscending ? sortComparison < 0 : sortComparison > 0;
    if (sortOutOfOrder || (sortComparison === 0 && !uniqueKeyAdvanced(definition, currentId, previousId))) {
      throw new Error(`${sourceId}: refresh rows are not deterministically ordered.`);
    }
  }
}

function validateContinuationBoundary(
  definition: SocrataCityDefinition,
  sourceId: SocrataCitySourceId,
  lane: SocrataCityIngestionLane,
  requestedCursor: SourceCursorRecord,
  rows: SocrataRow[],
): void {
  const firstRow = rows[0];
  if (!firstRow) return;
  const { uniqueId, sortValue } = cursorTokens(definition, lane, requestedCursor);
  if (uniqueId === undefined) return;
  const firstId = requiredIdentity(firstRow, definition.uniqueKey, sourceId);
  if (lane === "backfill") {
    if (!uniqueKeyAdvanced(definition, firstId, String(uniqueId))) {
      throw new Error(`${sourceId}: response did not advance the source identity cursor.`);
    }
    return;
  }
  if (sortValue === undefined) {
    throw new Error(`${sourceId}: refresh cursor omitted its lifecycle sort value.`);
  }
  const firstSort = requiredIdentity(firstRow, definition.refreshSortKey, sourceId);
  const sortComparison = compareSourceValues(firstSort, String(sortValue));
  const refreshAscending = requestedCursor.refreshAfter === true;
  const sortDidNotAdvance = refreshAscending ? sortComparison < 0 : sortComparison > 0;
  if (sortDidNotAdvance || (sortComparison === 0 && !uniqueKeyAdvanced(definition, firstId, String(uniqueId)))) {
    throw new Error(`${sourceId}: response did not advance the refresh cursor.`);
  }
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "BidAtlas/0.1 public-record-indexer",
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function sourceRecord(
  template: SocrataCitySourceTemplate,
  total: number,
  loaded: number,
  lane: SocrataCityIngestionLane,
  hasMore: boolean,
  scope = "immutable source universe",
): SourceRecord {
  return {
    ...template,
    status: "live",
    recordCount: total,
    loadedCount: loaded,
    snapshotComplete: lane === "backfill" && !hasMore,
    lastChecked: new Date().toISOString(),
    note: `${template.note} ${total.toLocaleString("en-US")} records are in the connector's ${scope}; ${loaded.toLocaleString("en-US")} loaded in this ${lane} page.`,
  };
}

export async function fetchSocrataCitySource(
  sourceId: SocrataCitySourceId,
  options: SocrataCityFeedOptions = {},
): Promise<SocrataCityConnectorResult> {
  const definition = DEFINITIONS[sourceId];
  const template = SOCRATA_CITY_SOURCE_TEMPLATES[sourceId];
  const mode = options.mode ?? "view";
  const lane: SocrataCityIngestionLane =
    mode === "view" ? "refresh" : (options.lane ?? "backfill");
  const requestedCursor = options.sourceCursors?.[sourceId] ?? { offset: 0 };
  const offset = normalizedOffset(requestedCursor.offset);
  cursorTokens(definition, lane, requestedCursor);
  const pageSize = mode === "ingest" ? INGEST_PAGE_SIZE : VIEW_PAGE_SIZE;

  const hasScopedView = mode === "view" && Boolean(definition.viewWhere);
  const scopeWhere = hasScopedView
    ? [
        definition.baseWhere,
        definition.viewWhere,
        `${refreshSortTerm(definition)} is not null`,
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => `(${value})`)
        .join(" AND ")
    : definition.baseWhere;
  const countParams = new URLSearchParams({ "$select": "count(*) as count" });
  if (scopeWhere) countParams.set("$where", scopeWhere);

  const cursorWhere = keysetWhere(definition, lane, requestedCursor);
  const rowWhere = [
    definition.baseWhere,
    hasScopedView ? definition.viewWhere : undefined,
    lane === "refresh" ? `${refreshSortTerm(definition)} is not null` : undefined,
    cursorWhere,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => `(${value})`)
    .join(" AND ");
  const refreshAscending = lane === "refresh" && requestedCursor.refreshAfter === true;
  const rowParams = new URLSearchParams({
    "$select": definition.select.join(","),
    "$order":
      lane === "refresh"
        ? `${refreshSortTerm(definition)} ${refreshAscending ? "ASC" : "DESC"}, ${definition.uniqueKey} ASC`
        : `${definition.uniqueKey} ASC`,
    "$limit": String(pageSize + 1),
    "$offset": "0",
  });
  if (rowWhere) rowParams.set("$where", rowWhere);

  const endpoint = `https://${definition.domain}/resource/${definition.datasetId}.json`;
  const [countRows, fetchedRows] = await Promise.all([
    fetchWithTimeout(`${endpoint}?${countParams}`).then(
      (response) => response.json() as Promise<Array<{ count?: string }>>,
    ),
    fetchWithTimeout(`${endpoint}?${rowParams}`).then(
      (response) => response.json() as Promise<SocrataRow[]>,
    ),
  ]);

  validateDeterministicOrder(definition, sourceId, lane, requestedCursor, fetchedRows);
  validateContinuationBoundary(definition, sourceId, lane, requestedCursor, fetchedRows);
  const hasMore = fetchedRows.length > pageSize;
  const rows = fetchedRows.slice(0, pageSize);
  const projects = rows.map(definition.map);
  const boundaryRow =
    lane === "refresh" && requestedCursor.refreshAfter !== true && offset === 0
      ? rows[0]
      : rows.at(-1);
  const lastUniqueId = boundaryRow
    ? requiredIdentity(boundaryRow, definition.uniqueKey, sourceId)
    : undefined;
  const lastSortValue =
    lane === "refresh" && boundaryRow
      ? requiredIdentity(boundaryRow, definition.refreshSortKey, sourceId)
      : undefined;
  const refreshWatermark = lane === "refresh" && requestedCursor.refreshAfter === true;
  const initialRefreshHead = lane === "refresh" && !refreshWatermark && offset === 0;
  const pageHasMore = initialRefreshHead ? false : hasMore;
  const nextCursor: SourceCursorRecord =
    lane === "refresh" && lastUniqueId && lastSortValue !== undefined &&
      (initialRefreshHead || refreshWatermark)
      ? {
          offset: 0,
          refreshAfter: true,
          lastRecordUniqueId: lastUniqueId,
          lastRecordSortValue: lastSortValue,
        }
      : refreshWatermark && !boundaryRow
        ? { ...requestedCursor, offset: 0, refreshAfter: true }
        : hasMore && lastUniqueId
      ? {
          offset: offset + rows.length,
          lastRecordUniqueId: lastUniqueId,
          ...(lastSortValue === undefined
            ? {}
            : { lastRecordSortValue: lastSortValue }),
        }
      : { offset: 0 };
  const page: SourcePageRecord = {
    offset,
    recordsRead: rows.length,
    nextOffset: nextCursor.offset,
    hasMore: pageHasMore,
    currentCursor: { ...requestedCursor, offset },
    nextCursor,
  };
  const sourceTotal = Number(countRows[0]?.count ?? rows.length);

  return {
    projects,
    source: sourceRecord(
      template,
      sourceTotal,
      projects.length,
      lane,
      hasMore,
      mode === "view" && definition.viewWhere
        ? sourceId === "nyc-dob-now-job-filings"
          ? "non-terminal private filing-row view"
          : "current actionable view"
        : "immutable source universe",
    ),
    page,
  };
}

/**
 * Bounded connected-search universe for still-open procurement solicitations.
 * It deliberately keeps every CROL procurement category because design,
 * renovation, and building-product work is not consistently categorized as
 * Construction. This is independent from the normal 40-row
 * refresh view, whose publication-date ordering can omit older notices with a
 * future due date.
 */
export async function fetchNycCityRecordCurrentConstructionSolicitations(
  requestedLimit = NYC_CITY_RECORD_CURRENT_MAX,
  now = new Date(),
): Promise<NycCityRecordCurrentSolicitationUniverse> {
  if (!Number.isFinite(now.getTime())) throw new Error("Current solicitation query requires a valid date.");
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(NYC_CITY_RECORD_CURRENT_MAX, Math.trunc(requestedLimit)))
    : NYC_CITY_RECORD_CURRENT_MAX;
  const sourceCalendarDay = calendarDateInTimeZone(now, NYC_CITY_RECORD_TIME_ZONE);
  const socrataDayStart = `${sourceCalendarDay}T00:00:00.000`;
  const dayStart = sourceLocalDateTimeToIso(
    socrataDayStart,
    NYC_CITY_RECORD_TIME_ZONE,
  );
  if (!dayStart) {
    throw new Error("Unable to resolve the NYC City Record source-local day boundary.");
  }
  const where = [
    NYC_CITY_RECORD_PROCUREMENT_BASE_WHERE,
    "type_of_notice_description = 'Solicitation'",
    `due_date >= '${escapeSocrataLiteral(socrataDayStart)}'`,
  ].map((clause) => `(${clause})`).join(" AND ");
  const definition = DEFINITIONS["nyc-city-record-construction-procurement"];
  const endpoint = `https://${definition.domain}/resource/${definition.datasetId}.json`;
  const countParams = new URLSearchParams({
    "$select": "count(*) as count",
    "$where": where,
  });
  const rowParams = new URLSearchParams({
    "$select": definition.select.join(","),
    "$where": where,
    "$order": "due_date ASC, request_id ASC",
    "$limit": String(limit),
    "$offset": "0",
  });
  const [countRows, rows] = await Promise.all([
    fetchWithTimeout(`${endpoint}?${countParams}`).then(
      (response) => response.json() as Promise<Array<{ count?: string }>>,
    ),
    fetchWithTimeout(`${endpoint}?${rowParams}`).then(
      (response) => response.json() as Promise<SocrataRow[]>,
    ),
  ]);
  const sourceReportedMatches = Number(countRows[0]?.count);
  if (!Number.isSafeInteger(sourceReportedMatches) || sourceReportedMatches < 0) {
    throw new Error("NYC City Record current-solicitation count was missing or invalid.");
  }
  if (!Array.isArray(rows)) {
    throw new Error("NYC City Record current-solicitation rows were missing.");
  }
  const rangeStart = dayStart;
  const projects = rows
    // Keep a defensive lower bound as well as the SoQL predicate. Far-future
    // administrative values remain searchable as open-ended opportunities;
    // mapNycCityRecord removes those values from deadline filters.
    .filter((row) => {
      const dueDate = sourceLocalDateTimeToIso(
        textValue(row, "due_date"),
        NYC_CITY_RECORD_TIME_ZONE,
      );
      return Boolean(dueDate && dueDate >= rangeStart);
    })
    .slice(0, limit)
    .map((row) => mapNycCityRecordAt(row, now));
  return {
    sourceId: "nyc-city-record-construction-procurement",
    projects,
    sourceReportedMatches,
    resultLimitReached: sourceReportedMatches > projects.length,
    returnedProjects: projects.length,
    sourceTimeZone: NYC_CITY_RECORD_TIME_ZONE,
    asOfSourceDayStart: dayStart,
  };
}

/** Exact source-backed lookup for an on-demand project open/research path. */
export async function lookupNycCityRecordConstructionProject(
  projectId: string,
): Promise<ProjectRecord | null> {
  const prefix = "nyc-city-record-construction-procurement:";
  if (!projectId.startsWith(prefix)) return null;
  const requestId = projectId.slice(prefix.length);
  // request_id is a numeric column. Reject everything except a bounded decimal
  // identity before constructing SoQL, even though the literal is also escaped.
  if (!/^\d{1,20}$/.test(requestId)) return null;
  const definition = DEFINITIONS["nyc-city-record-construction-procurement"];
  const params = new URLSearchParams({
    "$select": definition.select.join(","),
    "$where": `(${NYC_CITY_RECORD_PROCUREMENT_BASE_WHERE}) AND (request_id = '${escapeSocrataLiteral(requestId)}')`,
    "$order": "request_id ASC",
    "$limit": "2",
    "$offset": "0",
  });
  const endpoint = `https://${definition.domain}/resource/${definition.datasetId}.json`;
  const rows = await fetchWithTimeout(`${endpoint}?${params}`).then(
    (response) => response.json() as Promise<SocrataRow[]>,
  );
  if (!Array.isArray(rows)) throw new Error("NYC City Record exact lookup returned no row array.");
  const exact = rows.filter((row) => textValue(row, "request_id") === requestId);
  if (exact.length === 0) return null;
  if (exact.length !== 1) {
    throw new Error("NYC City Record exact lookup returned an ambiguous request_id.");
  }
  return definition.map(exact[0]);
}

/** Exact lookup for a project emitted by any configured Socrata city adapter. */
export async function lookupSocrataCityProject(
  projectId: string,
): Promise<ProjectRecord | null> {
  const sourceId = SOCRATA_CITY_SOURCE_IDS.find((candidate) =>
    projectId.startsWith(`${candidate}:`),
  );
  if (!sourceId) return null;
  if (sourceId === "nyc-city-record-construction-procurement") {
    return lookupNycCityRecordConstructionProject(projectId);
  }
  const rawRecordId = projectId.slice(sourceId.length + 1);
  if (
    (sourceId === "nyc-dob-now-job-filings" ||
      sourceId === "nyc-dob-now-approved-permits") &&
    !NYC_DOB_ROW_ID.test(rawRecordId)
  ) {
    return null;
  }
  const recordId =
    sourceId === "nyc-dob-now-job-filings" ||
    sourceId === "nyc-dob-now-approved-permits"
    ? rawRecordId
    : rawRecordId.trim();
  if (
    !recordId ||
    recordId.length > 240 ||
    /[\u0000-\u001f\u007f]/.test(recordId)
  ) {
    return null;
  }
  const definition = DEFINITIONS[sourceId];
  const where = [
    definition.baseWhere,
    `${definition.uniqueKey} = '${escapeSocrataLiteral(recordId)}'`,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => `(${value})`)
    .join(" AND ");
  const params = new URLSearchParams({
    "$select": definition.select.join(","),
    "$where": where,
    "$order": `${definition.uniqueKey} ASC`,
    "$limit": "2",
    "$offset": "0",
  });
  const endpoint = `https://${definition.domain}/resource/${definition.datasetId}.json`;
  const rows = await fetchWithTimeout(`${endpoint}?${params}`).then(
    (response) => response.json() as Promise<SocrataRow[]>,
  );
  if (!Array.isArray(rows)) {
    throw new Error(`${sourceId} exact lookup returned no row array.`);
  }
  const exact = rows.filter(
    (row) => textValue(row, definition.uniqueKey) === recordId,
  );
  if (exact.length === 0) return null;
  if (exact.length !== 1) {
    throw new Error(`${sourceId} exact lookup returned an ambiguous source identity.`);
  }
  return definition.map(exact[0]);
}

export async function fetchSocrataCitySources(
  options: SocrataCityFeedOptions = {},
): Promise<SocrataCityConnectorResult[]> {
  const selected = SOCRATA_CITY_SOURCE_IDS.filter(
    (sourceId) => !options.sourceId || options.sourceId === sourceId,
  );
  return Promise.all(selected.map((sourceId) => fetchSocrataCitySource(sourceId, options)));
}
