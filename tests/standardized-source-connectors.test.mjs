import assert from "node:assert/strict";
import test from "node:test";

const {
  STANDARDIZED_SOURCE_DEFINITIONS,
  STANDARDIZED_SOURCE_IDS,
  STANDARDIZED_SOURCE_TEMPLATES,
  fetchStandardizedSource,
  lookupStandardizedProject,
  lookupStandardizedSourceProject,
  mapStandardizedRecord,
  standardizedPermitStage,
} = await import("../app/lib/standardized-source-connectors.ts");
const { classifyProjectFreshness } = await import(
  "../app/lib/outreach-intelligence.ts"
);

const TEMPE_SOURCE_ID = "tempe-building-permits-arcgis";
const PITTSBURGH_SOURCE_ID = "pittsburgh-pli-permits-ckan";
const BOSTON_SOURCE_ID = "boston-approved-building-permits-ckan";
const MIAMI_SOURCE_ID = "miami-ibuild-plan-review-arcgis";
const PHILADELPHIA_SOURCE_ID = "philadelphia-li-active-permits-carto";

function tempeRow(objectId, overrides = {}) {
  return {
    OBJECTID: objectId,
    PermitNum: `BP${objectId}`,
    ProjectName: `Tempe project ${objectId}`,
    Description: `Commercial tenant improvement ${objectId}`,
    AppliedDateDtm: Date.UTC(2025, 0, 1),
    IssuedDateDtm: Date.UTC(2025, 1, 1),
    CompletedDateDtm: null,
    StatusDateDtm: Date.UTC(2025, 1, 2) + objectId,
    VoidDateDtm: null,
    StatusCurrent: "Issued",
    OriginalAddress1: `${objectId} W Rio Salado Pkwy`,
    OriginalCity: "Tempe",
    OriginalState: "AZ",
    OriginalZip: "85281",
    PermitClass: "Commercial",
    PermitType: "Building",
    PermitTypeDesc: "Tenant improvement",
    EstProjectCost: 100000 + objectId,
    ContractorCompanyName: "Fixture Construction LLC",
    ...overrides,
  };
}

function pittsburghRow(internalId, overrides = {}) {
  return {
    _id: internalId,
    permit_id: `BP-${internalId}`,
    permit_type: "Building",
    contractor_name: "Fixture Builders Inc.",
    work_description: `Interior renovation ${internalId}`,
    work_type: "Alterations",
    commercial_or_residential: "Commercial",
    total_project_value: 250000 + internalId,
    issue_date: "2025-05-01T00:00:00",
    parcel_num: `0001-${internalId}`,
    address: `${internalId} Liberty Ave`,
    council_district: "1",
    neighborhood: "Downtown",
    ward: "1",
    zip_code: "15222",
    status: "Issued",
    ...overrides,
  };
}

function bostonRow(internalId, overrides = {}) {
  return {
    _id: internalId,
    permitnumber: `ERT${internalId}`,
    worktype: "NEWCON",
    permittypedescr: "Erect/New Construction",
    description: "New construction",
    comments: `Construct a new mixed-use building ${internalId}`,
    declared_valuation: `$${(2_000_000 + internalId).toLocaleString("en-US")}.00`,
    issued_date: "2026-07-15T12:00:00",
    expiration_date: "2027-01-15T00:00:00",
    status: "Open",
    occupancytype: "Mixed",
    sq_feet: 25000,
    address: `${internalId} Washington ST`,
    city: "Boston",
    state: "MA",
    zip: "02108",
    property_id: 1000 + internalId,
    parcel_id: 2000 + internalId,
    ...overrides,
  };
}

function miamiRow(objectId, overrides = {}) {
  return {
    OBJECTID: objectId,
    PermitNumber: null,
    ApplicationNumber: `BD260${String(objectId).padStart(8, "0")}`,
    App: "iBuild",
    ApplicationId: 0,
    PermitStatus: null,
    ADDPTKEY: 12345,
    FULLADDR: `${objectId} NW 1 CT`,
    FOLIO: "0131250500040",
    ApplicationType: "Building Permit",
    Banner: "Building Permit",
    PlanNumber: `BD260${String(objectId).padStart(8, "0")}`,
    MasterPermitStatus: null,
    PermitIssuedDate: null,
    MasterPlanStatus: "Applicant Corrections",
    MasterPermitType: "",
    ScopeOfWork: "NEW CONSTRUCTION",
    MasterPermitNumber: null,
    ProjectName: "",
    COMDISTID: 1,
    NSCA_ID: 2,
    ApplicationStatusDate: null,
    PermitType: "",
    PermitApplicationAddressID: 12345,
    ...overrides,
  };
}

function philadelphiaRow(internalId, overrides = {}) {
  return {
    cartodb_id: internalId,
    permitnumber: `CP-${2026}-${String(internalId).padStart(6, "0")}`,
    permittype: "Building",
    permitdescription: "Commercial Building Permit",
    commercialorresidential: "Commercial",
    typeofwork: "New Construction",
    approvedscopeofwork: `Construct a mixed-use building with canopy ${internalId}`,
    permitissuedate: `2026-07-${String(Math.min(19, internalId)).padStart(2, "0")}T04:00:00Z`,
    lifecycle_activity_date: `2026-07-${String(Math.min(19, internalId)).padStart(2, "0")}T04:00:00Z`,
    status: "Issued",
    applicanttype: "Professional / Tradesperson",
    contractorname: "Fixture Construction LLC",
    mostrecentinsp: null,
    posse_jobid: `100${internalId}`,
    opa_account_num: `001${internalId}`,
    address: `${internalId} MARKET ST`,
    unit_type: null,
    unit_num: null,
    zip: "19107-0000",
    council_district: "1",
    opa_owner: "FIXTURE DEVELOPMENT LLC",
    systemofrecord: "ECLIPSE",
    usecategories: "Retail Sales; Household Living",
    occupancytype: "Mixed Use",
    permitcompleteddate: null,
    numberofunits: 24,
    certificateofoccupancydate: null,
    certificateofoccupancyrequired: "Y",
    parentjobid: null,
    certificateofoccupancylink: null,
    zoningpermitjobid: "ZP-2026-000001",
    numberofstories: 5,
    denialdocumentlink: null,
    areaofdisturbance: 24000,
    denialdate: null,
    ...overrides,
  };
}

function ckanResponse(records) {
  return Response.json({ success: true, result: { records } });
}

function cartoResponse(rows) {
  return Response.json({ rows, total_rows: rows.length });
}

