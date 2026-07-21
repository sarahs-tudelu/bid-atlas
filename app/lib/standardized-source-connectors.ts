import type {
  ProjectDocument,
  ProjectParticipant,
  ProjectRecord,
  ProjectStage,
  SourceCursorRecord,
  SourcePageRecord,
  SourceRecord,
} from "./types";
import { inferredProjectSectorTags } from "./project-sector.ts";

const REQUEST_TIMEOUT_MS = 8_000;
const INGEST_PAGE_SIZE = 50;
const VIEW_PAGE_SIZE = 40;
const PAGE_LOOKAHEAD = 1;
const DUPLICATE_HYDRATION_MAX_ID_FIELD = "max_internal_id";
const RETRY_DELAYS_MS = [150, 450] as const;
const LIFECYCLE_DATE_CLOCK_SKEW_MS = 2 * 24 * 60 * 60 * 1_000;
const EARLIEST_LIFECYCLE_DATE_MS = Date.UTC(1900, 0, 1);

export const STANDARDIZED_SOURCE_IDS = [
  "tempe-building-permits-arcgis",
  "pittsburgh-pli-permits-ckan",
  "boston-approved-building-permits-ckan",
  "miami-ibuild-plan-review-arcgis",
  "philadelphia-li-active-permits-carto",
] as const;

export type StandardizedSourceId = (typeof STANDARDIZED_SOURCE_IDS)[number];
export type StandardizedFeedMode = "view" | "ingest";
export type StandardizedIngestionLane = "backfill" | "refresh";
export type StandardizedSourceTemplate = Omit<
  SourceRecord,
  "status" | "recordCount" | "lastChecked"
>;

export interface StandardizedConnectorResult {
  projects: ProjectRecord[];
  source: SourceRecord;
  page: SourcePageRecord;
}

export interface StandardizedRequestDependencies {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  requestTimeoutMs?: number;
}

export interface StandardizedFeedOptions extends StandardizedRequestDependencies {
  mode?: StandardizedFeedMode;
  lane?: StandardizedIngestionLane;
  sourceCursors?: Record<string, SourceCursorRecord>;
  sourceId?: string;
}

type StandardizedRow = Record<string, unknown>;
type FieldValueType = "number" | "text";

export interface StandardizedUrlField {
  field: string;
  name: string;
  kind: ProjectDocument["kind"];
  allowedHosts: readonly string[];
}

export interface StandardizedParticipantField {
  field: string;
  role: ProjectParticipant["role"];
  organizationOnly?: boolean;
}

export interface StandardizedRecordMapping {
  idField: string;
  titleFields: readonly string[];
  summaryFields: readonly string[];
  statusField: string;
  statusFields?: readonly string[];
  stageResolver?: (row: Record<string, unknown>) => ProjectStage;
  agency: string;
  addressField?: string;
  cityField?: string;
  defaultCity?: string;
  stateField?: string;
  defaultState?: string;
  postalCodeField?: string;
  valueField?: string;
  postedAtFields: readonly string[];
  updatedAtFields: readonly string[];
  participantFields: readonly StandardizedParticipantField[];
  searchableFields: readonly string[];
  /** Source columns that explicitly classify sector or occupancy. */
  sectorFields?: readonly string[];
  documentUrlFields: readonly StandardizedUrlField[];
  contactUrlFields: readonly StandardizedUrlField[];
  supplementalDocuments?: readonly ProjectDocument[];
  sourceDocumentName: string;
  sourceDocumentKind: ProjectDocument["kind"];
}

interface StandardizedBaseDefinition {
  template: StandardizedSourceTemplate;
  selectFields: readonly string[];
  internalIdField: string;
  internalIdType: "number";
  refreshSortField: string;
  refreshSortType: FieldValueType;
  refreshSortKind?: "lifecycle-date";
  duplicateIdentityPolicy?: "newest-internal-id";
  baseWhere: string;
  /** Optional narrower interactive universe; ingestion still reconciles baseWhere. */
  viewWhere?: string;
  mapping: StandardizedRecordMapping;
  recordUrl?: (row: Record<string, unknown>) => string | undefined;
}

export interface ArcgisStandardizedSourceDefinition extends StandardizedBaseDefinition {
  platform: "arcgis";
  layerUrl: string;
}

export interface CkanStandardizedSourceDefinition extends StandardizedBaseDefinition {
  platform: "ckan";
  apiRoot: string;
  resourceId: string;
}

export interface CartoStandardizedSourceDefinition extends StandardizedBaseDefinition {
  platform: "carto";
  apiRoot: string;
  table: string;
  /** Trusted source-native expression selected under refreshSortField as its alias. */
  refreshSortExpression?: string;
}

export type StandardizedSourceDefinition =
  | ArcgisStandardizedSourceDefinition
  | CkanStandardizedSourceDefinition
  | CartoStandardizedSourceDefinition;

export const STANDARDIZED_SOURCE_TEMPLATES: Record<
  StandardizedSourceId,
  StandardizedSourceTemplate
> = {
  "tempe-building-permits-arcgis": {
    id: "tempe-building-permits-arcgis",
    name: "Tempe permits issued by Building Safety",
    owner: "City of Tempe Community Development Department",
    level: "local",
    sourceClass: "permits",
    stages: ["design", "permitting", "completed", "cancelled", "unclassified"],
    access: "open",
    cadence: "Weekly",
    url: "https://data.tempe.gov/datasets/tempegov::permits-issued-by-building-safety/about",
    jurisdiction: "Tempe, Arizona",
    note:
      "City of Tempe Building Safety permit records from Accela. This local adapter is not a claim of Arizona or national permit completeness.",
  },
  "pittsburgh-pli-permits-ckan": {
    id: "pittsburgh-pli-permits-ckan",
    name: "Pittsburgh PLI permits",
    owner: "City of Pittsburgh Department of Permits, Licenses, and Inspections",
    level: "local",
    sourceClass: "permits",
    stages: ["design", "permitting", "completed", "cancelled", "unclassified"],
    access: "open",
    cadence: "Daily",
    url: "https://data.wprdc.org/dataset/pli-permits",
    jurisdiction: "Pittsburgh, Pennsylvania",
    note:
      "City of Pittsburgh PLI permits published from June 2019 onward. The source excludes plumbing permits and does not establish Pennsylvania or national completeness.",
  },
  "boston-approved-building-permits-ckan": {
    id: "boston-approved-building-permits-ckan",
    name: "Boston approved building permits",
    owner: "City of Boston Inspectional Services Department",
    level: "local",
    sourceClass: "permits",
    stages: ["design", "permitting", "completed", "cancelled", "unclassified"],
    access: "open",
    cadence: "Daily",
    url: "https://data.boston.gov/dataset/approved-building-permits",
    jurisdiction: "Boston, Massachusetts",
    note:
      "Official approved building permits with residential, commercial, and mixed occupancy, valuation, address, status, and published work descriptions. This local source does not establish national completeness, and applicant names are not promoted into outreach contacts by this adapter.",
  },
  "miami-ibuild-plan-review-arcgis": {
    id: "miami-ibuild-plan-review-arcgis",
    name: "City of Miami iBuild permit applications",
    owner: "City of Miami Building Department",
    level: "local",
    sourceClass: "permits",
    stages: ["design", "permitting", "construction", "completed", "cancelled", "unclassified"],
    access: "open",
    cadence: "Every 24 hours (upstream publication cadence not stated)",
    recordCountUnit: "rows",
    url: "https://www.miami.gov/Permits-Construction/Apply-for-or-Manage-Building-Permits-iBuild",
    jurisdiction: "Miami, Florida",
    note:
      "Official iBuild building-permit applications in non-terminal source statuses, including plan review, approved, and permit-issued work. BidAtlas checks this source daily; the upstream publication cadence is not stated. The layer covers private residential and commercial addresses but does not publish a reliable residential/commercial classification. It exposes permit metadata only: no applicant, owner, architect, contractor, or bidder contacts and no ProjectDox drawing files. Plan availability and account requirements must be verified in the City systems. ApplicationNumber is the project identity; when the layer repeats an application, BidAtlas deterministically keeps its newest OBJECTID row. The layer does not publish an application/update date, so OBJECTID is used for loading and row selection but is not presented as project activity. The source total is a row count, not a guaranteed unique-project count. This local source does not establish Florida or national completeness.",
  },
  "philadelphia-li-active-permits-carto": {
    id: "philadelphia-li-active-permits-carto",
    name: "Philadelphia L&I construction permit rows",
    owner: "City of Philadelphia Department of Licenses and Inspections",
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
    url: "https://data.phila.gov/visualizations/li-building-permits/",
    jurisdiction: "Philadelphia, Pennsylvania",
    note:
      "Official Philadelphia L&I building, zoning, and trade-permit rows issued within the past five years. The interactive view is limited to non-terminal work; ingestion also revisits a bounded recent-terminal window so completed, expired, cancelled, withdrawn, refused, and denied rows can update previously active records. A source-derived lifecycle watermark captures later inspections, completions, certificates, and denials independently of the historical permit-ID scan. This issued-permit dataset includes amendment review states but is not a separate feed of original pre-issuance applications or initial plan review. The source covers private residential and commercial work, scope, occupancy, units, stories, and published contractor or property-owner organization names. Personal owner names are not promoted into outreach contacts. Counts are permit rows, not unique buildings or construction projects. The open-data row does not establish that filed plan sheets are publicly downloadable; plan-copy access is restricted and must be verified through the City's records-request process. This local source does not establish national completeness.",
  },
};