test("standardized source registry is explicitly local and documents source limits", () => {
  assert.deepEqual(STANDARDIZED_SOURCE_IDS, [
    TEMPE_SOURCE_ID,
    PITTSBURGH_SOURCE_ID,
    BOSTON_SOURCE_ID,
    MIAMI_SOURCE_ID,
    PHILADELPHIA_SOURCE_ID,
  ]);
  for (const sourceId of STANDARDIZED_SOURCE_IDS) {
    const template = STANDARDIZED_SOURCE_TEMPLATES[sourceId];
    assert.equal(template.level, "local");
    assert.equal(template.sourceClass, "permits");
    assert.match(template.note, /not (?:a claim of|establish).*national.*completeness/i);
  }
  assert.match(STANDARDIZED_SOURCE_TEMPLATES[PITTSBURGH_SOURCE_ID].note, /excludes plumbing/i);
  assert.match(STANDARDIZED_SOURCE_TEMPLATES[MIAMI_SOURCE_ID].note, /private residential and commercial/i);
  assert.match(STANDARDIZED_SOURCE_TEMPLATES[MIAMI_SOURCE_ID].note, /no ProjectDox drawing files/i);
  assert.equal(STANDARDIZED_SOURCE_TEMPLATES[MIAMI_SOURCE_ID].recordCountUnit, "rows");
  assert.equal(STANDARDIZED_SOURCE_TEMPLATES[PHILADELPHIA_SOURCE_ID].recordCountUnit, "rows");
  assert.match(STANDARDIZED_SOURCE_TEMPLATES[MIAMI_SOURCE_ID].cadence, /every 24 hours/i);
  assert.match(STANDARDIZED_SOURCE_TEMPLATES[MIAMI_SOURCE_ID].note, /upstream publication cadence is not stated/i);
  assert.match(
    STANDARDIZED_SOURCE_TEMPLATES[PHILADELPHIA_SOURCE_ID].note,
    /private residential and commercial/i,
  );
  assert.match(
    STANDARDIZED_SOURCE_TEMPLATES[PHILADELPHIA_SOURCE_ID].note,
    /does not establish that filed plan sheets are publicly downloadable/i,
  );
  assert.match(
    STANDARDIZED_SOURCE_TEMPLATES[PHILADELPHIA_SOURCE_ID].note,
    /building, zoning, and trade-permit rows/i,
  );
  assert.match(
    STANDARDIZED_SOURCE_TEMPLATES[PHILADELPHIA_SOURCE_ID].note,
    /not unique buildings or construction projects/i,
  );
});

test("Philadelphia connector loads the official active and recent-terminal reconciliation universe", async () => {
  const sqlCalls = [];
  const row = philadelphiaRow(19, {
    certificateofoccupancylink:
      "https://eclipse.phila.gov/phillylmsprod/pub/lms/download.aspx?PosseObjectId=19",
    denialdocumentlink: "https://evil.example/decision.pdf",
  });
  const result = await fetchStandardizedSource(PHILADELPHIA_SOURCE_ID, {
    mode: "ingest",
    lane: "backfill",
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, "https://phl.carto.com");
      assert.equal(url.pathname, "/api/v2/sql");
      const sql = url.searchParams.get("q") ?? "";
      sqlCalls.push(sql);
      return /select count\(\*\) as total/i.test(sql)
        ? cartoResponse([{ total: 51828 }])
        : cartoResponse([row]);
    },
  });

  assert.equal(result.source.recordCount, 51828);
  assert.equal(result.source.recordCountUnit, "rows");
  assert.equal(result.projects.length, 1);
  const project = result.projects[0];
  assert.equal(project.id, `${PHILADELPHIA_SOURCE_ID}:${row.permitnumber}`);
  assert.equal(project.stage, "construction");
  assert.equal(project.status, "Issued");
  assert.equal(project.city, "Philadelphia");
  assert.equal(project.state, "PA");
  assert.equal(project.address, "19 MARKET ST");
  assert.equal(project.postedAt, "2026-07-19T04:00:00.000Z");
  const exactSourceUrl = new URL(project.sourceUrl);
  assert.equal(exactSourceUrl.origin, "https://phl.carto.com");
  assert.equal(exactSourceUrl.pathname, "/api/v2/sql");
  assert.match(
    exactSourceUrl.searchParams.get("q") ?? "",
    /WHERE "permitnumber" = 'CP-2026-000019'/,
  );
  assert.ok(project.searchableFields.some((value) => value.includes("canopy")));
  assert.ok(project.searchableFields.includes("commercial"));
  assert.deepEqual(
    project.participants.map(({ name, role }) => ({ name, role })),
    [
      { name: "Fixture Construction LLC", role: "contractor" },
      { name: "FIXTURE DEVELOPMENT LLC", role: "owner" },
    ],
  );
  assert.equal(
    project.documents.some((document) => document.url.includes("evil.example")),
    false,
  );
  assert.equal(
    project.documents.some(
      (document) => document.name === "Published certificate of occupancy",
    ),
    true,
  );
  const planRequestGuide = project.documents.find((document) =>
    document.name.includes("plan-copy request instructions"),
  );
  assert.equal(
    planRequestGuide?.url,
    "https://www.phila.gov/services/permits-violations-licenses/get-a-copy-of-a-license-permit-or-violation/",
  );
  assert.equal(planRequestGuide?.kind, "source-record");
  assert.equal(planRequestGuide?.indexStatus, "metadata-only");
  assert.equal(project.documents.some((document) => document.kind === "plans"), false);
  const pageSql = sqlCalls.find((sql) => !/select count\(\*\) as total/i.test(sql));
  assert.match(pageSql, /FROM "permits"/);
  assert.match(pageSql, /permitcompleteddate IS NULL/);
  assert.match(pageSql, /certificateofoccupancydate IS NULL/);
  assert.match(pageSql, /status IN \('Issued','Stop Work','Amendment Application Incomplete'/);
  assert.match(pageSql, /permitcompleteddate >= current_date - interval '180 days'/);
  assert.match(pageSql, /certificateofoccupancydate >= current_date - interval '180 days'/);
  assert.match(pageSql, /denialdate >= current_date - interval '180 days'/);
  assert.match(pageSql, /permitissuedate >= current_date - interval '5 years'/);
  assert.match(pageSql, /ORDER BY "cartodb_id" ASC LIMIT 51$/);
});

test("Philadelphia dashboard view is active-only while backfill reconciles a later completion", async () => {
  const calls = [];
  let row = philadelphiaRow(25);
  const fetchImpl = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const sql = url.searchParams.get("q") ?? "";
    calls.push(sql);
    return /select count\(\*\) as total/i.test(sql)
      ? cartoResponse([{ total: 1 }])
      : cartoResponse([row]);
  };

  const activeView = await fetchStandardizedSource(PHILADELPHIA_SOURCE_ID, {
    mode: "view",
    fetchImpl,
  });
  assert.equal(activeView.projects[0].stage, "construction");
  const viewPageSql = calls.find((sql) => !/select count\(\*\) as total/i.test(sql));
  assert.match(viewPageSql, /permitcompleteddate IS NULL/);
  assert.match(
    viewPageSql,
    /ORDER BY \(greatest\(permitissuedate, permitcompleteddate, mostrecentinsp, certificateofoccupancydate, denialdate\)\) DESC, "cartodb_id" ASC LIMIT 41$/,
  );

  calls.length = 0;
  row = philadelphiaRow(25, {
    status: "Completed",
    permitcompleteddate: "2026-07-20T16:30:00Z",
    lifecycle_activity_date: "2026-07-20T16:30:00Z",
    // The issue date and source identity do not change when the lifecycle does.
    permitissuedate: "2026-07-19T04:00:00Z",
  });
  const reconciled = await fetchStandardizedSource(PHILADELPHIA_SOURCE_ID, {
    mode: "ingest",
    lane: "backfill",
    fetchImpl,
  });
  assert.equal(reconciled.projects[0].id, activeView.projects[0].id);
  assert.equal(reconciled.projects[0].stage, "completed");
  assert.equal(reconciled.projects[0].status, "Completed");
  assert.equal(reconciled.projects[0].updatedAt, "2026-07-20T16:30:00.000Z");
  const backfillPageSql = calls.find((sql) => !/select count\(\*\) as total/i.test(sql));
  assert.match(backfillPageSql, /permitcompleteddate >= current_date - interval '180 days'/);
});

test("Philadelphia forward refresh catches a completion behind the backfill cursor", async () => {
  const calls = [];
  const active = philadelphiaRow(25, {
    permitissuedate: "2026-07-19T04:00:00Z",
    lifecycle_activity_date: "2026-07-19T04:00:00Z",
  });
  let rows = [active];
  const fetchImpl = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const sql = url.searchParams.get("q") ?? "";
    calls.push(sql);
    return /select count\(\*\) as total/i.test(sql)
      ? cartoResponse([{ total: 1 }])
      : cartoResponse(rows);
  };
  const head = await fetchStandardizedSource(PHILADELPHIA_SOURCE_ID, {
    mode: "ingest",
    lane: "refresh",
    fetchImpl,
  });
  assert.deepEqual(head.page.nextCursor, {
    offset: 0,
    refreshAfter: true,
    lastRecordUniqueId: 25,
    lastRecordSortValue: "2026-07-19T04:00:00Z",
  });

  calls.length = 0;
  rows = [philadelphiaRow(25, {
    status: "Completed",
    permitissuedate: active.permitissuedate,
    permitcompleteddate: "2026-07-20T16:30:00Z",
    lifecycle_activity_date: "2026-07-20T16:30:00Z",
  })];
  const delta = await fetchStandardizedSource(PHILADELPHIA_SOURCE_ID, {
    mode: "ingest",
    lane: "refresh",
    sourceCursors: { [PHILADELPHIA_SOURCE_ID]: head.page.nextCursor },
    fetchImpl,
  });
  assert.equal(delta.projects[0].id, head.projects[0].id);
  assert.equal(delta.projects[0].stage, "completed");
  assert.equal(delta.projects[0].updatedAt, "2026-07-20T16:30:00.000Z");
  assert.equal(delta.page.nextCursor.lastRecordUniqueId, 25);
  assert.equal(delta.page.nextCursor.lastRecordSortValue, "2026-07-20T16:30:00Z");
  const deltaSql = calls.find((sql) => !/select count\(\*\) as total/i.test(sql));
  assert.match(
    deltaSql,
    /greatest\(permitissuedate, permitcompleteddate, mostrecentinsp, certificateofoccupancydate, denialdate\).* > '2026-07-19T04:00:00Z'/,
  );
});

test("Philadelphia stages amendments before construction and never promotes personal owner names", () => {
  const definition = STANDARDIZED_SOURCE_DEFINITIONS[PHILADELPHIA_SOURCE_ID];
  const map = (overrides) =>
    mapStandardizedRecord(
      definition,
      philadelphiaRow(18, overrides),
      "https://phl.carto.com/api/v2/sql?q=fixture",
    );
  assert.equal(map({ status: "Amendment Review" }).stage, "design");
  assert.equal(map({ status: "Amendment Ready For Issue" }).stage, "permitting");
  assert.equal(map({ status: "Stop Work" }).stage, "construction");
  assert.equal(map({ status: "Refused", permitcompleteddate: "2026-07-20T00:00:00Z" }).stage, "cancelled");
  assert.equal(
    map({
      status: "Issued",
      certificateofoccupancydate: "2026-07-20T00:00:00Z",
      lifecycle_activity_date: "2026-07-20T00:00:00Z",
    }).stage,
    "completed",
  );
  const personalOwner = map({ opa_owner: "Jane Doe", contractorname: "John Smith" });
  assert.deepEqual(personalOwner.participants, []);
  assert.equal(personalOwner.documents.some((document) => document.kind === "plans"), false);
});

test("Philadelphia exact lookup is scoped to one bounded official permit identity", async () => {
  let exactSql = "";
  const recordId = "CP-2026-000019";
  const project = await lookupStandardizedSourceProject(
    PHILADELPHIA_SOURCE_ID,
    recordId,
    {
      fetchImpl: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        exactSql = url.searchParams.get("q") ?? "";
        return cartoResponse([philadelphiaRow(19, { permitnumber: recordId })]);
      },
    },
  );
  assert.match(exactSql, /WHERE "permitnumber" = 'CP-2026-000019'/);
  assert.match(exactSql, /ORDER BY "cartodb_id" ASC LIMIT 2$/);
  assert.equal(project?.id, `${PHILADELPHIA_SOURCE_ID}:${recordId}`);
  const sourceUrl = new URL(project?.sourceUrl ?? "https://invalid.example");
  assert.equal(sourceUrl.origin, "https://phl.carto.com");
  assert.match(
    sourceUrl.searchParams.get("q") ?? "",
    /WHERE "permitnumber" = 'CP-2026-000019'/,
  );
});