const TEMPE_FIELDS = [
  "OBJECTID",
  "PermitNum",
  "ProjectName",
  "Description",
  "AppliedDateDtm",
  "IssuedDateDtm",
  "CompletedDateDtm",
  "StatusDateDtm",
  "VoidDateDtm",
  "StatusCurrent",
  "OriginalAddress1",
  "OriginalCity",
  "OriginalState",
  "OriginalZip",
  "PermitClass",
  "PermitType",
  "PermitTypeDesc",
  "EstProjectCost",
  "ContractorCompanyName",
] as const;

const PITTSBURGH_FIELDS = [
  "_id",
  "permit_id",
  "permit_type",
  "contractor_name",
  "work_description",
  "work_type",
  "commercial_or_residential",
  "total_project_value",
  "issue_date",
  "parcel_num",
  "address",
  "council_district",
  "neighborhood",
  "ward",
  "zip_code",
  "status",
] as const;

const BOSTON_FIELDS = [
  "_id",
  "permitnumber",
  "worktype",
  "permittypedescr",
  "description",
  "comments",
  "declared_valuation",
  "issued_date",
  "expiration_date",
  "status",
  "occupancytype",
  "sq_feet",
  "address",
  "city",
  "state",
  "zip",
  "property_id",
  "parcel_id",
] as const;

const MIAMI_IBUILD_FIELDS = [
  "OBJECTID",
  "PermitNumber",
  "ApplicationNumber",
  "App",
  "ApplicationId",
  "PermitStatus",
  "ADDPTKEY",
  "FULLADDR",
  "FOLIO",
  "ApplicationType",
  "Banner",
  "PlanNumber",
  "MasterPermitStatus",
  "PermitIssuedDate",
  "MasterPlanStatus",
  "MasterPermitType",
  "ScopeOfWork",
  "MasterPermitNumber",
  "ProjectName",
  "COMDISTID",
  "NSCA_ID",
  "ApplicationStatusDate",
  "PermitType",
  "PermitApplicationAddressID",
] as const;

const PHILADELPHIA_PERMIT_FIELDS = [
  "cartodb_id",
  "permitnumber",
  "permittype",
  "permitdescription",
  "commercialorresidential",
  "typeofwork",
  "approvedscopeofwork",
  "permitissuedate",
  "status",
  "applicanttype",
  "contractorname",
  "mostrecentinsp",
  "posse_jobid",
  "opa_account_num",
  "address",
  "unit_type",
  "unit_num",
  "zip",
  "council_district",
  "opa_owner",
  "systemofrecord",
  "usecategories",
  "occupancytype",
  "permitcompleteddate",
  "numberofunits",
  "certificateofoccupancydate",
  "certificateofoccupancyrequired",
  "parentjobid",
  "certificateofoccupancylink",
  "zoningpermitjobid",
  "numberofstories",
  "denialdocumentlink",
  "areaofdisturbance",
  "denialdate",
] as const;

function philadelphiaPermitStage(row: Record<string, unknown>): ProjectStage {
  const status = normalizedStatus(textValue(row, "status") ?? "");
  const terminalStage = standardizedPermitStage(status);
  if (terminalStage === "cancelled" || terminalStage === "completed") {
    return terminalStage;
  }
  if (
    textValue(row, "permitcompleteddate") ||
    textValue(row, "certificateofoccupancydate")
  ) {
    return "completed";
  }
  if (/amendment (?:application incomplete|applicant revisions|review|requested)/.test(status)) {
    return "design";
  }
  if (/amendment ready for issue|ready for issue/.test(status)) return "permitting";
  if (status === "issued" || status === "stop work") return "construction";
  return standardizedPermitStage(status);
}

function miamiIBuildStage(row: Record<string, unknown>): ProjectStage {
  const permitStatus = normalizedStatus(textValue(row, "PermitStatus") ?? "");
  const planStatus = normalizedStatus(textValue(row, "MasterPlanStatus") ?? "");
  if (/\b(?:cancelled|canceled|expired|revoked|terminated)\b/.test(permitStatus)) {
    return "cancelled";
  }
  if (/\bfinal\b/.test(permitStatus)) return "completed";
  if (/\bactive\b/.test(permitStatus)) return "construction";
  if (/\b(?:pending|hold|inadjustment|in adjustment)\b/.test(permitStatus)) {
    return "permitting";
  }
  if (/\b(?:cancelled|canceled|expired|revoked|inactive|terminated)\b/.test(planStatus)) {
    return "cancelled";
  }
  if (/\bfinal\b/.test(planStatus)) return "completed";
  if (/\bpermit issued\b/.test(planStatus)) return "construction";
  if (/\bapproved\b/.test(planStatus)) return "permitting";
  if (
    /\b(?:applicant|corrections?|incomplete|prescreen|review|submitted|hold)\b/.test(
      planStatus,
    )
  ) {
    return "design";
  }
  return "unclassified";
}

export const STANDARDIZED_SOURCE_DEFINITIONS: Record<
  StandardizedSourceId,
  StandardizedSourceDefinition