test("Miami iBuild connector loads the official non-terminal plan-review universe without inventing contacts or plans", async () => {
  const calls = [];
  const row = miamiRow(293083);
  const fetchImpl = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    if (url.searchParams.get("returnCountOnly") === "true") {
      return Response.json({ count: 21143 });
    }
    if (url.searchParams.has("outStatistics")) {
      return Response.json({
        features: [
          {
            attributes: {
              ApplicationNumber: row.ApplicationNumber,
              max_internal_id: row.OBJECTID,
            },
          },
        ],
        exceededTransferLimit: false,
      });
    }
    return Response.json({
      features: [{ attributes: row }],
      exceededTransferLimit: false,
    });
  };

  const result = await fetchStandardizedSource(MIAMI_SOURCE_ID, { fetchImpl });
  const pageUrl = calls.find((url) => url.searchParams.has("outFields"));
  assert.equal(result.source.recordCount, 21143);
  assert.equal(result.projects[0].id, `${MIAMI_SOURCE_ID}:BD26000293083`);
  assert.equal(result.projects[0].sourceRecordId, "BD26000293083");
  assert.match(result.projects[0].summary, /BD26000293083/);
  assert.equal(result.projects[0].stage, "design");
  assert.equal(result.projects[0].status, "Applicant Corrections");
  assert.equal(result.projects[0].address, "293083 NW 1 CT");
  assert.equal(result.projects[0].city, "Miami");
  assert.equal(result.projects[0].state, "FL");
  assert.equal(result.projects[0].updatedAt, new Date(0).toISOString());
  const undatedFreshness = classifyProjectFreshness(
    result.projects[0],
    "2026-07-16T00:00:00.000Z",
  );
  assert.equal(undatedFreshness.freshness, "unclassified");
  assert.match(undatedFreshness.label, /verify/i);
  assert.deepEqual(result.projects[0].participants, []);
  assert.deepEqual(
    result.projects[0].documents.map(({ kind, access, indexStatus }) => ({
      kind,
      access,
      indexStatus,
    })),
    [{ kind: "permit", access: "public", indexStatus: "metadata-only" }],
  );
  assert.ok(result.projects[0].searchableFields.includes("NEW CONSTRUCTION"));
  assert.match(pageUrl.searchParams.get("where") ?? "", /MasterPlanStatus NOT IN \('Final','Cancelled','Expired','Revoked','Inactive','Terminated'\)/);
  assert.match(pageUrl.searchParams.get("where") ?? "", /PermitStatus IS NULL OR PermitStatus NOT IN/);
  assert.equal(pageUrl.searchParams.get("orderByFields"), "OBJECTID DESC");
});

test("Miami iBuild lifecycle distinguishes plan review, approval, issued work, and terminal states", () => {
  const definition = STANDARDIZED_SOURCE_DEFINITIONS[MIAMI_SOURCE_ID];
  const map = (overrides) =>
    mapStandardizedRecord(
      definition,
      miamiRow(40, overrides),
      "https://gis.miami.gov/gis/rest/services/Maps/iBuildPermits/MapServer/0/query",
    );

  assert.equal(map({ MasterPlanStatus: "Prescreen" }).stage, "design");
  assert.equal(map({ MasterPlanStatus: "Approved", PermitStatus: "Pending" }).stage, "permitting");
  const issued = map({
    MasterPlanStatus: "Permit Issued",
    PermitStatus: "Active",
    PermitNumber: "BD26000040001B001",
    PermitIssuedDate: Date.UTC(2026, 5, 1),
  });
  assert.equal(issued.stage, "construction");
  assert.equal(issued.status, "Permit Issued / Active");
  assert.equal(issued.updatedAt, "2026-06-01T00:00:00.000Z");
  assert.equal(map({ MasterPlanStatus: "Final", PermitStatus: "Final" }).stage, "completed");
  assert.equal(map({ MasterPlanStatus: "Permit Issued", PermitStatus: "Expired" }).stage, "cancelled");
});

test("Miami folds repeated ArcGIS rows into one canonical application project", async () => {
  const sharedApplication = "BD26000001234";
  const rows = [
    miamiRow(1201, { ApplicationNumber: sharedApplication }),
    miamiRow(1202, { ApplicationNumber: sharedApplication }),
  ];
  const result = await fetchStandardizedSource(MIAMI_SOURCE_ID, {
    mode: "ingest",
    lane: "backfill",
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.searchParams.get("returnCountOnly") === "true") {
        return Response.json({ count: 2 });
      }
      if (url.searchParams.has("outStatistics")) {
        return Response.json({
          features: [
            {
              attributes: {
                ApplicationNumber: sharedApplication,
                max_internal_id: 1202,
              },
            },
          ],
          exceededTransferLimit: false,
        });
      }
      if ((url.searchParams.get("where") ?? "").includes("OBJECTID IN")) {
        return Response.json({
          features: [{ attributes: rows[1] }],
          exceededTransferLimit: false,
        });
      }
      return Response.json({
        features: rows.map((attributes) => ({ attributes })),
        exceededTransferLimit: false,
      });
    },
  });
  assert.deepEqual(
    result.projects.map((project) => project.id),
    [`${MIAMI_SOURCE_ID}:${sharedApplication}`],
  );
  assert.equal(result.projects[0].address, "1202 NW 1 CT");
  assert.ok(result.projects[0].summary.includes(sharedApplication));
  assert.ok(result.projects[0].searchableFields.includes(sharedApplication));
  assert.match(result.source.note, /2 source rows read and 1 unique application project/i);
  assert.match(result.source.note, /row count, not a guaranteed unique-project count/i);
});

test("Miami continuation pages hydrate the newest application row and never regress persisted status", async () => {
  const sharedApplication = "BD-CROSS-PAGE";
  let pageRequest = 0;
  let groupedUrl;
  let exactUrl;
  const result = await fetchStandardizedSource(MIAMI_SOURCE_ID, {
    mode: "ingest",
    lane: "refresh",
    sourceCursors: {
      [MIAMI_SOURCE_ID]: {
        offset: 50,
        lastRecordUniqueId: 1201,
        lastRecordSortValue: 1201,
      },
    },
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.searchParams.get("returnCountOnly") === "true") {
        return Response.json({ count: 21143 });
      }
      if (url.searchParams.has("outStatistics")) {
        groupedUrl = url;
        return Response.json({
          features: [
            {
              attributes: {
                ApplicationNumber: sharedApplication,
                max_internal_id: 2002,
              },
            },
          ],
          exceededTransferLimit: false,
        });
      }
      if ((url.searchParams.get("where") ?? "").includes("OBJECTID IN")) {
        exactUrl = url;
        return Response.json({
          features: [
            {
              attributes: miamiRow(2002, {
                ApplicationNumber: sharedApplication,
                MasterPlanStatus: "Permit Issued",
                PermitStatus: "Active",
                PlanNumber: "NEWEST-CANONICAL",
              }),
            },
          ],
          exceededTransferLimit: false,
        });
      }
      pageRequest += 1;
      return Response.json({
        features: [
          {
            attributes: miamiRow(1002, {
              ApplicationNumber: sharedApplication,
              MasterPlanStatus: "Applicant Corrections",
              PermitStatus: null,
              PlanNumber: `CONTINUATION-${pageRequest}`,
            }),
          },
        ],
        exceededTransferLimit: false,
      });
    },
  });

  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].sourceRecordId, sharedApplication);
  assert.equal(result.projects[0].stage, "construction");
  assert.ok(result.projects[0].searchableFields.includes("NEWEST-CANONICAL"));
  assert.equal(result.projects[0].searchableFields.includes("OLDER-DUPLICATE"), false);
  assert.equal(groupedUrl.searchParams.get("groupByFieldsForStatistics"), "ApplicationNumber");
  assert.deepEqual(JSON.parse(groupedUrl.searchParams.get("outStatistics")), [
    {
      statisticType: "max",
      onStatisticField: "OBJECTID",
      outStatisticFieldName: "max_internal_id",
    },
  ]);
  assert.equal(groupedUrl.searchParams.get("resultRecordCount"), "2");
  assert.equal(exactUrl.searchParams.get("where"), "OBJECTID IN (2002)");
  assert.equal(exactUrl.searchParams.get("resultRecordCount"), "2");
});

test("Miami duplicate hydration fails closed on truncated, missing, or mismatched exact data", async (t) => {
  const applicationNumber = "BD-HARDENED";
  const pageRow = miamiRow(1002, { ApplicationNumber: applicationNumber });
  const newestRow = miamiRow(2002, { ApplicationNumber: applicationNumber });
  const cases = [
    {
      name: "truncated grouped maximum response",
      groupExceededTransferLimit: true,
      pattern: /grouped duplicate-identity hydration was truncated/i,
    },
    {
      name: "missing grouped application",
      groupFeatures: [],
      pattern: /grouped duplicate-identity hydration omitted a requested application/i,
    },
    {
      name: "truncated exact row response",
      exactExceededTransferLimit: true,
      pattern: /exact duplicate-identity hydration was truncated/i,
    },
    {
      name: "missing exact object id",
      exactFeatures: [],
      pattern: /exact duplicate-identity hydration omitted a requested internal ID/i,
    },
    {
      name: "object id mapped to the wrong application",
      exactFeatures: [
        {
          attributes: miamiRow(2002, { ApplicationNumber: "BD-WRONG-APPLICATION" }),
        },
      ],
      pattern: /identity that did not match its grouped maximum/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await assert.rejects(
        fetchStandardizedSource(MIAMI_SOURCE_ID, {
          mode: "ingest",
          lane: "backfill",
          fetchImpl: async (input) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.searchParams.get("returnCountOnly") === "true") {
              return Response.json({ count: 2 });
            }
            if (url.searchParams.has("outStatistics")) {
              return Response.json({
                features:
                  scenario.groupFeatures ?? [
                    {
                      attributes: {
                        ApplicationNumber: applicationNumber,
                        max_internal_id: 2002,
                      },
                    },
                  ],
                exceededTransferLimit: scenario.groupExceededTransferLimit ?? false,
              });
            }
            if ((url.searchParams.get("where") ?? "").includes("OBJECTID IN")) {
              return Response.json({
                features:
                  scenario.exactFeatures ?? [{ attributes: newestRow }],
                exceededTransferLimit: scenario.exactExceededTransferLimit ?? false,
              });
            }
            return Response.json({
              features: [{ attributes: pageRow }],
              exceededTransferLimit: false,
            });
          },
        }),
        scenario.pattern,
      );
    });
  }
});

test("Boston connector maps current residential, commercial, and mixed permits without promoting private applicants", async () => {
  const sqlCalls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const sql = url.searchParams.get("sql") ?? "";
    sqlCalls.push(sql);
    return /select count\(\*\) as total/i.test(sql)
      ? ckanResponse([{ total: "656870" }])
      : ckanResponse([bostonRow(91)]);
  };
  const result = await fetchStandardizedSource(BOSTON_SOURCE_ID, {
    mode: "ingest",
    lane: "backfill",
    fetchImpl,
  });
  assert.equal(result.source.recordCount, 656870);
  assert.equal(result.projects[0].id, `${BOSTON_SOURCE_ID}:91`);
  assert.equal(result.projects[0].sourceRecordId, "91");
  assert.match(result.projects[0].summary, /ERT91/);
  assert.equal(result.projects[0].stage, "permitting");
  assert.equal(result.projects[0].city, "Boston");
  assert.equal(result.projects[0].state, "MA");
  assert.equal(result.projects[0].value, 2_000_091);
  assert.ok(result.projects[0].searchableFields.includes("Mixed"));
  assert.ok(result.projects[0].searchableFields.includes("residential"));
  assert.ok(result.projects[0].searchableFields.includes("commercial"));
  assert.deepEqual(result.projects[0].participants, []);
  const pageSql = sqlCalls.find((sql) => !/select count\(\*\) as total/i.test(sql));
  assert.match(pageSql, /FROM "6ddcd912-32a0-43df-9908-63574f8c7e77"/);
  assert.match(pageSql, /ORDER BY "_id" ASC LIMIT 51$/);
});

test("Boston occupancy codes add conservative residential and mixed-use search tags", () => {
  const definition = STANDARDIZED_SOURCE_DEFINITIONS[BOSTON_SOURCE_ID];
  for (const [index, occupancytype] of [
    "Multi",
    "1-4FAM",
    "1Unit",
    "7More",
    "1-7FAM",
    "2unit",
    "3unit",
  ].entries()) {
    const mapped = mapStandardizedRecord(
      definition,
      bostonRow(500 + index, {
        comments: "Interior alteration",
        description: "Interior alteration",
        occupancytype,
      }),
      "https://data.boston.gov/dataset/approved-building-permits",
    );
    assert.ok(mapped.searchableFields.includes("residential"), occupancytype);
    assert.equal(mapped.searchableFields.includes("commercial"), false, occupancytype);
  }

  const mixed = mapStandardizedRecord(
    definition,
    bostonRow(599, {
      comments: "Interior alteration",
      description: "Interior alteration",
      occupancytype: "Mixed",
    }),
    "https://data.boston.gov/dataset/approved-building-permits",
  );
  assert.ok(mixed.searchableFields.includes("residential"));
  assert.ok(mixed.searchableFields.includes("commercial"));
});