> = {
  "tempe-building-permits-arcgis": {
    platform: "arcgis",
    template: STANDARDIZED_SOURCE_TEMPLATES["tempe-building-permits-arcgis"],
    layerUrl:
      "https://services.arcgis.com/lQySeXwbBg53XWDi/arcgis/rest/services/building_permits/FeatureServer/0",
    selectFields: TEMPE_FIELDS,
    internalIdField: "OBJECTID",
    internalIdType: "number",
    refreshSortField: "StatusDateDtm",
    refreshSortType: "number",
    refreshSortKind: "lifecycle-date",
    baseWhere: "PermitNum IS NOT NULL",
    mapping: {
      idField: "PermitNum",
      titleFields: ["ProjectName", "Description"],
      summaryFields: [
        "PermitNum",
        "PermitClass",
        "PermitTypeDesc",
        "Description",
      ],
      statusField: "StatusCurrent",
      agency: "City of Tempe Building Safety Division",
      addressField: "OriginalAddress1",
      cityField: "OriginalCity",
      defaultCity: "Tempe",
      stateField: "OriginalState",
      defaultState: "AZ",
      postalCodeField: "OriginalZip",
      valueField: "EstProjectCost",
      postedAtFields: ["AppliedDateDtm"],
      updatedAtFields: [
        "StatusDateDtm",
        "CompletedDateDtm",
        "VoidDateDtm",
        "IssuedDateDtm",
        "AppliedDateDtm",
      ],
      participantFields: [
        {
          field: "ContractorCompanyName",
          role: "contractor",
          organizationOnly: true,
        },
      ],
      searchableFields: [
        "PermitNum",
        "ProjectName",
        "Description",
        "PermitClass",
        "PermitType",
        "PermitTypeDesc",
        "ContractorCompanyName",
      ],
      sectorFields: ["PermitClass"],
      documentUrlFields: [],
      contactUrlFields: [],
      sourceDocumentName: "Official Tempe permit record",
      sourceDocumentKind: "permit",
    },
  },
  "pittsburgh-pli-permits-ckan": {
    platform: "ckan",
    template: STANDARDIZED_SOURCE_TEMPLATES["pittsburgh-pli-permits-ckan"],
    apiRoot: "https://data.wprdc.org/api/3/action",
    resourceId: "f4d1177a-f597-4c32-8cbf-7885f56253f6",
    selectFields: PITTSBURGH_FIELDS,
    internalIdField: "_id",
    internalIdType: "number",
    refreshSortField: "issue_date",
    refreshSortType: "text",
    refreshSortKind: "lifecycle-date",
    baseWhere: '"permit_id" IS NOT NULL',
    mapping: {
      idField: "permit_id",
      titleFields: ["work_description", "permit_type"],
      summaryFields: [
        "permit_id",
        "permit_type",
        "work_type",
        "commercial_or_residential",
        "neighborhood",
      ],
      statusField: "status",
      agency: "City of Pittsburgh Department of Permits, Licenses, and Inspections",
      addressField: "address",
      defaultCity: "Pittsburgh",
      defaultState: "PA",
      postalCodeField: "zip_code",
      valueField: "total_project_value",
      postedAtFields: ["issue_date"],
      updatedAtFields: ["issue_date"],
      participantFields: [
        { field: "contractor_name", role: "contractor", organizationOnly: true },
      ],
      searchableFields: [
        "permit_id",
        "permit_type",
        "contractor_name",
        "work_description",
        "work_type",
        "commercial_or_residential",
        "parcel_num",
        "address",
        "neighborhood",
      ],
      sectorFields: ["commercial_or_residential"],
      documentUrlFields: [],
      contactUrlFields: [],
      sourceDocumentName: "Official Pittsburgh PLI permit record",
      sourceDocumentKind: "permit",
    },
  },
  "boston-approved-building-permits-ckan": {
    platform: "ckan",
    template: STANDARDIZED_SOURCE_TEMPLATES["boston-approved-building-permits-ckan"],
    apiRoot: "https://data.boston.gov/api/3/action",
    resourceId: "6ddcd912-32a0-43df-9908-63574f8c7e77",
    selectFields: BOSTON_FIELDS,
    internalIdField: "_id",
    internalIdType: "number",
    refreshSortField: "issued_date",
    refreshSortType: "text",
    refreshSortKind: "lifecycle-date",
    baseWhere: '"permitnumber" IS NOT NULL',
    mapping: {
      // permitnumber is not unique in the upstream resource. CKAN's _id is the
      // stable row identity; permitnumber remains in the visible summary and
      // searchable metadata below.
      idField: "_id",
      titleFields: ["comments", "description", "permittypedescr"],
      summaryFields: [
        "permitnumber",
        "permittypedescr",
        "worktype",
        "occupancytype",
        "description",
      ],
      statusField: "status",
      agency: "City of Boston Inspectional Services Department",
      addressField: "address",
      cityField: "city",
      defaultCity: "Boston",
      stateField: "state",
      defaultState: "MA",
      postalCodeField: "zip",
      valueField: "declared_valuation",
      postedAtFields: ["issued_date"],
      updatedAtFields: ["issued_date"],
      participantFields: [],
      searchableFields: [
        "permitnumber",
        "worktype",
        "permittypedescr",
        "description",
        "comments",
        "occupancytype",
        "sq_feet",
        "property_id",
        "parcel_id",
        "address",
      ],
      sectorFields: ["occupancytype"],
      documentUrlFields: [],
      contactUrlFields: [],
      sourceDocumentName: "Official Boston approved building-permit record",
      sourceDocumentKind: "permit",
    },
  },
  "miami-ibuild-plan-review-arcgis": {
    platform: "arcgis",
    template: STANDARDIZED_SOURCE_TEMPLATES["miami-ibuild-plan-review-arcgis"],
    layerUrl:
      "https://gis.miami.gov/gis/rest/services/Maps/iBuildPermits/MapServer/0",
    selectFields: MIAMI_IBUILD_FIELDS,
    internalIdField: "OBJECTID",
    internalIdType: "number",
    // The official layer's ApplicationStatusDate is null for every current row.
    // OBJECTID provides a loading cursor and deterministic duplicate-row
    // selection; it never becomes project activity.
    refreshSortField: "OBJECTID",
    refreshSortType: "number",
    duplicateIdentityPolicy: "newest-internal-id",
    baseWhere:
      "ApplicationNumber IS NOT NULL AND MasterPlanStatus NOT IN ('Final','Cancelled','Expired','Revoked','Inactive','Terminated') AND (PermitStatus IS NULL OR PermitStatus NOT IN ('Final','Cancelled','Expired','Revoked'))",
    mapping: {
      // The public application number is the canonical project identity. The
      // layer repeats some applications, so the definition's collision policy
      // selects the newest OBJECTID row without creating duplicate cards.
      idField: "ApplicationNumber",
      titleFields: ["ProjectName", "ScopeOfWork", "ApplicationType"],
      summaryFields: [
        "ApplicationNumber",
        "PermitNumber",
        "MasterPlanStatus",
        "PermitStatus",
        "ScopeOfWork",
        "MasterPermitType",
        "FULLADDR",
      ],
      statusField: "MasterPlanStatus",
      statusFields: ["MasterPlanStatus", "PermitStatus"],
      stageResolver: miamiIBuildStage,
      agency: "City of Miami Building Department",
      addressField: "FULLADDR",
      defaultCity: "Miami",
      defaultState: "FL",
      postedAtFields: ["PermitIssuedDate"],
      updatedAtFields: ["PermitIssuedDate"],
      participantFields: [],
      searchableFields: [
        "ApplicationNumber",
        "PermitNumber",
        "PlanNumber",
        "MasterPermitNumber",
        "ProjectName",
        "FULLADDR",
        "FOLIO",
        "ApplicationType",
        "Banner",
        "MasterPlanStatus",
        "PermitStatus",
        "MasterPermitType",
        "PermitType",
        "ScopeOfWork",
      ],
      documentUrlFields: [],
      contactUrlFields: [],
      sourceDocumentName: "Official City of Miami permit-application metadata",
      sourceDocumentKind: "permit",
    },
  },
  "philadelphia-li-active-permits-carto": {
    platform: "carto",
    template:
      STANDARDIZED_SOURCE_TEMPLATES["philadelphia-li-active-permits-carto"],
    apiRoot: "https://phl.carto.com/api/v2/sql",
    table: "permits",
    selectFields: PHILADELPHIA_PERMIT_FIELDS,
    internalIdField: "cartodb_id",
    internalIdType: "number",
    refreshSortField: "lifecycle_activity_date",
    refreshSortExpression:
      "greatest(permitissuedate, permitcompleteddate, mostrecentinsp, certificateofoccupancydate, denialdate)",
    refreshSortType: "text",
    refreshSortKind: "lifecycle-date",
    baseWhere:
      "permitnumber IS NOT NULL AND permitissuedate >= current_date - interval '5 years' AND ((permitcompleteddate IS NULL AND certificateofoccupancydate IS NULL AND status IN ('Issued','Stop Work','Amendment Application Incomplete','Amendment Applicant Revisions','Amendment Review','Amendment Ready For Issue','Amendment Requested','Ready For Issue')) OR permitcompleteddate >= current_date - interval '180 days' OR certificateofoccupancydate >= current_date - interval '180 days' OR denialdate >= current_date - interval '180 days')",
    viewWhere:
      "permitcompleteddate IS NULL AND certificateofoccupancydate IS NULL AND status IN ('Issued','Stop Work','Amendment Application Incomplete','Amendment Applicant Revisions','Amendment Review','Amendment Ready For Issue','Amendment Requested','Ready For Issue')",
    mapping: {
      idField: "permitnumber",
      titleFields: ["approvedscopeofwork", "typeofwork", "permitdescription"],
      summaryFields: [
        "permitnumber",
        "commercialorresidential",
        "permittype",
        "typeofwork",
        "occupancytype",
        "address",
      ],
      statusField: "status",
      stageResolver: philadelphiaPermitStage,
      agency: "City of Philadelphia Department of Licenses and Inspections",
      addressField: "address",
      defaultCity: "Philadelphia",
      defaultState: "PA",
      postalCodeField: "zip",
      postedAtFields: ["permitissuedate"],
      updatedAtFields: [
        "lifecycle_activity_date",
        "permitcompleteddate",
        "certificateofoccupancydate",
        "denialdate",
        "mostrecentinsp",
        "permitissuedate",
      ],
      participantFields: [
        { field: "contractorname", role: "contractor", organizationOnly: true },
        { field: "opa_owner", role: "owner", organizationOnly: true },
      ],
      searchableFields: [
        "permitnumber",
        "permittype",
        "permitdescription",
        "commercialorresidential",
        "typeofwork",
        "approvedscopeofwork",
        "status",
        "address",
        "zip",
        "usecategories",
        "occupancytype",
        "numberofunits",
        "numberofstories",
        "areaofdisturbance",
      ],
      sectorFields: ["commercialorresidential", "occupancytype", "usecategories"],
      documentUrlFields: [
        {
          field: "certificateofoccupancylink",
          name: "Published certificate of occupancy",
          kind: "permit",
          allowedHosts: ["eclipse.phila.gov"],
        },
        {
          field: "denialdocumentlink",
          name: "Published L&I decision document",
          kind: "other",
          allowedHosts: ["eclipse.phila.gov"],
        },
      ],
      contactUrlFields: [],
      supplementalDocuments: [
        {
          name: "Philadelphia building-file and plan-copy request instructions",
          kind: "source-record",
          url: "https://www.phila.gov/services/permits-violations-licenses/get-a-copy-of-a-license-permit-or-violation/",
          access: "public",
          indexStatus: "metadata-only",
        },
      ],
      sourceDocumentName: "Official Philadelphia L&I permit record",
      sourceDocumentKind: "permit",
    },
  },
};

class NonRetryableRequestError extends Error {}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(1_000, Math.trunc(seconds * 1_000));
  }
  return RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1) ?? 450;
}