test("Boston uses unique CKAN row IDs while keeping repeated permit numbers visible and searchable", async () => {
  const rows = [
    bostonRow(101, { permitnumber: "ALT-SHARED" }),
    bostonRow(102, { permitnumber: "ALT-SHARED" }),
  ];
  const result = await fetchStandardizedSource(BOSTON_SOURCE_ID, {
    mode: "ingest",
    lane: "backfill",
    fetchImpl: async (input) => {
      const sql = new URL(input instanceof Request ? input.url : String(input)).searchParams.get("sql") ?? "";
      return /select count\(\*\) as total/i.test(sql)
        ? ckanResponse([{ total: "2" }])
        : ckanResponse(rows);
    },
  });
  assert.deepEqual(
    result.projects.map((project) => project.id),
    [`${BOSTON_SOURCE_ID}:101`, `${BOSTON_SOURCE_ID}:102`],
  );
  assert.ok(
    result.projects.every(
      (project) =>
        project.summary.includes("ALT-SHARED") &&
        project.searchableFields.includes("ALT-SHARED"),
    ),
  );
});

test("ArcGIS backfill retries transient failures and advances a stable OBJECTID keyset", async () => {
  const calls = [];
  const delays = [];
  let countAttempts = 0;
  const fetchImpl = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    if (url.searchParams.get("returnCountOnly") === "true") {
      countAttempts += 1;
      if (countAttempts === 1) {
        return new Response("retry", { status: 503, statusText: "Unavailable" });
      }
      return Response.json({ count: 19863 });
    }
    return Response.json({
      features: Array.from({ length: 51 }, (_, index) => ({
        attributes: tempeRow(101 + index),
      })),
      exceededTransferLimit: true,
    });
  };

  const result = await fetchStandardizedSource(TEMPE_SOURCE_ID, {
    mode: "ingest",
    lane: "backfill",
    sourceCursors: {
      [TEMPE_SOURCE_ID]: { offset: 100, lastRecordUniqueId: 100 },
    },
    fetchImpl,
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.equal(countAttempts, 2);
  assert.deepEqual(delays, [150]);
  const pageCall = calls.find(
    (url) => url.searchParams.has("outFields") && url.searchParams.get("returnCountOnly") !== "true",
  );
  assert.ok(pageCall);
  assert.match(pageCall.searchParams.get("where") ?? "", /OBJECTID > 100/);
  assert.equal(pageCall.searchParams.get("orderByFields"), "OBJECTID ASC");
  assert.equal(pageCall.searchParams.get("resultOffset"), "0");
  assert.equal(pageCall.searchParams.get("resultRecordCount"), "51");

  assert.equal(result.source.recordCount, 19863);
  assert.equal(result.source.loadedCount, 50);
  assert.equal(result.source.snapshotComplete, false);
  assert.equal(result.projects.length, 50);
  assert.equal(result.page.offset, 100);
  assert.equal(result.page.hasMore, true);
  assert.deepEqual(result.page.nextCursor, {
    offset: 150,
    lastRecordUniqueId: 150,
  });
  assert.equal(result.projects[0].provenance, "live-api");
  assert.equal(result.projects[0].confidence, "official");
  assert.equal(result.projects[0].stage, "permitting");
  assert.equal(result.projects[0].updatedAt, new Date(tempeRow(101).StatusDateDtm).toISOString());
  assert.equal(result.projects[0].participants[0].name, "Fixture Construction LLC");
  assert.equal(result.projects[0].documents[0].indexStatus, "metadata-only");
});

test("CKAN backfill uses SQL keysets, independent source totals, and one-row lookahead", async () => {
  const sqlCalls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const sql = url.searchParams.get("sql") ?? "";
    sqlCalls.push(sql);
    if (/select count\(\*\) as total/i.test(sql)) {
      return ckanResponse([{ total: "63520" }]);
    }
    return ckanResponse(
      Array.from({ length: 51 }, (_, index) => pittsburghRow(501 + index)),
    );
  };

  const result = await fetchStandardizedSource(PITTSBURGH_SOURCE_ID, {
    mode: "ingest",
    lane: "backfill",
    sourceCursors: {
      [PITTSBURGH_SOURCE_ID]: { offset: 500, lastRecordUniqueId: 500 },
    },
    fetchImpl,
  });

  const pageSql = sqlCalls.find((sql) => !/select count\(\*\) as total/i.test(sql));
  assert.ok(pageSql);
  assert.match(pageSql, /WHERE "permit_id" IS NOT NULL AND "_id" > 500/i);
  assert.match(pageSql, /ORDER BY "_id" ASC LIMIT 51$/i);
  assert.equal(result.source.recordCount, 63520);
  assert.equal(result.projects.length, 50);
  assert.equal(result.page.hasMore, true);
  assert.deepEqual(result.page.nextCursor, {
    offset: 550,
    lastRecordUniqueId: 550,
  });
  assert.equal(result.projects[0].sourceId, PITTSBURGH_SOURCE_ID);
  assert.equal(result.projects[0].sourceRecordId, "BP-501");
  assert.equal(result.projects[0].city, "Pittsburgh");
  assert.equal(result.projects[0].state, "PA");
});

test("short keyset pages end a snapshot even when an independently reported total is larger", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.searchParams.get("returnCountOnly") === "true") {
      return Response.json({ count: 19863 });
    }
    return Response.json({ features: [{ attributes: tempeRow(9001) }] });
  };
  const result = await fetchStandardizedSource(TEMPE_SOURCE_ID, {
    mode: "ingest",
    lane: "backfill",
    fetchImpl,
  });
  assert.equal(result.source.recordCount, 19863);
  assert.equal(result.projects.length, 1);
  assert.equal(result.page.hasMore, false);
  assert.deepEqual(result.page.nextCursor, { offset: 0 });
  assert.equal(result.source.snapshotComplete, true);
});