export async function fetchOfficialJsonWithRetry(
  url: string,
  dependencies: StandardizedRequestDependencies = {},
): Promise<unknown> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? defaultSleep;
  const timeoutMs = dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      response = await fetchImpl(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "BidAtlas/0.1 public-record-indexer",
        },
      });
      if (!response.ok) {
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable) {
          throw new NonRetryableRequestError(`${response.status} ${response.statusText}`);
        }
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (error instanceof NonRetryableRequestError || attempt >= RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(retryDelay(response, attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Official source request failed.");
}

function normalizedOffset(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function textValue(row: StandardizedRow, field: string): string | undefined {
  const value = row[field];
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function firstText(row: StandardizedRow, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = textValue(row, field);
    if (value) return value;
  }
  return undefined;
}

function dateValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed =
    typeof value === "number"
      ? new Date(value < 100_000_000_000 ? value * 1_000 : value)
      : new Date(
          /(?:z|[+-]\d{2}:?\d{2})$/i.test(value)
            ? value
            : /^\d{4}-\d{2}-\d{2}$/.test(value)
              ? `${value}T00:00:00.000Z`
              : `${value}Z`,
        );
  const timestamp = parsed.getTime();
  if (
    !Number.isFinite(timestamp) ||
    timestamp < EARLIEST_LIFECYCLE_DATE_MS ||
    timestamp > Date.now() + LIFECYCLE_DATE_CLOCK_SKEW_MS
  ) {
    return undefined;
  }
  return parsed.toISOString();
}

function firstDate(row: StandardizedRow, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = dateValue(row[field]);
    if (value) return value;
  }
  return undefined;
}

function moneyValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedStatus(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function standardizedPermitStage(statusValue: string | undefined): ProjectStage {
  const status = normalizedStatus(statusValue ?? "");
  if (/\b(?:cancelled|canceled|void|voided|withdrawn|denied|refused|expired|revoked|abandoned)\b/.test(status)) {
    return "cancelled";
  }
  if (/\b(?:complete|completed|final|finaled|closed|certificate of occupancy)\b/.test(status)) {
    return "completed";
  }
  if (/\b(?:issued|active|open|approved|ready for issuance|inspections?)\b/.test(status)) {
    return "permitting";
  }
  if (/\b(?:applied|application|review|pending|submitted|intake|correction|additional info)\b/.test(status)) {
    return "design";
  }
  return "unclassified";
}

const ORGANIZATION_MARKER =
  /\b(?:llc|l\.l\.c\.?|incorporated|inc\.?|corp(?:oration)?\.?|company|co\.?|lp|llp|pllc|architects?|engineering|engineers?|construction|builders?|contractors?|electric(?:al)?|mechanical|plumbing|roofing|development|properties|partners|group|services)\b/i;

function looksLikeOrganization(value: string): boolean {
  return ORGANIZATION_MARKER.test(value);
}

function trustedHttpsUrl(value: string, allowedHosts: readonly string[]): string | undefined {
  const candidate = value.trim().replace(/[),.;]+$/, "");
  if (!candidate || candidate.length > 2_048) return undefined;
  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase();
    const allowed = allowedHosts.some((host) => {
      const normalizedHost = host.toLowerCase();
      return hostname === normalizedHost || hostname.endsWith(`.${normalizedHost}`);
    });
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !allowed) {
      return undefined;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function urlCandidates(value: unknown): string[] {
  if (typeof value === "string") {
    return value.match(/https:\/\/[^\s<>"']+/gi) ?? [value];
  }
  if (Array.isArray(value)) return value.flatMap(urlCandidates);
  if (value && typeof value === "object" && "url" in value) {
    return urlCandidates((value as { url?: unknown }).url);
  }
  return [];
}

function mappedUrlDocuments(
  row: StandardizedRow,
  mappings: readonly StandardizedUrlField[],
): ProjectDocument[] {
  return mappings.flatMap((mapping) =>
    urlCandidates(row[mapping.field]).flatMap((candidate) => {
      const url = trustedHttpsUrl(candidate, mapping.allowedHosts);
      return url
        ? [{ name: mapping.name, kind: mapping.kind, url, access: "public" as const }]
        : [];
    }),
  );
}

function requiredIdentity(
  row: StandardizedRow,
  field: string,
  sourceId: string,
): string {
  const identity = textValue(row, field);
  if (!identity) throw new Error(`${sourceId}: source record is missing ${field}.`);
  return identity;
}

function uniqueParticipants(
  row: StandardizedRow,
  fields: readonly StandardizedParticipantField[],
): ProjectParticipant[] {
  const seen = new Set<string>();
  return fields.flatMap((mapping) => {
    const name = textValue(row, mapping.field);
    if (!name || (mapping.organizationOnly && !looksLikeOrganization(name))) return [];
    const key = `${mapping.role}:${name.toLocaleLowerCase("en-US")}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ name, role: mapping.role }];
  });
}

export function mapStandardizedRecord(
  definition: StandardizedSourceDefinition,
  row: StandardizedRow,
  sourceUrl: string,
): ProjectRecord {
  const { mapping, template } = definition;
  const recordId = requiredIdentity(row, mapping.idField, template.id);
  const status = Array.from(
    new Set(
      (mapping.statusFields ?? [mapping.statusField]).flatMap(
        (field) => textValue(row, field) ?? [],
      ),
    ),
  ).join(" / ") || "Status not published";
  const documents = [
    {
      name: mapping.sourceDocumentName,
      kind: mapping.sourceDocumentKind,
      url: sourceUrl,
      access: "public" as const,
      indexStatus: "metadata-only" as const,
    },
    ...mappedUrlDocuments(row, mapping.documentUrlFields),
    ...mappedUrlDocuments(row, mapping.contactUrlFields),
    ...(mapping.supplementalDocuments ?? []),
  ].filter((document, index, all) =>
    all.findIndex((candidate) => candidate.url === document.url) === index,
  );
  const searchableFields = Array.from(
    new Set([
      ...mapping.searchableFields.flatMap(
        (field) => textValue(row, field) ?? [],
      ),
      ...(mapping.sectorFields ?? []).flatMap((field) => {
        const value = textValue(row, field);
        return value
          ? inferredProjectSectorTags(value, { sectorField: true })
          : [];
      }),
    ]),
  );
  const summary = Array.from(
    new Set(mapping.summaryFields.flatMap((field) => textValue(row, field) ?? [])),
  ).join(" · ");

  return {
    id: `${template.id}:${recordId}`,
    sourceId: template.id,
    sourceRecordId: recordId,
    title: firstText(row, mapping.titleFields) ?? `${template.name} ${recordId}`,
    summary,
    stage: mapping.stageResolver?.(row) ?? standardizedPermitStage(status),
    status,
    agency: mapping.agency,
    address: mapping.addressField ? textValue(row, mapping.addressField) : undefined,
    city:
      (mapping.cityField ? textValue(row, mapping.cityField) : undefined) ??
      mapping.defaultCity,
    state:
      (mapping.stateField ? textValue(row, mapping.stateField) : undefined) ??
      mapping.defaultState,
    postalCode: mapping.postalCodeField
      ? textValue(row, mapping.postalCodeField)
      : undefined,
    value: mapping.valueField ? moneyValue(row[mapping.valueField]) : undefined,
    postedAt: firstDate(row, mapping.postedAtFields),
    // Only source-published lifecycle dates are activity. Dataset extraction or
    // request time must never make an old project appear newly active.
    updatedAt: firstDate(row, mapping.updatedAtFields) ?? new Date(0).toISOString(),
    sourceName: template.name,
    sourceUrl,
    provenance: "live-api",
    confidence: "official",
    documents,
    participants: uniqueParticipants(row, mapping.participantFields),
    searchableFields,
    documentTextIndexed: false,
  };
}

function arcgisLiteral(value: string | number, type: FieldValueType): string {
  if (type === "number") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error("ArcGIS cursor is not a safe integer.");
    return String(number);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function arcgisTimestampLiteral(value: string | number): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) throw new Error("ArcGIS date cursor is invalid.");
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) throw new Error("ArcGIS date cursor is invalid.");
  const literal = parsed.toISOString().replace("T", " ").replace("Z", "");
  return `TIMESTAMP '${literal}'`;
}

function quotedCkanIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid CKAN identifier.");
  return `"${value.replace(/"/g, '""')}"`;
}

function ckanLiteral(value: string | number, type: FieldValueType): string {
  if (type === "number") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error("CKAN cursor is not a safe integer.");
    return String(number);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function cursorTokens(
  definition: StandardizedSourceDefinition,
  lane: StandardizedIngestionLane,
  cursor: SourceCursorRecord,
): { uniqueId?: number; sortValue?: string | number } {
  const offset = normalizedOffset(cursor.offset);
  const rawUniqueId = cursor.lastRecordUniqueId;
  const uniqueId =
    rawUniqueId === undefined || rawUniqueId === null ? undefined : Number(rawUniqueId);
  if (uniqueId !== undefined && !Number.isSafeInteger(uniqueId)) {
    throw new Error(`${definition.template.name}: invalid internal-ID cursor.`);
  }
  const sortValue = cursor.lastRecordSortValue;
  const hasSort =
    (typeof sortValue === "string" && sortValue.trim().length > 0) ||
    (typeof sortValue === "number" && Number.isFinite(sortValue));
  const refreshAfter = cursor.refreshAfter === true;
  const inconsistentBackfill =
    lane === "backfill" &&
    (refreshAfter || hasSort || (offset === 0 && uniqueId !== undefined) ||
      (offset > 0 && uniqueId === undefined));
  const inconsistentRefreshWatermark =
    lane === "refresh" &&
    refreshAfter &&
    (offset !== 0 || uniqueId === undefined || !hasSort);
  const inconsistentLegacyRefresh =
    lane === "refresh" &&
    !refreshAfter &&
    ((offset === 0 && (uniqueId !== undefined || hasSort)) ||
      (offset > 0 && (uniqueId === undefined || !hasSort)));
  if (inconsistentBackfill || inconsistentRefreshWatermark || inconsistentLegacyRefresh) {
    throw new Error(`${definition.template.name}: inconsistent continuation cursor.`);
  }
  if (!hasSort) return { uniqueId };
  if (definition.refreshSortType === "number") {
    const number = Number(sortValue);
    if (!Number.isFinite(number)) {
      throw new Error(`${definition.template.name}: invalid numeric sort cursor.`);
    }
    return { uniqueId, sortValue: number };
  }
  if (typeof sortValue !== "string") {
    throw new Error(`${definition.template.name}: invalid text sort cursor.`);
  }
  return { uniqueId, sortValue: sortValue.trim() };
}

function arcgisWhere(
  definition: ArcgisStandardizedSourceDefinition,
  lane: StandardizedIngestionLane,
  cursor: SourceCursorRecord,
  baseWhere = definition.baseWhere,
): string {
  const { uniqueId, sortValue } = cursorTokens(definition, lane, cursor);
  const clauses = [baseWhere];
  if (lane === "backfill" && uniqueId !== undefined) {
    clauses.push(`${definition.internalIdField} > ${arcgisLiteral(uniqueId, "number")}`);
  }
  if (lane === "refresh") {
    clauses.push(`${definition.refreshSortField} IS NOT NULL`);
    if (definition.refreshSortKind === "lifecycle-date") {
      const ceiling = new Date(Date.now() + LIFECYCLE_DATE_CLOCK_SKEW_MS)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      clauses.push(`${definition.refreshSortField} <= TIMESTAMP '${ceiling}'`);
    }
    if (uniqueId !== undefined && sortValue !== undefined) {
      const comparison = cursor.refreshAfter === true ? ">" : "<";
      if (definition.refreshSortField === definition.internalIdField) {
        clauses.push(
          `${definition.refreshSortField} ${comparison} ${arcgisLiteral(sortValue, definition.refreshSortType)}`,
        );
        return clauses.filter(Boolean).map((clause) => `(${clause})`).join(" AND ");
      }
      const sort =
        definition.refreshSortKind === "lifecycle-date"
          ? arcgisTimestampLiteral(sortValue)
          : arcgisLiteral(sortValue, definition.refreshSortType);
      clauses.push(
        `(${definition.refreshSortField} ${comparison} ${sort} OR (${definition.refreshSortField} = ${sort} AND ${definition.internalIdField} > ${arcgisLiteral(uniqueId, "number")}))`,
      );
    }
  }
  return clauses.filter(Boolean).map((clause) => `(${clause})`).join(" AND ");
}

function arcgisQueryUrl(
  definition: ArcgisStandardizedSourceDefinition,
  where: string,
  orderByFields: string,
  limit: number,
): string {
  const params = new URLSearchParams({
    where,
    outFields: definition.selectFields.join(","),
    returnGeometry: "false",
    orderByFields,
    resultOffset: "0",
    resultRecordCount: String(limit),
    f: "json",
  });
  return `${definition.layerUrl}/query?${params}`;
}

function arcgisGroupedMaxInternalIdUrl(
  definition: ArcgisStandardizedSourceDefinition,
  where: string,
  groupCount: number,
): string {
  const params = new URLSearchParams({
    where,
    outStatistics: JSON.stringify([
      {
        statisticType: "max",
        onStatisticField: definition.internalIdField,
        outStatisticFieldName: DUPLICATE_HYDRATION_MAX_ID_FIELD,
      },
    ]),
    groupByFieldsForStatistics: definition.mapping.idField,
    orderByFields: `${definition.mapping.idField} ASC`,
    returnGeometry: "false",
    resultOffset: "0",
    resultRecordCount: String(groupCount + PAGE_LOOKAHEAD),
    f: "json",
  });
  return `${definition.layerUrl}/query?${params}`;
}

function arcgisExactUrl(
  definition: ArcgisStandardizedSourceDefinition,
  recordId: string,
): string {
  const identityType =
    definition.mapping.idField === definition.internalIdField
      ? definition.internalIdType
      : "text";
  const where = `${definition.mapping.idField} = ${arcgisLiteral(recordId, identityType)}`;
  return arcgisQueryUrl(
    definition,
    where,
    `${definition.internalIdField} ${
      definition.duplicateIdentityPolicy === "newest-internal-id" ? "DESC" : "ASC"
    }`,
    2,
  );
}

function ckanSelect(definition: CkanStandardizedSourceDefinition): string {
  return definition.selectFields.map(quotedCkanIdentifier).join(", ");
}

function ckanSqlUrl(definition: CkanStandardizedSourceDefinition, sql: string): string {
  const params = new URLSearchParams({ sql });
  return `${definition.apiRoot}/datastore_search_sql?${params}`;
}

function ckanPageSql(
  definition: CkanStandardizedSourceDefinition,
  lane: StandardizedIngestionLane,
  cursor: SourceCursorRecord,
  limit: number,
  baseWhere = definition.baseWhere,
): string {
  const { uniqueId, sortValue } = cursorTokens(definition, lane, cursor);
  const clauses = [baseWhere];
  if (lane === "backfill" && uniqueId !== undefined) {
    clauses.push(
      `${quotedCkanIdentifier(definition.internalIdField)} > ${ckanLiteral(uniqueId, "number")}`,
    );
  }
  if (lane === "refresh") {
    const sortField = quotedCkanIdentifier(definition.refreshSortField);
    const idField = quotedCkanIdentifier(definition.internalIdField);
    clauses.push(`${sortField} IS NOT NULL`);
    if (definition.refreshSortKind === "lifecycle-date") {
      const ceiling = new Date(Date.now() + LIFECYCLE_DATE_CLOCK_SKEW_MS)
        .toISOString()
        .slice(0, 19);
      clauses.push(`${sortField} <= ${ckanLiteral(ceiling, definition.refreshSortType)}`);
    }
    if (uniqueId !== undefined && sortValue !== undefined) {
      const sort = ckanLiteral(sortValue, definition.refreshSortType);
      const comparison = cursor.refreshAfter === true ? ">" : "<";
      clauses.push(
        `(${sortField} ${comparison} ${sort} OR (${sortField} = ${sort} AND ${idField} > ${ckanLiteral(uniqueId, "number")}))`,
      );
    }
  }
  const order =
    lane === "refresh"
      ? `${quotedCkanIdentifier(definition.refreshSortField)} ${cursor.refreshAfter === true ? "ASC" : "DESC"}, ${quotedCkanIdentifier(definition.internalIdField)} ASC`
      : `${quotedCkanIdentifier(definition.internalIdField)} ASC`;
  return `SELECT ${ckanSelect(definition)} FROM ${quotedCkanIdentifier(definition.resourceId)} WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT ${limit}`;
}

function ckanExactUrl(
  definition: CkanStandardizedSourceDefinition,
  recordId: string,
): string {
  const identityType =
    definition.mapping.idField === definition.internalIdField
      ? definition.internalIdType
      : "text";
  const sql = `SELECT ${ckanSelect(definition)} FROM ${quotedCkanIdentifier(definition.resourceId)} WHERE ${quotedCkanIdentifier(definition.mapping.idField)} = ${ckanLiteral(recordId, identityType)} ORDER BY ${quotedCkanIdentifier(definition.internalIdField)} ASC LIMIT 2`;
  return ckanSqlUrl(definition, sql);
}

function cartoSelect(definition: CartoStandardizedSourceDefinition): string {
  return [
    ...definition.selectFields.map(quotedCkanIdentifier),
    ...(definition.refreshSortExpression
      ? [`${definition.refreshSortExpression} AS ${quotedCkanIdentifier(definition.refreshSortField)}`]
      : []),
  ].join(", ");
}

function cartoSqlUrl(definition: CartoStandardizedSourceDefinition, sql: string): string {
  const params = new URLSearchParams({ q: sql });
  return `${definition.apiRoot}?${params}`;
}

function cartoPageSql(
  definition: CartoStandardizedSourceDefinition,
  lane: StandardizedIngestionLane,
  cursor: SourceCursorRecord,
  limit: number,
  baseWhere = definition.baseWhere,
): string {
  const { uniqueId, sortValue } = cursorTokens(definition, lane, cursor);
  const clauses = [baseWhere];
  const idField = quotedCkanIdentifier(definition.internalIdField);
  const sortField = definition.refreshSortExpression
    ? `(${definition.refreshSortExpression})`
    : quotedCkanIdentifier(definition.refreshSortField);
  if (lane === "backfill" && uniqueId !== undefined) {
    clauses.push(`${idField} > ${ckanLiteral(uniqueId, "number")}`);
  }
  if (lane === "refresh") {
    clauses.push(`${sortField} IS NOT NULL`);
    if (definition.refreshSortKind === "lifecycle-date") {
      const ceiling = new Date(Date.now() + LIFECYCLE_DATE_CLOCK_SKEW_MS)
        .toISOString()
        .slice(0, 19);
      clauses.push(`${sortField} <= ${ckanLiteral(ceiling, definition.refreshSortType)}`);
    }
    if (uniqueId !== undefined && sortValue !== undefined) {
      const sort = ckanLiteral(sortValue, definition.refreshSortType);
      const comparison = cursor.refreshAfter === true ? ">" : "<";
      clauses.push(
        `(${sortField} ${comparison} ${sort} OR (${sortField} = ${sort} AND ${idField} > ${ckanLiteral(uniqueId, "number")}))`,
      );
    }
  }
  const order =
    lane === "refresh"
      ? `${sortField} ${cursor.refreshAfter === true ? "ASC" : "DESC"}, ${idField} ASC`
      : `${idField} ASC`;
  return `SELECT ${cartoSelect(definition)} FROM ${quotedCkanIdentifier(definition.table)} WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT ${limit}`;
}

function cartoExactUrl(
  definition: CartoStandardizedSourceDefinition,
  recordId: string,
): string {
  const identityType =
    definition.mapping.idField === definition.internalIdField
      ? definition.internalIdType
      : "text";
  const sql = `SELECT ${cartoSelect(definition)} FROM ${quotedCkanIdentifier(definition.table)} WHERE ${quotedCkanIdentifier(definition.mapping.idField)} = ${ckanLiteral(recordId, identityType)} ORDER BY ${quotedCkanIdentifier(definition.internalIdField)} ASC LIMIT 2`;
  return cartoSqlUrl(definition, sql);
}

function internalId(
  definition: StandardizedSourceDefinition,
  row: StandardizedRow,
): number {
  const id = Number(row[definition.internalIdField]);
  if (!Number.isSafeInteger(id)) {
    throw new Error(`${definition.template.name}: response omitted a safe internal ID.`);
  }
  return id;
}

function comparableSortValue(
  definition: StandardizedSourceDefinition,
  row: StandardizedRow,
): string | number {
  const value = row[definition.refreshSortField];
  if (definition.refreshSortType === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`${definition.template.name}: response omitted its refresh sort value.`);
    }
    return number;
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${definition.template.name}: response omitted its refresh sort value.`);
  return text;
}

function compareSortValues(
  definition: StandardizedSourceDefinition,
  left: string | number,
  right: string | number,
): number {
  if (definition.refreshSortType === "number") {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }
  const leftText = String(left);
  const rightText = String(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

function validateDeterministicOrder(
  definition: StandardizedSourceDefinition,
  lane: StandardizedIngestionLane,
  requestedCursor: SourceCursorRecord,
  rows: StandardizedRow[],
): void {
  for (let index = 1; index < rows.length; index += 1) {
    const previousId = internalId(definition, rows[index - 1]);
    const currentId = internalId(definition, rows[index]);
    if (lane === "backfill") {
      if (currentId <= previousId) {
        throw new Error(`${definition.template.name}: internal IDs are not strictly ascending.`);
      }
      continue;
    }
    const previousSort = comparableSortValue(definition, rows[index - 1]);
    const currentSort = comparableSortValue(definition, rows[index]);
    const comparison = compareSortValues(definition, currentSort, previousSort);
    const refreshAscending = requestedCursor.refreshAfter === true;
    const sortOutOfOrder = refreshAscending ? comparison < 0 : comparison > 0;
    if (sortOutOfOrder || (comparison === 0 && currentId <= previousId)) {
      throw new Error(`${definition.template.name}: refresh rows are not deterministically ordered.`);
    }
  }
}

function validateContinuationBoundary(
  definition: StandardizedSourceDefinition,
  lane: StandardizedIngestionLane,
  requestedCursor: SourceCursorRecord,
  rows: StandardizedRow[],
): void {
  const firstRow = rows[0];
  if (!firstRow) return;
  const { uniqueId, sortValue } = cursorTokens(definition, lane, requestedCursor);
  if (uniqueId === undefined) return;
  const firstId = internalId(definition, firstRow);
  if (lane === "backfill") {
    if (firstId <= uniqueId) {
      throw new Error(`${definition.template.name}: response did not advance the internal-ID cursor.`);
    }
    return;
  }
  if (sortValue === undefined) {
    throw new Error(`${definition.template.name}: refresh cursor omitted its sort value.`);
  }
  const firstSort = comparableSortValue(definition, firstRow);
  const comparison = compareSortValues(definition, firstSort, sortValue);
  const refreshAscending = requestedCursor.refreshAfter === true;
  const sortDidNotAdvance = refreshAscending ? comparison < 0 : comparison > 0;
  if (sortDidNotAdvance || (comparison === 0 && firstId <= uniqueId)) {
    throw new Error(`${definition.template.name}: response did not advance the refresh cursor.`);
  }
}

function uniqueMappedProjects(
  definition: StandardizedSourceDefinition,
  rows: StandardizedRow[],
): ProjectRecord[] {
  const selected = new Map<string, StandardizedRow>();
  for (const row of rows) {
    const recordId = requiredIdentity(row, definition.mapping.idField, definition.template.id);
    const existing = selected.get(recordId);
    if (existing && definition.duplicateIdentityPolicy !== "newest-internal-id") {
      throw new Error(`${definition.template.name}: duplicate source identity ${recordId}.`);
    }
    if (!existing || internalId(definition, row) > internalId(definition, existing)) {
      selected.set(recordId, row);
    }
  }
  return [...selected.entries()].map(([recordId, row]) => {
    const sourceUrl = definition.platform === "arcgis"
      ? arcgisExactUrl(definition, recordId)
      : definition.platform === "ckan"
        ? ckanExactUrl(definition, recordId)
        : cartoExactUrl(definition, recordId);
    return mapStandardizedRecord(
      definition,
      row,
      definition.recordUrl?.(row) ?? sourceUrl,
    );
  });
}

async function hydrateNewestDuplicateIdentityRows(
  definition: ArcgisStandardizedSourceDefinition,
  pageRows: StandardizedRow[],
  dependencies: StandardizedRequestDependencies,
): Promise<StandardizedRow[]> {
  if (definition.duplicateIdentityPolicy !== "newest-internal-id" || pageRows.length === 0) {
    return pageRows;
  }
  const identityOrder = Array.from(
    new Set(
      pageRows.map((row) =>
        requiredIdentity(row, definition.mapping.idField, definition.template.id),
      ),
    ),
  );
  const identityType =
    definition.mapping.idField === definition.internalIdField
      ? definition.internalIdType
      : "text";
  const where = `${definition.mapping.idField} IN (${identityOrder
    .map((identity) => arcgisLiteral(identity, identityType))
    .join(", ")})`;
  const groupedValue = await fetchOfficialJsonWithRetry(
    arcgisGroupedMaxInternalIdUrl(definition, where, identityOrder.length),
    dependencies,
  );
  const grouped = arcgisRows(groupedValue, definition.template.name);
  if (grouped.exceededTransferLimit) {
    throw new Error(
      `${definition.template.name}: grouped duplicate-identity hydration was truncated.`,
    );
  }
  const requested = new Set(identityOrder);
  const newestInternalIdByIdentity = new Map<string, number>();
  for (const row of grouped.rows) {
    const identity = requiredIdentity(
      row,
      definition.mapping.idField,
      definition.template.id,
    );
    if (!requested.has(identity)) {
      throw new Error(
        `${definition.template.name}: duplicate-identity hydration returned an unrequested identity.`,
      );
    }
    if (newestInternalIdByIdentity.has(identity)) {
      throw new Error(
        `${definition.template.name}: grouped duplicate-identity hydration repeated an application.`,
      );
    }
    const newestInternalId = Number(row[DUPLICATE_HYDRATION_MAX_ID_FIELD]);
    if (!Number.isSafeInteger(newestInternalId)) {
      throw new Error(
        `${definition.template.name}: grouped duplicate-identity hydration omitted a safe maximum internal ID.`,
      );
    }
    newestInternalIdByIdentity.set(identity, newestInternalId);
  }
  if (newestInternalIdByIdentity.size !== identityOrder.length) {
    throw new Error(
      `${definition.template.name}: grouped duplicate-identity hydration omitted a requested application.`,
    );
  }

  const newestInternalIds = identityOrder.map(
    (identity) => newestInternalIdByIdentity.get(identity)!,
  );
  const requestedInternalIds = new Set(newestInternalIds);
  if (requestedInternalIds.size !== newestInternalIds.length) {
    throw new Error(
      `${definition.template.name}: grouped duplicate-identity hydration reused an internal ID for multiple applications.`,
    );
  }
  const expectedIdentityByInternalId = new Map(
    identityOrder.map((identity, index) => [newestInternalIds[index], identity]),
  );
  const exactWhere = `${definition.internalIdField} IN (${newestInternalIds
    .map((internalIdValue) => arcgisLiteral(internalIdValue, definition.internalIdType))
    .join(", ")})`;
  const exactValue = await fetchOfficialJsonWithRetry(
    arcgisQueryUrl(
      definition,
      exactWhere,
      `${definition.internalIdField} ASC`,
      newestInternalIds.length + PAGE_LOOKAHEAD,
    ),
    dependencies,
  );
  const exact = arcgisRows(exactValue, definition.template.name);
  if (exact.exceededTransferLimit) {
    throw new Error(
      `${definition.template.name}: exact duplicate-identity hydration was truncated.`,
    );
  }
  const rowsByInternalId = new Map<number, StandardizedRow>();
  for (const row of exact.rows) {
    const rowInternalId = internalId(definition, row);
    const expectedIdentity = expectedIdentityByInternalId.get(rowInternalId);
    if (!expectedIdentity) {
      throw new Error(
        `${definition.template.name}: exact duplicate-identity hydration returned an unrequested internal ID.`,
      );
    }
    if (rowsByInternalId.has(rowInternalId)) {
      throw new Error(
        `${definition.template.name}: exact duplicate-identity hydration repeated an internal ID.`,
      );
    }
    const identity = requiredIdentity(
      row,
      definition.mapping.idField,
      definition.template.id,
    );
    if (identity !== expectedIdentity) {
      throw new Error(
        `${definition.template.name}: exact duplicate-identity hydration returned an identity that did not match its grouped maximum.`,
      );
    }
    rowsByInternalId.set(rowInternalId, row);
  }
  if (rowsByInternalId.size !== requestedInternalIds.size) {
    throw new Error(
      `${definition.template.name}: exact duplicate-identity hydration omitted a requested internal ID.`,
    );
  }
  // Preserve the stable identity order from the cursor page. A later
  // continuation can encounter an older duplicate row, but it will emit the
  // same newest canonical row and can never regress the persisted project.
  return newestInternalIds.map((internalIdValue) => rowsByInternalId.get(internalIdValue)!);
}

function pageRecord(
  definition: StandardizedSourceDefinition,
  lane: StandardizedIngestionLane,
  requestedCursor: SourceCursorRecord,
  rows: StandardizedRow[],
  hasMore: boolean,
): SourcePageRecord {
  const offset = normalizedOffset(requestedCursor.offset);
  const refreshWatermark = lane === "refresh" && requestedCursor.refreshAfter === true;
  const initialRefreshHead = lane === "refresh" && !refreshWatermark && offset === 0;
  const boundaryRow = initialRefreshHead ? rows[0] : rows.at(-1);
  const nextCursor: SourceCursorRecord =
    lane === "refresh" && boundaryRow && (initialRefreshHead || refreshWatermark)
      ? {
          offset: 0,
          refreshAfter: true,
          lastRecordUniqueId: internalId(definition, boundaryRow),
          lastRecordSortValue: comparableSortValue(definition, boundaryRow),
        }
      : refreshWatermark && !boundaryRow
        ? { ...requestedCursor, offset: 0, refreshAfter: true }
        : hasMore && boundaryRow
      ? {
          offset: offset + rows.length,
          lastRecordUniqueId: internalId(definition, boundaryRow),
          ...(lane === "refresh"
            ? { lastRecordSortValue: comparableSortValue(definition, boundaryRow) }
            : {}),
        }
      : { offset: 0 };
  const pageHasMore = initialRefreshHead ? false : hasMore;
  return {
    offset,
    recordsRead: rows.length,
    nextOffset: nextCursor.offset,
    hasMore: pageHasMore,
    currentCursor: { ...requestedCursor, offset },
    nextCursor,
  };
}

function liveSourceRecord(
  definition: StandardizedSourceDefinition,
  total: number,
  loaded: number,
  rowsRead: number,
  lane: StandardizedIngestionLane,
  hasMore: boolean,
): SourceRecord {
  const loadSummary = definition.duplicateIdentityPolicy === "newest-internal-id"
    ? `${rowsRead.toLocaleString("en-US")} source rows read and ${loaded.toLocaleString("en-US")} unique application projects loaded in this ${lane} page`
    : `${loaded.toLocaleString("en-US")} loaded in this ${lane} page`;
  const universeLabel = definition.duplicateIdentityPolicy === "newest-internal-id"
    ? "source rows (application numbers can repeat)"
    : "records";
  return {
    ...definition.template,
    status: "live",
    recordCount: total,
    loadedCount: loaded,
    snapshotComplete: lane === "backfill" && !hasMore,
    lastChecked: new Date().toISOString(),
    note: `${definition.template.note} The source reports ${total.toLocaleString("en-US")} ${universeLabel} in this adapter's defined local universe; ${loadSummary}.`,
  };
}

type ArcgisFeatureResponse = {
  features?: Array<{ attributes?: StandardizedRow }>;
  exceededTransferLimit?: boolean;
  error?: { message?: string; details?: string[] };
};

function arcgisRows(value: unknown, sourceName: string): {
  rows: StandardizedRow[];
  exceededTransferLimit: boolean;
} {
  const data = value as ArcgisFeatureResponse;
  if (data?.error) {
    throw new Error(
      `${sourceName}: ${[data.error.message, ...(data.error.details ?? [])].filter(Boolean).join(" ")}`,
    );
  }
  if (!Array.isArray(data?.features)) {
    throw new Error(`${sourceName}: ArcGIS response omitted features.`);
  }
  return {
    rows: data.features.map((feature) => {
      if (!feature.attributes || typeof feature.attributes !== "object") {
        throw new Error(`${sourceName}: ArcGIS feature omitted attributes.`);
      }
      return feature.attributes;
    }),
    exceededTransferLimit: data.exceededTransferLimit === true,
  };
}

function ckanRows(value: unknown, sourceName: string): StandardizedRow[] {
  const data = value as {
    success?: boolean;
    result?: { records?: StandardizedRow[] };
    error?: { message?: string; __type?: string };
  };
  if (data?.success !== true || !Array.isArray(data.result?.records)) {
    throw new Error(
      `${sourceName}: ${data?.error?.message ?? data?.error?.__type ?? "CKAN response omitted records."}`,
    );
  }
  return data.result.records;
}

function cartoRows(value: unknown, sourceName: string): StandardizedRow[] {
  const data = value as {
    rows?: StandardizedRow[];
    error?: string;
  };
  if (!Array.isArray(data?.rows)) {
    throw new Error(`${sourceName}: ${data?.error ?? "Carto response omitted rows."}`);
  }
  return data.rows;
}

function sourceScopeWhere(
  definition: StandardizedSourceDefinition,
  mode: StandardizedFeedMode,
): string {
  return mode === "view" && definition.viewWhere
    ? `(${definition.baseWhere}) AND (${definition.viewWhere})`
    : definition.baseWhere;
}

async function fetchArcgisSource(
  definition: ArcgisStandardizedSourceDefinition,
  mode: StandardizedFeedMode,
  lane: StandardizedIngestionLane,
  requestedCursor: SourceCursorRecord,
  dependencies: StandardizedRequestDependencies,
): Promise<StandardizedConnectorResult> {
  cursorTokens(definition, lane, requestedCursor);
  const pageSize = mode === "ingest" ? INGEST_PAGE_SIZE : VIEW_PAGE_SIZE;
  const scopeWhere = sourceScopeWhere(definition, mode);
  const where = arcgisWhere(definition, lane, requestedCursor, scopeWhere);
  const order =
    lane === "refresh"
      ? definition.refreshSortField === definition.internalIdField
        ? `${definition.refreshSortField} ${requestedCursor.refreshAfter === true ? "ASC" : "DESC"}`
        : `${definition.refreshSortField} ${requestedCursor.refreshAfter === true ? "ASC" : "DESC"}, ${definition.internalIdField} ASC`
      : `${definition.internalIdField} ASC`;
  const countParams = new URLSearchParams({
    where: scopeWhere,
    returnCountOnly: "true",
    f: "json",
  });
  const [countValue, pageValue] = await Promise.all([
    fetchOfficialJsonWithRetry(`${definition.layerUrl}/query?${countParams}`, dependencies),
    fetchOfficialJsonWithRetry(
      arcgisQueryUrl(definition, where, order, pageSize + PAGE_LOOKAHEAD),
      dependencies,
    ),
  ]);
  const countData = countValue as { count?: unknown; error?: { message?: string } };
  const total = Number(countData?.count);
  if (!Number.isInteger(total) || total < 0 || countData?.error) {
    throw new Error(`${definition.template.name}: ArcGIS count response was invalid.`);
  }
  const fetched = arcgisRows(pageValue, definition.template.name);
  if (fetched.rows.length > pageSize + PAGE_LOOKAHEAD) {
    throw new Error(`${definition.template.name}: ArcGIS returned more rows than requested.`);
  }
  if (fetched.exceededTransferLimit && fetched.rows.length <= pageSize) {
    throw new Error(`${definition.template.name}: ArcGIS truncated a short page.`);
  }
  validateDeterministicOrder(definition, lane, requestedCursor, fetched.rows);
  validateContinuationBoundary(definition, lane, requestedCursor, fetched.rows);
  const hasMore = fetched.rows.length > pageSize;
  const rows = fetched.rows.slice(0, pageSize);
  const canonicalRows = await hydrateNewestDuplicateIdentityRows(
    definition,
    rows,
    dependencies,
  );
  const projects = uniqueMappedProjects(definition, canonicalRows);
  const page = pageRecord(definition, lane, requestedCursor, rows, hasMore);
  return {
    projects,
    source: liveSourceRecord(
      definition,
      total,
      projects.length,
      rows.length,
      lane,
      hasMore,
    ),
    page,
  };
}

async function fetchCkanSource(
  definition: CkanStandardizedSourceDefinition,
  mode: StandardizedFeedMode,
  lane: StandardizedIngestionLane,
  requestedCursor: SourceCursorRecord,
  dependencies: StandardizedRequestDependencies,
): Promise<StandardizedConnectorResult> {
  cursorTokens(definition, lane, requestedCursor);
  const pageSize = mode === "ingest" ? INGEST_PAGE_SIZE : VIEW_PAGE_SIZE;
  const scopeWhere = sourceScopeWhere(definition, mode);
  const countSql = `SELECT count(*) AS total FROM ${quotedCkanIdentifier(definition.resourceId)} WHERE ${scopeWhere}`;
  const pageSql = ckanPageSql(
    definition,
    lane,
    requestedCursor,
    pageSize + PAGE_LOOKAHEAD,
    scopeWhere,
  );
  const [countValue, pageValue] = await Promise.all([
    fetchOfficialJsonWithRetry(ckanSqlUrl(definition, countSql), dependencies),
    fetchOfficialJsonWithRetry(ckanSqlUrl(definition, pageSql), dependencies),
  ]);
  const countRows = ckanRows(countValue, definition.template.name);
  const total = Number(countRows[0]?.total);
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`${definition.template.name}: CKAN count response was invalid.`);
  }
  const fetchedRows = ckanRows(pageValue, definition.template.name);
  if (fetchedRows.length > pageSize + PAGE_LOOKAHEAD) {
    throw new Error(`${definition.template.name}: CKAN returned more rows than requested.`);
  }
  validateDeterministicOrder(definition, lane, requestedCursor, fetchedRows);
  validateContinuationBoundary(definition, lane, requestedCursor, fetchedRows);
  const hasMore = fetchedRows.length > pageSize;
  const rows = fetchedRows.slice(0, pageSize);
  const projects = uniqueMappedProjects(definition, rows);
  const page = pageRecord(definition, lane, requestedCursor, rows, hasMore);
  return {
    projects,
    source: liveSourceRecord(
      definition,
      total,
      projects.length,
      rows.length,
      lane,
      hasMore,
    ),
    page,
  };
}

async function fetchCartoSource(
  definition: CartoStandardizedSourceDefinition,
  mode: StandardizedFeedMode,
  lane: StandardizedIngestionLane,
  requestedCursor: SourceCursorRecord,
  dependencies: StandardizedRequestDependencies,
): Promise<StandardizedConnectorResult> {
  cursorTokens(definition, lane, requestedCursor);
  const pageSize = mode === "ingest" ? INGEST_PAGE_SIZE : VIEW_PAGE_SIZE;
  const scopeWhere = sourceScopeWhere(definition, mode);
  const countSql = `SELECT count(*) AS total FROM ${quotedCkanIdentifier(definition.table)} WHERE ${scopeWhere}`;
  const pageSql = cartoPageSql(
    definition,
    lane,
    requestedCursor,
    pageSize + PAGE_LOOKAHEAD,
    scopeWhere,
  );
  const [countValue, pageValue] = await Promise.all([
    fetchOfficialJsonWithRetry(cartoSqlUrl(definition, countSql), dependencies),
    fetchOfficialJsonWithRetry(cartoSqlUrl(definition, pageSql), dependencies),
  ]);
  const countRows = cartoRows(countValue, definition.template.name);
  const total = Number(countRows[0]?.total);
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`${definition.template.name}: Carto count response was invalid.`);
  }
  const fetchedRows = cartoRows(pageValue, definition.template.name);
  if (fetchedRows.length > pageSize + PAGE_LOOKAHEAD) {
    throw new Error(`${definition.template.name}: Carto returned more rows than requested.`);
  }
  validateDeterministicOrder(definition, lane, requestedCursor, fetchedRows);
  validateContinuationBoundary(definition, lane, requestedCursor, fetchedRows);
  const hasMore = fetchedRows.length > pageSize;
  const rows = fetchedRows.slice(0, pageSize);
  const projects = uniqueMappedProjects(definition, rows);
  const page = pageRecord(definition, lane, requestedCursor, rows, hasMore);
  return {
    projects,
    source: liveSourceRecord(
      definition,
      total,
      projects.length,
      rows.length,
      lane,
      hasMore,
    ),
    page,
  };
}