test("refresh cursors use lifecycle-date plus internal-ID ordering and fail closed on disorder", async () => {
  let arcgisPageUrl;
  const arcgisCursorDate = Date.UTC(2025, 4, 4);
  await fetchStandardizedSource(TEMPE_SOURCE_ID, {
    mode: "ingest",
    lane: "refresh",
    sourceCursors: {
      [TEMPE_SOURCE_ID]: {
        offset: 1,
        lastRecordSortValue: arcgisCursorDate,
        lastRecordUniqueId: 8,
      },
    },
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.searchParams.get("returnCountOnly") === "true") {
        return Response.json({ count: 1 });
      }
      arcgisPageUrl = url;
      return Response.json({
        features: [
          {
            attributes: tempeRow(9, {
              StatusDateDtm: Date.UTC(2025, 4, 3),
            }),
          },
        ],
      });
    },
  });
  assert.match(
    arcgisPageUrl?.searchParams.get("where") ?? "",
    /StatusDateDtm < TIMESTAMP '2025-05-04 00:00:00\.000'/,
  );

  const sqlCalls = [];
  const goodRows = [
    pittsburghRow(10, { issue_date: "2025-05-03T00:00:00" }),
    pittsburghRow(11, { issue_date: "2025-05-02T00:00:00" }),
  ];
  let rows = goodRows;
  const fetchImpl = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const sql = url.searchParams.get("sql") ?? "";
    sqlCalls.push(sql);
    return /select count\(\*\) as total/i.test(sql)
      ? ckanResponse([{ total: 2 }])
      : ckanResponse(rows);
  };

  await fetchStandardizedSource(PITTSBURGH_SOURCE_ID, {
    mode: "ingest",
    lane: "refresh",
    sourceCursors: {
      [PITTSBURGH_SOURCE_ID]: {
        offset: 2,
        lastRecordSortValue: "2025-05-04T00:00:00",
        lastRecordUniqueId: 9,
      },
    },
    fetchImpl,
  });
  const pageSql = sqlCalls.find((sql) => !/select count\(\*\) as total/i.test(sql));
  assert.match(
    pageSql ?? "",
    /"issue_date" < '2025-05-04T00:00:00' OR \("issue_date" = '2025-05-04T00:00:00' AND "_id" > 9\)/,
  );
  assert.match(pageSql ?? "", /"issue_date" <= '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'/);
  assert.match(pageSql ?? "", /ORDER BY "issue_date" DESC, "_id" ASC LIMIT 51$/);

  rows = [goodRows[1], goodRows[0]];
  await assert.rejects(
    fetchStandardizedSource(PITTSBURGH_SOURCE_ID, {
      mode: "ingest",
      lane: "refresh",
      fetchImpl,
    }),
    /not deterministically ordered/i,
  );

  rows = [pittsburghRow(9, { issue_date: "2025-05-04T00:00:00" })];
  await assert.rejects(
    fetchStandardizedSource(PITTSBURGH_SOURCE_ID, {
      mode: "ingest",
      lane: "refresh",
      sourceCursors: {
        [PITTSBURGH_SOURCE_ID]: {
          offset: 2,
          lastRecordSortValue: "2025-05-04T00:00:00",
          lastRecordUniqueId: 9,
        },
      },
      fetchImpl,
    }),
    /did not advance the refresh cursor/i,
  );
});

test("standardized refresh watermarks drain more than 50 tied rows forward without skips", async () => {
  const sharedIssueDate = "2026-07-16T12:00:00";
  const rows = Array.from({ length: 55 }, (_, index) =>
    pittsburghRow(index + 1, { issue_date: sharedIssueDate }),
  );
  const pageSql = [];
  const fetchImpl = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const sql = url.searchParams.get("sql") ?? "";
    if (/select count\(\*\) as total/i.test(sql)) return ckanResponse([{ total: rows.length }]);
    pageSql.push(sql);
    if (pageSql.length === 1) return ckanResponse(rows.slice(0, 51));
    if (pageSql.length === 2) return ckanResponse(rows.slice(1, 52));
    if (pageSql.length === 3) return ckanResponse(rows.slice(51));
    return ckanResponse([]);
  };

  const first = await fetchStandardizedSource(PITTSBURGH_SOURCE_ID, {
    mode: "ingest",
    lane: "refresh",
    fetchImpl,
  });
  assert.equal(first.page.hasMore, false);
  assert.deepEqual(first.page.nextCursor, {
    offset: 0,
    refreshAfter: true,
    lastRecordUniqueId: 1,
    lastRecordSortValue: sharedIssueDate,
  });

  const second = await fetchStandardizedSource(PITTSBURGH_SOURCE_ID, {
    mode: "ingest",
    lane: "refresh",
    sourceCursors: { [PITTSBURGH_SOURCE_ID]: first.page.nextCursor },
    fetchImpl,
  });
  assert.equal(second.page.hasMore, true);
  assert.deepEqual(second.page.nextCursor, {
    offset: 0,
    refreshAfter: true,
    lastRecordUniqueId: 51,
    lastRecordSortValue: sharedIssueDate,
  });
  assert.match(
    pageSql[1],
    /"issue_date" > '2026-07-16T12:00:00' OR \("issue_date" = '2026-07-16T12:00:00' AND "_id" > 1\)/,
  );
  assert.match(pageSql[1], /ORDER BY "issue_date" ASC, "_id" ASC LIMIT 51$/);

  const third = await fetchStandardizedSource(PITTSBURGH_SOURCE_ID, {
    mode: "ingest",
    lane: "refresh",
    sourceCursors: { [PITTSBURGH_SOURCE_ID]: second.page.nextCursor },
    fetchImpl,
  });
  assert.equal(third.page.hasMore, false);
  assert.equal(third.page.nextCursor.lastRecordUniqueId, 55);

  const empty = await fetchStandardizedSource(PITTSBURGH_SOURCE_ID, {
    mode: "ingest",
    lane: "refresh",
    sourceCursors: { [PITTSBURGH_SOURCE_ID]: third.page.nextCursor },
    fetchImpl,
  });
  assert.deepEqual(empty.page.nextCursor, third.page.nextCursor);

  const loadedIds = [...first.projects, ...second.projects, ...third.projects]
    .map((project) => project.sourceRecordId);
  assert.equal(new Set(loadedIds).size, rows.length);
});

test("exact ArcGIS and CKAN lookups escape identities and require one exact match", async () => {
  let arcgisLookupUrl;
  const tempeProject = await lookupStandardizedProject(
    `${TEMPE_SOURCE_ID}:BP252691`,
    {
      fetchImpl: async (input) => {
        arcgisLookupUrl = new URL(input instanceof Request ? input.url : String(input));
        return Response.json({
          features: [
            {
              attributes: tempeRow(7335339, {
                PermitNum: "BP252691",
                ProjectName: "Verified exact fixture",
              }),
            },
          ],
        });
      },
    },
  );
  assert.equal(arcgisLookupUrl.searchParams.get("where"), "PermitNum = 'BP252691'");
  assert.equal(arcgisLookupUrl.searchParams.get("resultRecordCount"), "2");
  assert.equal(tempeProject?.id, `${TEMPE_SOURCE_ID}:BP252691`);

  let ckanLookupSql = "";
  const pittsburghProject = await lookupStandardizedProject(
    `${PITTSBURGH_SOURCE_ID}:P'1`,
    {
      fetchImpl: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        ckanLookupSql = url.searchParams.get("sql") ?? "";
        return ckanResponse([pittsburghRow(1, { permit_id: "P'1" })]);
      },
    },
  );
  assert.match(ckanLookupSql, /WHERE "permit_id" = 'P''1'/);
  assert.match(ckanLookupSql, /ORDER BY "_id" ASC LIMIT 2$/);
  assert.equal(pittsburghProject?.sourceRecordId, "P'1");

  let bostonLookupSql = "";
  const bostonProject = await lookupStandardizedProject(
    `${BOSTON_SOURCE_ID}:91`,
    {
      fetchImpl: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        bostonLookupSql = url.searchParams.get("sql") ?? "";
        return ckanResponse([bostonRow(91, { permitnumber: "ALT-SHARED" })]);
      },
    },
  );
  assert.match(bostonLookupSql, /WHERE "_id" = 91/);
  assert.doesNotMatch(bostonLookupSql, /WHERE "permitnumber"/);
  assert.equal(bostonProject?.id, `${BOSTON_SOURCE_ID}:91`);
  assert.equal(bostonProject?.sourceRecordId, "91");
  assert.match(bostonProject?.summary ?? "", /ALT-SHARED/);

  const missing = await lookupStandardizedSourceProject(TEMPE_SOURCE_ID, "missing", {
    fetchImpl: async () => Response.json({ features: [] }),
  });
  assert.equal(missing, undefined);

  let miamiLookupUrl;
  const miamiProject = await lookupStandardizedProject(
    `${MIAMI_SOURCE_ID}:BD-SHARED`,
    {
      fetchImpl: async (input) => {
        miamiLookupUrl = new URL(input instanceof Request ? input.url : String(input));
        return Response.json({
          features: [
            {
              attributes: miamiRow(293082, {
                ApplicationNumber: "BD-SHARED",
                PlanNumber: "OLDER",
              }),
            },
            {
              attributes: miamiRow(293083, {
                ApplicationNumber: "BD-SHARED",
                PlanNumber: "NEWEST",
              }),
            },
          ],
        });
      },
    },
  );
  assert.equal(miamiLookupUrl.searchParams.get("where"), "ApplicationNumber = 'BD-SHARED'");
  assert.equal(miamiLookupUrl.searchParams.get("orderByFields"), "OBJECTID DESC");
  assert.equal(miamiLookupUrl.searchParams.get("resultRecordCount"), "2");
  assert.equal(miamiProject?.id, `${MIAMI_SOURCE_ID}:BD-SHARED`);
  assert.equal(miamiProject?.sourceRecordId, "BD-SHARED");
  assert.match(miamiProject?.summary ?? "", /BD-SHARED/);
  assert.ok(miamiProject?.searchableFields.includes("NEWEST"));
  assert.equal(miamiProject?.address, "293083 NW 1 CT");
  assert.deepEqual(miamiProject?.participants, []);
  assert.equal(miamiProject?.documents.some((document) => document.kind === "plans"), false);
});

test("ArcGIS sources can use one descending internal-ID refresh cursor without contradictory ordering", async () => {
  let pageUrl;
  const result = await fetchStandardizedSource(MIAMI_SOURCE_ID, {
    mode: "ingest",
    lane: "refresh",
    sourceCursors: {
      [MIAMI_SOURCE_ID]: {
        offset: 1,
        lastRecordSortValue: 293100,
        lastRecordUniqueId: 293100,
      },
    },
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.searchParams.get("returnCountOnly") === "true") {
        return Response.json({ count: 21143 });
      }
      if (url.searchParams.has("outStatistics")) {
        return Response.json({
          features: [
            {
              attributes: {
                ApplicationNumber: miamiRow(293083).ApplicationNumber,
                max_internal_id: 293083,
              },
            },
          ],
          exceededTransferLimit: false,
        });
      }
      if ((url.searchParams.get("where") ?? "").includes("OBJECTID IN")) {
        return Response.json({
          features: [{ attributes: miamiRow(293083) }],
          exceededTransferLimit: false,
        });
      }
      pageUrl = url;
      return Response.json({ features: [{ attributes: miamiRow(293083) }] });
    },
  });
  assert.match(pageUrl.searchParams.get("where") ?? "", /\(OBJECTID < 293100\)/);
  assert.doesNotMatch(pageUrl.searchParams.get("where") ?? "", /OBJECTID = 293100/);
  assert.equal(pageUrl.searchParams.get("orderByFields"), "OBJECTID DESC");
  assert.equal(result.projects.length, 1);
  assert.deepEqual(result.page.nextCursor, { offset: 0 });
});

test("record mapping extracts only allowlisted HTTPS URLs and uses lifecycle data for freshness", () => {
  const baseDefinition = STANDARDIZED_SOURCE_DEFINITIONS[TEMPE_SOURCE_ID];
  const definition = {
    ...baseDefinition,
    selectFields: [...baseDefinition.selectFields, "PlanUrls", "ContactUrl"],
    mapping: {
      ...baseDefinition.mapping,
      documentUrlFields: [
        {
          field: "PlanUrls",
          name: "Published plans",
          kind: "plans",
          allowedHosts: ["official.example.gov"],
        },
      ],
      contactUrlFields: [
        {
          field: "ContactUrl",
          name: "Official contact record",
          kind: "source-record",
          allowedHosts: ["official.example.gov"],
        },
      ],
    },
  };
  const row = tempeRow(42, {
    StatusCurrent: "Finaled",
    StatusDateDtm: Date.UTC(2024, 0, 2),
    ContractorCompanyName: "Jane Doe",
    PlanUrls: [
      "https://files.official.example.gov/plans/42.pdf",
      "http://files.official.example.gov/not-https.pdf",
      "https://evil.example/plans/42.pdf",
    ],
    ContactUrl: {
      url: "https://contacts.official.example.gov/permits/42#private-fragment",
    },
  });
  const project = mapStandardizedRecord(
    definition,
    row,
    "https://records.official.example.gov/permits/42",
  );

  assert.deepEqual(
    project.documents.map((document) => document.url),
    [
      "https://records.official.example.gov/permits/42",
      "https://files.official.example.gov/plans/42.pdf",
      "https://contacts.official.example.gov/permits/42",
    ],
  );
  assert.deepEqual(project.participants, []);
  assert.equal(project.stage, "completed");
  assert.equal(project.updatedAt, "2024-01-02T00:00:00.000Z");
  assert.equal(classifyProjectFreshness(project, "2026-07-16T00:00:00.000Z").freshness, "closed");
  assert.equal(standardizedPermitStage("Permit voided"), "cancelled");
  assert.equal(standardizedPermitStage("Plan review pending"), "design");
  assert.equal(standardizedPermitStage("Unknown source value"), "unclassified");

  const impossibleFutureDate = mapStandardizedRecord(
    baseDefinition,
    tempeRow(43, {
      StatusDateDtm: Date.UTC(3021, 0, 1),
      IssuedDateDtm: Date.UTC(2020, 5, 1),
    }),
    "https://records.official.example.gov/permits/43",
  );
  assert.equal(impossibleFutureDate.updatedAt, "2020-06-01T00:00:00.000Z");
});