export async function fetchStandardizedSource(
  sourceId: StandardizedSourceId,
  options: StandardizedFeedOptions = {},
): Promise<StandardizedConnectorResult> {
  const definition = STANDARDIZED_SOURCE_DEFINITIONS[sourceId];
  const mode = options.mode ?? "view";
  const lane: StandardizedIngestionLane =
    mode === "view" ? "refresh" : (options.lane ?? "backfill");
  const requestedCursor = options.sourceCursors?.[sourceId] ?? { offset: 0 };
  if (definition.platform === "arcgis") {
    return fetchArcgisSource(definition, mode, lane, requestedCursor, options);
  }
  return definition.platform === "ckan"
    ? fetchCkanSource(definition, mode, lane, requestedCursor, options)
    : fetchCartoSource(definition, mode, lane, requestedCursor, options);
}

function normalizedLookupId(sourceId: StandardizedSourceId, value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240) return undefined;
  const prefix = `${sourceId}:`;
  if (trimmed.includes(":") && !trimmed.startsWith(prefix)) return undefined;
  const recordId = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed;
  return recordId || undefined;
}

export async function lookupStandardizedSourceProject(
  sourceId: StandardizedSourceId,
  projectIdOrRecordId: string,
  dependencies: StandardizedRequestDependencies = {},
): Promise<ProjectRecord | undefined> {
  const definition = STANDARDIZED_SOURCE_DEFINITIONS[sourceId];
  const recordId = normalizedLookupId(sourceId, projectIdOrRecordId);
  if (!recordId) return undefined;
  const sourceUrl = definition.platform === "arcgis"
    ? arcgisExactUrl(definition, recordId)
    : definition.platform === "ckan"
      ? ckanExactUrl(definition, recordId)
      : cartoExactUrl(definition, recordId);
  const value = await fetchOfficialJsonWithRetry(sourceUrl, dependencies);
  const rows = definition.platform === "arcgis"
    ? arcgisRows(value, definition.template.name).rows
    : definition.platform === "ckan"
      ? ckanRows(value, definition.template.name)
      : cartoRows(value, definition.template.name);
  const exactRows = rows.filter(
    (row) => textValue(row, definition.mapping.idField) === recordId,
  );
  if (exactRows.length === 0) return undefined;
  if (
    exactRows.length > 1 &&
    definition.duplicateIdentityPolicy !== "newest-internal-id"
  ) {
    throw new Error(`${definition.template.name}: exact source identity is not unique.`);
  }
  const selectedRow = definition.duplicateIdentityPolicy === "newest-internal-id"
    ? exactRows.reduce((selected, row) =>
        internalId(definition, row) > internalId(definition, selected) ? row : selected,
      )
    : exactRows[0];
  return mapStandardizedRecord(
    definition,
    selectedRow,
    definition.recordUrl?.(selectedRow) ?? sourceUrl,
  );
}

export async function lookupStandardizedProject(
  projectId: string,
  dependencies: StandardizedRequestDependencies = {},
): Promise<ProjectRecord | undefined> {
  const sourceId = STANDARDIZED_SOURCE_IDS.find((candidate) =>
    projectId.startsWith(`${candidate}:`),
  );
  return sourceId
    ? lookupStandardizedSourceProject(sourceId, projectId, dependencies)
    : undefined;
}
