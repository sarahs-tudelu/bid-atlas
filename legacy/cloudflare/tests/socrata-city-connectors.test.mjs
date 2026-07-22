import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-extension-loader.mjs", import.meta.url);

const {
  SOCRATA_CITY_SOURCE_IDS,
  SOCRATA_CITY_SOURCE_TEMPLATES,
  fetchNycCityRecordCurrentConstructionSolicitations,
  fetchSocrataCitySource,
  lookupNycCityRecordConstructionProject,
  lookupSocrataCityProject,
} = await import("../app/lib/socrata-city-connectors.ts");
const { getProjectFeed } = await import("../app/lib/connectors.ts");

const samples = {
  "w9ak-ipjd": {
    ":id": "row-test",
    job_filing_number: "B00000001-I1",
    filing_status: "Filing Withdrawn",
    job_description: "Withdrawn full-history filing remains queryable",
    filing_date: "2020-01-01T00:00:00.000",
    current_status_date: "2020-01-02T00:00:00.000",
  },
  "rbx6-tga4": {
    ":id": "row-approved-permit",
    job_filing_number: "B00000001-I1",
    work_permit: "B00000001-AL",
    permit_status: "Signed-off",
    permittee_s_license_type: "GC",
    applicant_license: "123456",
    applicant_business_name: "Example Construction LLC",
    owner_business_name: "Example Owner Holdings LLC",
    job_description: "Signed-off approved permit remains queryable",
    issued_date: "2020-01-02T00:00:00.000",
    dobrundate: "2026-07-20T00:00:00.000",
  },
  "w9se-dmra": {
    pk: "010100000001",
    recordid: "00000001",
    permitno: "P-1",
    status: "C",
    permitstatusdesc: "Certificate",
    permitdate: "2020-01-01T00:00:00.000",
    certdate: "2020-01-02T00:00:00.000",
    permittype: "06",
    permittypedesc: "Alteration",
    muniname: "EXAMPLE CITY",
    county: "MERCER",
    processdate: "2026-07-20T00:00:00.000",
  },
  "dg92-zbpx": {
    request_id: "20200102001",
    start_date: "2020-01-02T00:00:00.000",
    end_date: "2020-01-02T00:00:00.000",
    agency_name: "Design and Construction",
    type_of_notice_description: "Award",
    category_description: "Construction/Construction Services",
    short_title: "Awarded construction project remains queryable",
    section_name: "Procurement",
    contract_amount: "1500000",
    vendor_name: "Example Builder LLC",
  },
  "gwh9-jnip": {
    permit_nbr: "26010-10000-01234",
    primary_address: "100 S MAIN ST",
    zip_code: "90012",
    permit_group: "Building",
    permit_type: "Bldg-New",
    permit_sub_type: "1 or 2 Family Dwelling",
    use_desc: "Single Family Dwelling",
    submitted_date: "2026-07-01T00:00:00.000",
    status_desc: "Permit Finaled",
    status_date: "2026-07-15T00:00:00.000",
    valuation: "850000",
    work_desc: "NEW TWO STORY SINGLE FAMILY DWELLING WITH ATTACHED GARAGE",
    refresh_time: "2026-07-16T00:00:00.000",
  },
  "ydr8-5enu": {
    ":updated_at": "2026-07-16T12:42:43.267Z",
    id: "C1",
    permit_: "P1",
    permit_status: "COMPLETE",
    work_description: "Completed full-history permit remains queryable",
    application_start_date: "2020-01-01T00:00:00.000",
    issue_date: "2020-01-02T00:00:00.000",
  },
  "3syk-w9eu": {
    permit_number: "A1",
    status_current: "Final",
    description: "Final full-history permit remains queryable",
    applieddate: "2020-01-01T00:00:00.000",
    statusdate: "2020-01-02T00:00:00.000",
  },
  "i98e-djp9": {
    record_id: "S1",
    permit_number: "SF1",
    status: "complete",
    description: "Complete full-history permit remains queryable",
    primary_address_flag: "Y",
    filed_date: "2020-01-01T00:00:00.000",
    data_loaded_at: "2020-01-02T00:00:00.000",
  },
};

const datasetForSource = {
  "nyc-dob-now-job-filings": "w9ak-ipjd",
  "nyc-dob-now-approved-permits": "rbx6-tga4",
  "new-jersey-construction-permits": "w9se-dmra",
  "nyc-city-record-construction-procurement": "dg92-zbpx",
  "los-angeles-building-permits-submitted": "gwh9-jnip",
  "chicago-building-permits": "ydr8-5enu",
  "austin-issued-construction-permits": "3syk-w9eu",
  "san-francisco-building-permits": "i98e-djp9",
};

const uniqueKeyForSource = {
  "nyc-dob-now-job-filings": ":id",
  "nyc-dob-now-approved-permits": ":id",
  "new-jersey-construction-permits": "pk",
  "nyc-city-record-construction-procurement": "request_id",
  "los-angeles-building-permits-submitted": "permit_nbr",
  "chicago-building-permits": "id",
  "austin-issued-construction-permits": "permit_number",
  "san-francisco-building-permits": "record_id",
};

test("city Socrata backfills use stable keysets and retain terminal lifecycle states", async () => {
  assert.deepEqual(SOCRATA_CITY_SOURCE_IDS, [
    "nyc-dob-now-job-filings",
    "nyc-dob-now-approved-permits",
    "new-jersey-construction-permits",
    "nyc-city-record-construction-procurement",
    "los-angeles-building-permits-submitted",
    "chicago-building-permits",
    "austin-issued-construction-permits",
    "san-francisco-building-permits",
  ]);
  for (const sourceId of SOCRATA_CITY_SOURCE_IDS) {
    if (sourceId === "nyc-city-record-construction-procurement") {
      assert.equal(SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].sourceClass, "procurement");
      assert.ok(SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].stages.includes("bidding"));
      assert.ok(SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].stages.includes("awarded"));
    } else {
      assert.equal(SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].sourceClass, "permits");
      assert.ok(SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].stages.includes("completed"));
      if (sourceId !== "new-jersey-construction-permits") {
        assert.ok(SOCRATA_CITY_SOURCE_TEMPLATES[sourceId].stages.includes("cancelled"));
      }
    }
  }

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    if (url.searchParams.get("$select") === "count(*) as count") {
      return Response.json([{ count: "1" }]);
    }
    const datasetId = url.pathname.split("/").at(-1).replace(/\.json$/, "");
    return Response.json([samples[datasetId]]);
  };

  try {
    const expectedStatuses = [
      "Filing Withdrawn",
      "Signed-off",
      "Certificate",
      "Award",
      "Permit Finaled",
      "COMPLETE",
      "Final",
      "complete",
    ];
    const expectedStages = [
      "cancelled",
      "completed",
      "completed",
      "awarded",
      "completed",
      "completed",
      "completed",
      "completed",
    ];
    for (const [index, sourceId] of SOCRATA_CITY_SOURCE_IDS.entries()) {
      const result = await fetchSocrataCitySource(sourceId, {
        mode: "ingest",
        lane: "backfill",
      });
      assert.equal(result.projects.length, 1);
      assert.equal(result.projects[0].status, expectedStatuses[index]);
      assert.equal(result.projects[0].stage, expectedStages[index]);
      assert.equal(result.source.recordCount, 1);
      assert.equal(result.source.snapshotComplete, true);
      assert.equal(result.page.hasMore, false);

      const datasetId = datasetForSource[sourceId];
      const rowCall = calls.find(
        (url) =>
          url.pathname.endsWith(`/${datasetId}.json`) &&
          url.searchParams.get("$select") !== "count(*) as count",
      );
      assert.ok(rowCall);
      assert.equal(rowCall.searchParams.get("$order"), `${uniqueKeyForSource[sourceId]} ASC`);
      assert.equal(rowCall.searchParams.get("$limit"), "51");
      assert.equal(rowCall.searchParams.get("$offset"), "0");
      const where = rowCall.searchParams.get("$where") ?? "";
      assert.doesNotMatch(where, /complete|cancel|withdraw|revok|final/i);
      if (sourceId === "san-francisco-building-permits") {
        assert.match(where, /primary_address_flag = 'Y'/);
      }
      if (sourceId === "nyc-city-record-construction-procurement") {
        assert.match(where, /section_name = 'Procurement'/);
        assert.doesNotMatch(where, /category_description/);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Chicago refreshes by source row updates so post-issue completion changes are revisited", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    if (url.searchParams.get("$select") === "count(*) as count") {
      return Response.json([{ count: "1" }]);
    }
    return Response.json([
      {
        ...samples["ydr8-5enu"],
        id: "C-OLD-ISSUE-NEW-STATUS",
        permit_: "P-OLD-ISSUE-NEW-STATUS",
        permit_status: "COMPLETE",
        permit_milestone: "COMPLETE",
        issue_date: "2026-03-02T00:00:00.000",
        ":updated_at": "2026-07-16T12:42:43.267Z",
      },
    ]);
  };

  try {
    const result = await fetchSocrataCitySource("chicago-building-permits", {
      mode: "ingest",
      lane: "refresh",
    });
    assert.equal(result.projects[0].stage, "completed");
    assert.equal(result.projects[0].updatedAt, "2026-07-16T12:42:43.267Z");
    const rowCall = calls.find(
      (url) => url.searchParams.get("$select") !== "count(*) as count",
    );
    assert.ok(rowCall);
    assert.match(rowCall.searchParams.get("$select") ?? "", /:updated_at/);
    assert.equal(rowCall.searchParams.get("$order"), ":updated_at DESC, id ASC");
    assert.match(rowCall.searchParams.get("$where") ?? "", /:updated_at is not null/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Chicago forward refresh watermark preserves every tied row across scheduled runs", async () => {
  const originalFetch = globalThis.fetch;
  const rowCalls = [];
  const sharedUpdatedAt = "2026-07-16T12:42:43.267Z";
  const rows = Array.from({ length: 55 }, (_, index) => ({
    ...samples["ydr8-5enu"],
    ":updated_at": sharedUpdatedAt,
    id: `C${String(index + 1).padStart(4, "0")}`,
    permit_: `P${String(index + 1).padStart(4, "0")}`,
    permit_status: "ACTIVE",
    permit_milestone: "PERMIT ISSUED",
    work_description: `Chicago pagination test permit ${index + 1}`,
  }));

  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.searchParams.get("$select") === "count(*) as count") {
      return Response.json([{ count: String(rows.length) }]);
    }
    rowCalls.push(url);
    if (rowCalls.length === 1) return Response.json(rows.slice(0, 51));
    if (rowCalls.length === 2) return Response.json(rows.slice(1, 52));
    if (rowCalls.length === 3) return Response.json(rows.slice(51));
    return Response.json([]);
  };

  try {
    const first = await fetchSocrataCitySource("chicago-building-permits", {
      mode: "ingest",
      lane: "refresh",
    });
    assert.equal(first.projects.length, 50);
    assert.equal(first.page.hasMore, false, "the descending head seeds a watermark, not an older-page scan");
    assert.deepEqual(first.page.nextCursor, {
      offset: 0,
      refreshAfter: true,
      lastRecordUniqueId: "C0001",
      lastRecordSortValue: sharedUpdatedAt,
    });
    assert.equal(rowCalls[0].searchParams.get("$limit"), "51");
    assert.equal(rowCalls[0].searchParams.get("$order"), ":updated_at DESC, id ASC");

    const second = await fetchSocrataCitySource("chicago-building-permits", {
      mode: "ingest",
      lane: "refresh",
      sourceCursors: {
        "chicago-building-permits": first.page.nextCursor,
      },
    });
    assert.equal(second.projects.length, 50);
    assert.equal(second.page.hasMore, true);
    assert.deepEqual(second.page.nextCursor, {
      offset: 0,
      refreshAfter: true,
      lastRecordUniqueId: "C0051",
      lastRecordSortValue: sharedUpdatedAt,
    });
    assert.equal(rowCalls[1].searchParams.get("$order"), ":updated_at ASC, id ASC");
    const continuationWhere = rowCalls[1].searchParams.get("$where") ?? "";
    assert.match(continuationWhere, /:updated_at > '2026-07-16T12:42:43\.267Z'/);
    assert.match(
      continuationWhere,
      /:updated_at = '2026-07-16T12:42:43\.267Z' AND id > 'C0001'/,
    );

    const third = await fetchSocrataCitySource("chicago-building-permits", {
      mode: "ingest",
      lane: "refresh",
      sourceCursors: {
        "chicago-building-permits": second.page.nextCursor,
      },
    });
    assert.equal(third.projects.length, 4);
    assert.equal(third.page.hasMore, false);
    assert.deepEqual(third.page.nextCursor, {
      offset: 0,
      refreshAfter: true,
      lastRecordUniqueId: "C0055",
      lastRecordSortValue: sharedUpdatedAt,
    });

    const empty = await fetchSocrataCitySource("chicago-building-permits", {
      mode: "ingest",
      lane: "refresh",
      sourceCursors: {
        "chicago-building-permits": third.page.nextCursor,
      },
    });
    assert.equal(empty.projects.length, 0);
    assert.deepEqual(empty.page.nextCursor, third.page.nextCursor, "an empty delta retains its watermark");

    const loadedIds = [...first.projects, ...second.projects, ...third.projects].map(
      (project) => project.sourceRecordId,
    );
    assert.deepEqual([...new Set(loadedIds)].sort(), rows.map((row) => row.id));
    assert.equal(new Set(loadedIds).size, rows.length, "no tied row may be skipped");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Seattle refreshes forward by Socrata row-update time across tied pages", async () => {
  const originalFetch = globalThis.fetch;
  const rowCalls = [];
  const sharedUpdatedAt = "2026-07-17T01:03:35.783Z";
  const rows = Array.from({ length: 55 }, (_, index) => ({
    ":updated_at": sharedUpdatedAt,
    permitnum: `SEA-${String(index + 1).padStart(4, "0")}`,
    description: `Seattle tied refresh ${index + 1}`,
    applieddate: "2026-07-01T00:00:00.000",
    statuscurrent: index % 2 === 0 ? "Completed" : "Canceled",
    originalcity: "Seattle",
    originalstate: "WA",
  }));
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.searchParams.get("$select") === "count(*) as count") {
      return Response.json([{ count: String(rows.length) }]);
    }
    rowCalls.push(url);
    if (rowCalls.length === 1) return Response.json(rows.slice(0, 51));
    if (rowCalls.length === 2) return Response.json(rows.slice(1, 52));
    if (rowCalls.length === 3) return Response.json(rows.slice(51));
    return Response.json([]);
  };

  try {
    const first = await getProjectFeed({
      mode: "ingest",
      lane: "refresh",
      sourceId: "seattle-building-permits",
    });
    const firstPage = first.sourcePages["seattle-building-permits"];
    assert.equal(firstPage.hasMore, false);
    assert.deepEqual(firstPage.nextCursor, {
      offset: 0,
      refreshAfter: true,
      lastRecordUniqueId: "SEA-0001",
      lastRecordSortValue: sharedUpdatedAt,
    });
    assert.equal(
      first.sources.find((source) => source.id === "seattle-building-permits")?.snapshotComplete,
      false,
      "a refresh head must never claim a completed historical snapshot",
    );
    assert.match(rowCalls[0].searchParams.get("$select") ?? "", /:updated_at/);
    assert.equal(rowCalls[0].searchParams.get("$order"), ":updated_at DESC, permitnum ASC");

    const second = await getProjectFeed({
      mode: "ingest",
      lane: "refresh",
      sourceId: "seattle-building-permits",
      sourceCursors: { "seattle-building-permits": firstPage.nextCursor },
    });
    const secondPage = second.sourcePages["seattle-building-permits"];
    assert.equal(secondPage.hasMore, true);
    assert.equal(secondPage.nextCursor.lastRecordUniqueId, "SEA-0051");
    assert.equal(rowCalls[1].searchParams.get("$order"), ":updated_at ASC, permitnum ASC");
    assert.match(rowCalls[1].searchParams.get("$where") ?? "", /:updated_at > '2026-07-17T01:03:35\.783Z'/);
    assert.match(rowCalls[1].searchParams.get("$where") ?? "", /permitnum > 'SEA-0001'/);

    const third = await getProjectFeed({
      mode: "ingest",
      lane: "refresh",
      sourceId: "seattle-building-permits",
      sourceCursors: { "seattle-building-permits": secondPage.nextCursor },
    });
    const thirdPage = third.sourcePages["seattle-building-permits"];
    assert.equal(thirdPage.nextCursor.lastRecordUniqueId, "SEA-0055");

    const empty = await getProjectFeed({
      mode: "ingest",
      lane: "refresh",
      sourceId: "seattle-building-permits",
      sourceCursors: { "seattle-building-permits": thirdPage.nextCursor },
    });
    assert.deepEqual(
      empty.sourcePages["seattle-building-permits"].nextCursor,
      thirdPage.nextCursor,
    );
    const loadedIds = [...first.projects, ...second.projects, ...third.projects]
      .map((project) => project.sourceRecordId);
    assert.equal(new Set(loadedIds).size, rows.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("city Socrata continuation pages advance upstream keys instead of offsets", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    return Response.json(
      url.searchParams.get("$select") === "count(*) as count" ? [{ count: "1" }] : [],
    );
  };

  try {
    for (const sourceId of SOCRATA_CITY_SOURCE_IDS) {
      const key = uniqueKeyForSource[sourceId];
      await fetchSocrataCitySource(sourceId, {
        mode: "ingest",
        lane: "backfill",
        sourceCursors: {
          [sourceId]: { offset: 500, lastRecordUniqueId: `cursor-${sourceId}` },
        },
      });
      const datasetId = datasetForSource[sourceId];
      const rowCall = calls.find(
        (url) =>
          url.pathname.endsWith(`/${datasetId}.json`) &&
          url.searchParams.get("$select") !== "count(*) as count",
      );
      assert.ok(rowCall);
      assert.match(
        rowCall.searchParams.get("$where") ?? "",
        new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} > 'cursor-`),
      );
      assert.equal(rowCall.searchParams.get("$offset"), "0");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Los Angeles refresh pagination uses permit lifecycle activity and continues beyond 50 rows", async () => {
  const originalFetch = globalThis.fetch;
  const rowCalls = [];
  let pageRequest = 0;
  const rows = Array.from({ length: 51 }, (_, index) => {
    const lifecycle = new Date(Date.UTC(2026, 6, 16, 23 - index)).toISOString().replace("Z", "");
    return {
      ...samples["gwh9-jnip"],
      permit_nbr: `26010-10000-${String(index + 1).padStart(5, "0")}`,
      status_desc: "PC in Progress",
      status_date: index === 0 ? undefined : lifecycle,
      submitted_date: lifecycle,
      lifecycle_activity_date: lifecycle,
      // Every row has the same extraction timestamp; it must never drive
      // per-project ordering or freshness.
      refresh_time: "2026-12-31T23:59:59.000",
    };
  });
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.searchParams.get("$select") === "count(*) as count") {
      return Response.json([{ count: "297171" }]);
    }
    rowCalls.push(url);
    pageRequest += 1;
    return Response.json(pageRequest === 1 ? rows : []);
  };

  try {
    const first = await fetchSocrataCitySource(
      "los-angeles-building-permits-submitted",
      { mode: "ingest", lane: "refresh" },
    );
    assert.equal(first.projects.length, 50);
    assert.equal(first.page.hasMore, false);
    assert.equal(first.page.nextCursor.offset, 0);
    assert.equal(first.page.nextCursor.refreshAfter, true);
    assert.equal(first.page.nextCursor.lastRecordUniqueId, rows[0].permit_nbr);
    assert.equal(
      first.page.nextCursor.lastRecordSortValue,
      rows[0].lifecycle_activity_date,
    );
    assert.equal(first.projects[0].updatedAt, `${rows[0].submitted_date}Z`);
    assert.notEqual(first.projects[0].updatedAt, "2026-12-31T23:59:59.000Z");
    assert.equal(
      rowCalls[0].searchParams.get("$order"),
      "coalesce(status_date, submitted_date) DESC, permit_nbr ASC",
    );
    assert.match(
      rowCalls[0].searchParams.get("$where") ?? "",
      /coalesce\(status_date, submitted_date\) is not null/,
    );
    assert.doesNotMatch(rowCalls[0].searchParams.get("$order") ?? "", /refresh_time/);

    const second = await fetchSocrataCitySource(
      "los-angeles-building-permits-submitted",
      {
        mode: "ingest",
        lane: "refresh",
        sourceCursors: {
          "los-angeles-building-permits-submitted": first.page.nextCursor,
        },
      },
    );
    assert.equal(second.projects.length, 0);
    assert.match(
      rowCalls[1].searchParams.get("$where") ?? "",
      new RegExp(`coalesce\\(status_date, submitted_date\\) > '${rows[0].lifecycle_activity_date}'`),
    );
    assert.equal(
      rowCalls[1].searchParams.get("$order"),
      "coalesce(status_date, submitted_date) ASC, permit_nbr ASC",
    );
    assert.deepEqual(second.page.nextCursor, first.page.nextCursor);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("city Socrata refreshes reject incomplete cursors and disordered source pages", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return Response.json([]);
  };
  try {
    await assert.rejects(
      fetchSocrataCitySource("los-angeles-building-permits-submitted", {
        mode: "ingest",
        lane: "refresh",
        sourceCursors: {
          "los-angeles-building-permits-submitted": {
            offset: 50,
            lastRecordUniqueId: "26010-10000-00050",
          },
        },
      }),
      /inconsistent Socrata continuation cursor/i,
    );
    assert.equal(fetches, 0);

    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.searchParams.get("$select") === "count(*) as count") {
        return Response.json([{ count: "2" }]);
      }
      return Response.json([
        {
          ...samples["gwh9-jnip"],
          permit_nbr: "26010-10000-00001",
          lifecycle_activity_date: "2026-07-10T00:00:00.000",
        },
        {
          ...samples["gwh9-jnip"],
          permit_nbr: "26010-10000-00002",
          lifecycle_activity_date: "2026-07-11T00:00:00.000",
        },
      ]);
    };
    await assert.rejects(
      fetchSocrataCitySource("los-angeles-building-permits-submitted", {
        mode: "ingest",
        lane: "refresh",
      }),
      /refresh rows are not deterministically ordered/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("incomplete permit review is not classified as completed", async () => {
  const originalFetch = globalThis.fetch;
  let filingStatus = "Incomplete";
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.searchParams.get("$select") === "count(*) as count") {
      return Response.json([{ count: "1" }]);
    }
    return Response.json([
      {
        ":id": "row-incomplete",
        job_filing_number: "B00000002-I1",
        filing_status: filingStatus,
        job_description: "Plan review remains incomplete",
        filing_date: "2020-01-01T00:00:00.000",
        current_status_date: "2020-01-02T00:00:00.000",
      },
    ]);
  };

  try {
    const result = await fetchSocrataCitySource("nyc-dob-now-job-filings", {
      mode: "ingest",
      lane: "backfill",
    });
    assert.equal(result.projects[0].stage, "design");
    filingStatus = "On Hold - Special Inspector Withdrew";
    const onHoldResult = await fetchSocrataCitySource("nyc-dob-now-job-filings", {
      mode: "ingest",
      lane: "backfill",
    });
    assert.equal(onHoldResult.projects[0].stage, "design");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NYC DOB dashboard view limits the official feed to active private construction filings", async () => {
  assert.equal(
    SOCRATA_CITY_SOURCE_TEMPLATES["nyc-dob-now-job-filings"].recordCountUnit,
    "rows",
  );
  assert.match(
    SOCRATA_CITY_SOURCE_TEMPLATES["nyc-dob-now-job-filings"].note,
    /not a count of unique buildings or projects/i,
  );
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    if (url.searchParams.get("$select") === "count(*) as count") {
      return Response.json([{ count: "491632" }]);
    }
    return Response.json([
      {
        ":id": "row-active~private.1",
        job_filing_number: "B01305046-I1",
        filing_status: "Plan Examiner Review",
        current_status_date: "2026-07-20T04:27:47.000",
        filing_date: "2026-07-18T00:00:00.000",
        job_type: "Alteration",
        building_type: "Other",
        owner_type: "Corporation",
        job_description: "Structural modifications for a privately owned building",
      },
    ]);
  };

  try {
    const result = await fetchSocrataCitySource("nyc-dob-now-job-filings", {
      mode: "view",
    });
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].stage, "design");
    assert.equal(result.source.recordCount, 491632);
    assert.match(result.source.note, /non-terminal private filing-row view/i);
    assert.doesNotMatch(result.source.note, /current actionable view/i);

    assert.equal(calls.length, 2);
    for (const call of calls) {
      const where = call.searchParams.get("$where") ?? "";
      assert.match(where, /filing_status not in/i);
      assert.match(where, /'LOC Issued'/);
      assert.match(where, /'Filing Withdrawn'/);
      assert.match(where, /job_type <> 'No Work'/);
      assert.match(where, /owner_type is null OR owner_type not in/i);
      assert.match(where, /'NYC Agency'/);
      assert.match(where, /current_status_date is not null/i);
    }
    const rowCall = calls.find(
      (call) => call.searchParams.get("$select") !== "count(*) as count",
    );
    assert.ok(rowCall);
    assert.equal(rowCall.searchParams.get("$order"), "current_status_date DESC, :id ASC");
    assert.equal(rowCall.searchParams.get("$limit"), "41");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NYC DOB maps public business contacts, permit lifecycle, and records-request guidance without exposing private names", async () => {
  const originalFetch = globalThis.fetch;
  let status = "Plan Examiner Review";
  let businessOverrides = {};
  const baseRow = {
    ":id": "row-public_business.1",
    job_filing_number: "S01352118-S1",
    filing_status: status,
    filing_date: "2026-07-18T00:00:00.000",
    current_status_date: "2026-07-20T03:49:32.000",
    first_permit_date: "2026-07-19T00:00:00.000",
    job_type: "New Building",
    building_type: "2 Family",
    owner_type: "Corporation",
    owner_s_business_name: "Stout Homes Inc",
    owner_first_name: "Private",
    owner_last_name: "Homeowner",
    applicant_professional_title: "RA",
    applicant_license: "033343",
    applicant_first_name: "Private",
    applicant_last_name: "Architect",
    applicant_business_name: "Think Design Architecture LLC",
    filing_representative_business_name: "Permit Expediting Services LLC",
    total_construction_floor_area: "4200",
    existing_dwelling_units: "0",
    proposed_dwelling_units: "2",
    house_no: "49",
    street_name: "TARGEE STREET",
    borough: "Staten Island",
    postcode: "10304",
    initial_cost: "$975,000",
    job_description: "Construct a new two-family residential building",
    general_construction_work_type_: "General Construction",
  };
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.searchParams.get("$select") === "count(*) as count") {
      return Response.json([{ count: "1" }]);
    }
    return Response.json([{ ...baseRow, ...businessOverrides, filing_status: status }]);
  };

  try {
    const result = await fetchSocrataCitySource("nyc-dob-now-job-filings", {
      mode: "ingest",
      lane: "backfill",
    });
    const project = result.projects[0];
    assert.equal(project.stage, "design");
    assert.equal(project.address, "49 TARGEE STREET");
    assert.equal(project.postalCode, "10304");
    assert.equal(project.value, 975000);
    assert.match(project.summary, /2 Family/);
    assert.match(project.summary, /First permit 2026-07-19/);
    assert.ok(
      project.participants.some(
        (participant) =>
          participant.role === "owner" &&
          participant.name === "Stout Homes Inc" &&
          participant.participantType === "organization" &&
          participant.sourceUrl === project.sourceUrl,
      ),
    );
    assert.ok(
      project.participants.some(
        (participant) =>
          participant.role === "architect" &&
          participant.name === "Think Design Architecture LLC" &&
          participant.organization === "Think Design Architecture LLC",
      ),
    );
    assert.doesNotMatch(JSON.stringify(project), /Private Homeowner|Private Architect/);
    assert.ok(project.searchableFields.includes("2 Family"));
    assert.ok(project.searchableFields.includes("4200"));
    assert.ok(project.searchableFields.includes("2"));
    assert.ok(project.searchableFields.includes("033343"));
    assert.ok(project.searchableFields.includes("Permit Expediting Services LLC"));
    const recordsGuide = project.documents.find((document) =>
      document.name.includes("official records-request guide"),
    );
    assert.equal(
      recordsGuide?.url,
      "https://www.nyc.gov/assets/buildings/pdf/records_request_user_guide.pdf",
    );
    assert.equal(recordsGuide?.kind, "source-record");
    assert.equal(recordsGuide?.access, "public");
    assert.equal(recordsGuide?.indexStatus, "metadata-only");
    assert.match(recordsGuide?.name ?? "", /S01352118.*records-request guide/i);
    assert.equal(
      project.documents.some((document) => document.kind === "plans"),
      false,
    );

    status = "Approved";
    const approved = await fetchSocrataCitySource("nyc-dob-now-job-filings", {
      mode: "ingest",
      lane: "backfill",
    });
    assert.equal(approved.projects[0].stage, "permitting");

    status = "Permit Entire";
    const permitted = await fetchSocrataCitySource("nyc-dob-now-job-filings", {
      mode: "ingest",
      lane: "backfill",
    });
    assert.equal(permitted.projects[0].stage, "construction");

    businessOverrides = {
      owner_s_business_name: "Abhishek Desai",
      applicant_business_name: "JOSEPH GIANNETTI ARCHITECT",
      filing_representative_business_name: "MICHAEL DEPASQUALE, ARCHITECT",
    };
    const personValuedBusinessFields = await fetchSocrataCitySource(
      "nyc-dob-now-job-filings",
      { mode: "ingest", lane: "backfill" },
    );
    const privateProject = personValuedBusinessFields.projects[0];
    const serialized = JSON.stringify(privateProject);
    assert.doesNotMatch(
      serialized,
      /Abhishek Desai|JOSEPH GIANNETTI ARCHITECT|MICHAEL DEPASQUALE, ARCHITECT/,
    );
    assert.deepEqual(
      privateProject.participants.map(({ name, role }) => ({ name, role })),
      [{ name: "New York City Department of Buildings", role: "agency" }],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NYC approved permits publish business owners and explicit GC permittees without exposing people", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    if (url.searchParams.get("$select") === "count(*) as count") {
      return Response.json([{ count: "1" }]);
    }
    return Response.json([{
      ...samples["rbx6-tga4"],
      ":id": "row-gc-evidence",
      permit_status: "Permit Issued",
      owner_business_name: "Hudson Property Holdings LLC",
      owner_name: "Private Owner Person",
      applicant_business_name: "Hudson Construction Corp",
      applicant_first_name: "Private",
      applicant_last_name: "Permittee",
      permittee_s_license_type: "GC",
      applicant_license: "GC-991122",
    }]);
  };

  try {
    const result = await fetchSocrataCitySource("nyc-dob-now-approved-permits", {
      mode: "ingest",
      lane: "backfill",
    });
    const project = result.projects[0];
    assert.equal(project.stage, "construction");
    assert.ok(project.participants.some((participant) =>
      participant.role === "owner" &&
      participant.name === "Hudson Property Holdings LLC" &&
      participant.sourceUrl === project.sourceUrl));
    assert.ok(project.participants.some((participant) =>
      participant.role === "contractor" &&
      participant.name === "Hudson Construction Corp" &&
      participant.sourceUrl === project.sourceUrl));
    assert.doesNotMatch(JSON.stringify(project), /Private Owner Person|Private Permittee/);
    assert.ok(project.searchableFields.includes("GC-991122"));
    const rowCall = calls.find((call) => call.searchParams.get("$select") !== "count(*) as count");
    assert.match(rowCall.searchParams.get("$where") ?? "", /issued_date is not null/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("New Jersey statewide permits preserve the municipal-record handoff without inventing an owner or contractor", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return Response.json(
      url.searchParams.get("$select") === "count(*) as count"
        ? [{ count: "1" }]
        : [{
            ...samples["w9se-dmra"],
            pk: "010100000003",
            status: "P",
            permitstatusdesc: "Permit",
            permitno: "2026-0042",
            constcost: "750000",
            squarefeet: "12000",
            usegroupdesc: "Business",
          }],
    );
  };

  try {
    const result = await fetchSocrataCitySource("new-jersey-construction-permits", {
      mode: "ingest",
      lane: "backfill",
    });
    const project = result.projects[0];
    assert.equal(project.stage, "permitting");
    assert.equal(project.state, "NJ");
    assert.equal(project.value, 750000);
    assert.match(project.summary, /require the municipal permit record/i);
    assert.deepEqual(project.participants.map(({ role }) => role), ["agency"]);
    assert.ok(project.documents.some((document) =>
      document.url.includes("muniroster.pdf") && document.kind === "source-record"));
    assert.equal(project.participants.some(({ role }) => role === "owner" || role === "contractor"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NYC DOB exact lookup accepts only canonical Socrata row identities and never substitutes a filing", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const recordId = "row-j5dr.qnff-svn2";
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    return Response.json([
      {
        ":id": recordId,
        job_filing_number: "S01352118-S1",
        filing_status: "Pending Prof Cert QA Assignment",
        current_status_date: "2026-07-20T03:49:32.000",
        filing_date: "2026-07-18T00:00:00.000",
        job_type: "New Building",
        building_type: "2 Family",
      },
    ]);
  };

  try {
    for (const invalid of [
      "row-j5dr.qnff-svn2 ",
      " row-j5dr.qnff-svn2",
      "row-j5dr.qnff-svn2' OR 1=1",
      "S01352118-S1",
      "row-a",
    ]) {
      assert.equal(
        await lookupSocrataCityProject(`nyc-dob-now-job-filings:${invalid}`),
        null,
      );
    }
    assert.equal(calls.length, 0);

    const project = await lookupSocrataCityProject(
      `nyc-dob-now-job-filings:${recordId}`,
    );
    assert.equal(project?.sourceRecordId, recordId);
    assert.equal(project?.id, `nyc-dob-now-job-filings:${recordId}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hostname, "data.cityofnewyork.us");
    assert.equal(calls[0].pathname, "/resource/w9ak-ipjd.json");
    assert.equal(calls[0].searchParams.get("$limit"), "2");
    assert.equal(calls[0].searchParams.get("$offset"), "0");
    assert.equal(calls[0].searchParams.get("$order"), ":id ASC");
    assert.equal(calls[0].searchParams.get("$where"), `(:id = '${recordId}')`);
    assert.match(project?.sourceUrl ?? "", /%3Aid|%3Aid/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("source-specific permit statuses do not turn active review into completed work", async () => {
  const statusSamples = {
    "w9ak-ipjd": {
      ...samples["w9ak-ipjd"],
      ":id": "row-intent-revoke",
      job_filing_number: "B00000003-I1",
      filing_status: "Intent to Revoke",
    },
    "rbx6-tga4": {
      ...samples["rbx6-tga4"],
      ":id": "row-issued-permit",
      permit_status: "Permit Issued",
    },
    "w9se-dmra": {
      ...samples["w9se-dmra"],
      pk: "010100000002",
      status: "P",
      permitstatusdesc: "Permit",
      certdate: undefined,
    },
    "ydr8-5enu": {
      ...samples["ydr8-5enu"],
      id: "C2",
      permit_: "P2",
      permit_status: "ACTIVE",
      permit_milestone: "CERTIFICATE OF OCCUPANCY PENDING",
    },
    "gwh9-jnip": {
      ...samples["gwh9-jnip"],
      permit_nbr: "26010-10000-09999",
      status_desc: "Corrections Issued",
      status_date: "2026-07-16T00:00:00.000",
    },
    "3syk-w9eu": {
      ...samples["3syk-w9eu"],
      permit_number: "A2",
      status_current: "Aborted",
    },
    "i98e-djp9": {
      ...samples["i98e-djp9"],
      record_id: "S2",
      permit_number: "SF2",
      status: "plancheck",
      last_permit_activity_date: "2020-01-03T00:00:00.000",
      data_loaded_at: "2026-07-16T00:00:00.000",
    },
  };
  const expectedStages = {
    "nyc-dob-now-job-filings": "design",
    "nyc-dob-now-approved-permits": "construction",
    "new-jersey-construction-permits": "permitting",
    "los-angeles-building-permits-submitted": "design",
    "chicago-building-permits": "permitting",
    "austin-issued-construction-permits": "cancelled",
    "san-francisco-building-permits": "design",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.searchParams.get("$select") === "count(*) as count") {
      return Response.json([{ count: "1" }]);
    }
    const datasetId = url.pathname.split("/").at(-1).replace(/\.json$/, "");
    return Response.json([statusSamples[datasetId]]);
  };

  try {
    for (const sourceId of SOCRATA_CITY_SOURCE_IDS.filter(
      (sourceId) => sourceId !== "nyc-city-record-construction-procurement",
    )) {
      const result = await fetchSocrataCitySource(sourceId, {
        mode: "ingest",
        lane: "backfill",
      });
      assert.equal(result.projects[0].stage, expectedStages[sourceId]);
      if (sourceId === "san-francisco-building-permits") {
        assert.equal(result.projects[0].updatedAt, "2020-01-03T00:00:00.000Z");
      }
    }
    statusSamples["i98e-djp9"].status = "unknown";
    const unknownResult = await fetchSocrataCitySource("san-francisco-building-permits", {
      mode: "ingest",
      lane: "backfill",
    });
    assert.equal(unknownResult.projects[0].stage, "unclassified");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Los Angeles permit adapter exposes private residential and commercial source classifications without inventing plan access", async () => {
  const originalFetch = globalThis.fetch;
  let row = {
    ...samples["gwh9-jnip"],
    status_desc: "PC in Progress",
    permit_sub_type: "1 or 2 Family Dwelling",
  };
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return Response.json(
      url.searchParams.get("$select") === "count(*) as count"
        ? [{ count: "297171" }]
        : [row],
    );
  };

  try {
    const residential = await fetchSocrataCitySource(
      "los-angeles-building-permits-submitted",
      { mode: "ingest", lane: "backfill" },
    );
    assert.equal(residential.source.recordCount, 297171);
    assert.equal(residential.projects[0].stage, "design");
    assert.equal(residential.projects[0].city, "Los Angeles");
    assert.equal(residential.projects[0].state, "CA");
    assert.equal(residential.projects[0].value, 850000);
    assert.ok(residential.projects[0].searchableFields.includes("1 or 2 Family Dwelling"));
    assert.equal(
      residential.projects[0].documents.some((document) => document.kind === "plans"),
      false,
    );
    assert.ok(
      residential.projects[0].documents.some(
        (document) => document.url === "https://ladbsdoc.lacity.org/",
      ),
    );

    row = {
      ...row,
      permit_nbr: "26010-10000-09998",
      permit_sub_type: "Commercial",
      status_desc: "Issued",
    };
    const commercial = await fetchSocrataCitySource(
      "los-angeles-building-permits-submitted",
      { mode: "ingest", lane: "backfill" },
    );
    assert.equal(commercial.projects[0].stage, "construction");
    assert.ok(commercial.projects[0].searchableFields.includes("Commercial"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generic city deep links resolve one exact official permit without substituting another record", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    return Response.json([{ ...samples["gwh9-jnip"], status_desc: "PC in Progress" }]);
  };

  try {
    assert.equal(
      await lookupSocrataCityProject("los-angeles-building-permits-submitted:bad\nidentity"),
      null,
    );
    assert.equal(calls.length, 0);

    const recordId = samples["gwh9-jnip"].permit_nbr;
    const project = await lookupSocrataCityProject(
      `los-angeles-building-permits-submitted:${recordId}`,
    );
    assert.equal(project?.sourceRecordId, recordId);
    assert.equal(project?.stage, "design");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hostname, "data.lacity.org");
    assert.equal(calls[0].searchParams.get("$limit"), "2");
    assert.match(calls[0].searchParams.get("$where") ?? "", /permit_nbr = '26010-10000-01234'/);

    assert.equal(await lookupSocrataCityProject("unknown-source:anything"), null);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public permit adapters do not aggregate private applicant names as outreach contacts", async () => {
  const privateRows = {
    "w9ak-ipjd": {
      ...samples["w9ak-ipjd"],
      ":id": "privacy-nyc",
      job_filing_number: "B-PRIVACY",
      filing_status: "In Review",
      applicant_professional_title: "Architect",
      applicant_first_name: "Private",
      applicant_last_name: "Applicant",
      applicant_business_name: "Studio North Architects LLC",
    },
    "ydr8-5enu": {
      ...samples["ydr8-5enu"],
      id: "privacy-chicago",
      permit_: "P-PRIVACY",
      permit_status: "ACTIVE",
      contact_1_type: "Owner",
      contact_1_name: "Private Homeowner",
      contact_2_type: "Architect",
      contact_2_name: "Studio North Architects LLC",
    },
    "3syk-w9eu": {
      ...samples["3syk-w9eu"],
      permit_number: "A-PRIVACY",
      status_current: "Active",
      contractor_full_name: "Private Contractor Person",
      applicant_full_name: "Private Austin Applicant",
      applicant_org: "Applicant Organization LLC",
      link: "javascript:alert(1)",
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.searchParams.get("$select") === "count(*) as count") {
      return Response.json([{ count: "1" }]);
    }
    const datasetId = url.pathname.split("/").at(-1).replace(/\.json$/, "");
    return Response.json([privateRows[datasetId]]);
  };

  try {
    for (const sourceId of [
      "nyc-dob-now-job-filings",
      "chicago-building-permits",
      "austin-issued-construction-permits",
    ]) {
      const result = await fetchSocrataCitySource(sourceId, {
        mode: "ingest",
        lane: "backfill",
      });
      const serialized = JSON.stringify(result.projects[0]);
      assert.doesNotMatch(serialized, /Private Applicant|Private Homeowner|Private Contractor Person|Private Austin Applicant/);
    }

    const chicago = await fetchSocrataCitySource("chicago-building-permits", {
      mode: "ingest",
      lane: "backfill",
    });
    assert.ok(
      chicago.projects[0].participants.some(
        (participant) =>
          participant.role === "architect" && participant.name === "Studio North Architects LLC",
      ),
    );

    const austin = await fetchSocrataCitySource("austin-issued-construction-permits", {
      mode: "ingest",
      lane: "backfill",
    });
    assert.match(austin.projects[0].sourceUrl, /^https:\/\/data\.austintexas\.gov\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NYC City Record maps procurement notices, official contacts, gated attachments, and awards truthfully", async () => {
  const solicitation = {
    request_id: "20260313031",
    start_date: "2026-04-01T00:00:00.000",
    end_date: "2026-04-01T00:00:00.000",
    agency_name: "Environmental Protection",
    type_of_notice_description: "Solicitation",
    category_description: "Construction Related Services",
    short_title: "In-City Dam Rehabilitation",
    selection_method_description: "Competitive Sealed Bids/Pre-Qualified List",
    section_name: "Procurement",
    pin: "82626B0001",
    due_date: "2026-05-27T10:00:00.000",
    contact_name: "Ping Zhi Chan",
    contact_phone: "(718) 555-2410",
    email: "PZChan@dep.nyc.gov",
    additional_description_1:
      "<p>Install a new canopy &amp; modify site lighting. Documents are in PASSPort.</p><script>alert('unsafe')</script>",
    document_links: {
      url:
        "https://a856-cityrecord.nyc.gov/Search/GetFile?SectionID=6&amp;RequestID=20260313031&amp;DocumentID=1,https://evil.example/pretend-plans.pdf",
    },
  };
  const award = {
    ...solicitation,
    request_id: "20260710005",
    start_date: "2026-07-16T00:00:00.000",
    type_of_notice_description: "Award",
    short_title: "Reconstruction of Existing Sewers",
    due_date: undefined,
    contract_amount: "5977664",
    vendor_name: "ADC Construction LLC",
    document_links: undefined,
  };
  let activeRow = solicitation;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    return Response.json(
      url.searchParams.get("$select") === "count(*) as count"
        ? [{ count: "23067" }]
        : [activeRow],
    );
  };

  try {
    const solicitationResult = await fetchSocrataCitySource(
      "nyc-city-record-construction-procurement",
      { mode: "ingest", lane: "backfill" },
    );
    const project = solicitationResult.projects[0];
    assert.equal(project.stage, "bidding");
    assert.equal(project.bidDate, "2026-05-27T14:00:00.000Z");
    assert.equal(project.bidDateTimeZone, "America/New_York");
    assert.equal(
      project.sourceUrl,
      "https://a856-cityrecord.nyc.gov/RequestDetail/20260313031",
    );
    assert.match(project.summary, /Install a new canopy & modify site lighting/);
    assert.doesNotMatch(JSON.stringify(project), /<p>|<script>|alert\('unsafe'\)/);
    const contact = project.participants.find(
      (participant) => participant.participantType === "person",
    );
    assert.deepEqual(contact, {
      name: "Ping Zhi Chan",
      role: "agency",
      participantType: "person",
      organization: "Environmental Protection",
      email: "pzchan@dep.nyc.gov",
      phone: "(718) 555-2410",
      sourceUrl: "https://a856-cityrecord.nyc.gov/RequestDetail/20260313031",
    });
    const attachments = project.documents.filter(
      (document) => document.name.startsWith("City Record attachment"),
    );
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].kind, "source-record");
    assert.equal(attachments[0].access, "free-account");
    assert.equal(attachments[0].indexStatus, "account-gated");
    assert.doesNotMatch(attachments[0].name, /plan|drawing|specification/i);
    assert.doesNotMatch(JSON.stringify(project.documents), /evil\.example/);
    const passportPortal = project.documents.find((document) =>
      document.url.includes("passport.cityofnewyork.us/page.aspx/en/rfp/request_browse_public"),
    );
    assert.equal(passportPortal?.access, "free-account");
    assert.equal(passportPortal?.indexStatus, "account-gated");
    assert.equal(passportPortal?.kind, "source-record");

    const dataCall = calls.find(
      (url) =>
        url.pathname.endsWith("/dg92-zbpx.json") &&
        url.searchParams.get("$select") !== "count(*) as count",
    );
    assert.ok(dataCall);
    assert.match(dataCall.searchParams.get("$where") ?? "", /section_name = 'Procurement'/);
    assert.doesNotMatch(dataCall.searchParams.get("$where") ?? "", /category_description/);
    assert.equal(dataCall.searchParams.get("$order"), "request_id ASC");

    activeRow = award;
    const awardResult = await fetchSocrataCitySource(
      "nyc-city-record-construction-procurement",
      { mode: "ingest", lane: "backfill" },
    );
    assert.equal(awardResult.projects[0].stage, "awarded");
    assert.equal(awardResult.projects[0].value, 5_977_664);
    assert.ok(
      awardResult.projects[0].participants.some(
        (participant) =>
          participant.role === "contractor" &&
          participant.name === "ADC Construction LLC" &&
          participant.organization === "ADC Construction LLC",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NYC current procurement universe retains long-term and open-ended opportunities without false deadline buckets", async () => {
  const rows = [
    {
      request_id: "20260716001",
      start_date: "2026-07-01T00:00:00.000",
      agency_name: "Design and Construction",
      type_of_notice_description: "Solicitation",
      category_description: "Construction/Construction Services",
      short_title: "Earlier due construction solicitation",
      section_name: "Procurement",
      due_date: "2026-07-17T09:00:00.000",
      additional_description_1: "Vendors shall upload the bid into iSupplier.",
    },
    {
      request_id: "20260716002",
      start_date: "2026-06-01T00:00:00.000",
      agency_name: "Environmental Protection",
      type_of_notice_description: "Solicitation",
      category_description: "Construction Related Services",
      short_title: "Later due construction solicitation",
      section_name: "Procurement",
      due_date: "2026-08-01T10:00:00.000",
    },
    {
      request_id: "20260716003",
      start_date: "2026-07-10T00:00:00.000",
      agency_name: "Design and Construction",
      type_of_notice_description: "Solicitation",
      category_description: "Services (other than human services)",
      short_title: "Long-lived but plausible prequalified list",
      section_name: "Procurement",
      due_date: "2030-07-31T17:00:00.000",
    },
    {
      request_id: "20260716004",
      start_date: "2026-07-10T00:00:00.000",
      agency_name: "Design and Construction",
      type_of_notice_description: "Solicitation",
      category_description: "Goods and Services",
      short_title: "Recently published long-term qualification opportunity",
      section_name: "Procurement",
      due_date: "2040-12-31T23:59:00.000",
    },
    {
      request_id: "20260716005",
      start_date: "2015-07-10T00:00:00.000",
      agency_name: "Design and Construction",
      type_of_notice_description: "Solicitation",
      category_description: "Construction/Construction Services",
      short_title: "Older open-ended construction list",
      section_name: "Procurement",
      due_date: "2040-12-31T23:59:00.000",
    },
    {
      request_id: "20260716006",
      start_date: "2026-07-10T00:00:00.000",
      agency_name: "Design and Construction",
      type_of_notice_description: "Solicitation",
      category_description: "Goods and Services",
      short_title: "Administrative sentinel year",
      section_name: "Procurement",
      due_date: "2099-12-31T23:59:00.000",
    },
  ];
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    return Response.json(
      url.searchParams.get("$select") === "count(*) as count"
        ? [{ count: "600" }]
        : rows,
    );
  };

  try {
    const result = await fetchNycCityRecordCurrentConstructionSolicitations(
      999,
      // This instant is still July 15 in New York. The source query must not
      // jump to July 16 merely because the worker clock is already there.
      new Date("2026-07-16T02:00:00.000Z"),
    );
    assert.equal(result.sourceId, "nyc-city-record-construction-procurement");
    assert.equal(result.sourceReportedMatches, 600);
    assert.equal(result.returnedProjects, 6);
    assert.equal(result.resultLimitReached, true);
    assert.equal(result.sourceTimeZone, "America/New_York");
    assert.equal(result.asOfSourceDayStart, "2026-07-15T04:00:00.000Z");
    assert.deepEqual(
      result.projects.map((project) => project.id),
      [
        "nyc-city-record-construction-procurement:20260716001",
        "nyc-city-record-construction-procurement:20260716002",
        "nyc-city-record-construction-procurement:20260716003",
        "nyc-city-record-construction-procurement:20260716004",
        "nyc-city-record-construction-procurement:20260716005",
        "nyc-city-record-construction-procurement:20260716006",
      ],
    );
    assert.ok(result.projects.every((project) => project.stage === "bidding"));
    assert.equal(result.projects[3].bidDate, "2041-01-01T04:59:00.000Z");
    assert.equal(result.projects[4].bidDate, undefined);
    assert.match(result.projects[4].summary ?? "", /open-ended or administrative/i);
    assert.equal(result.projects[5].bidDate, undefined);
    assert.match(result.projects[5].summary ?? "", /open-ended or administrative/i);
    const supplierRoute = result.projects[0].documents.find((document) =>
      document.url.includes("isupplier-vendor-registration.page"),
    );
    assert.equal(supplierRoute?.access, "free-account");
    assert.equal(supplierRoute?.indexStatus, "account-gated");
    assert.equal(
      result.projects[0].documents.some((document) =>
        document.url.includes("passport.cityofnewyork.us"),
      ),
      false,
    );

    const rowCall = calls.find(
      (url) => url.searchParams.get("$select") !== "count(*) as count",
    );
    const countCall = calls.find(
      (url) => url.searchParams.get("$select") === "count(*) as count",
    );
    assert.ok(rowCall);
    assert.ok(countCall);
    assert.equal(rowCall.searchParams.get("$limit"), "500");
    assert.equal(rowCall.searchParams.get("$offset"), "0");
    assert.equal(rowCall.searchParams.get("$order"), "due_date ASC, request_id ASC");
    const where = rowCall.searchParams.get("$where") ?? "";
    assert.equal(countCall.searchParams.get("$where"), where);
    assert.match(where, /section_name = 'Procurement'/);
    assert.doesNotMatch(where, /category_description/);
    assert.match(where, /type_of_notice_description = 'Solicitation'/);
    assert.match(where, /due_date >= '2026-07-15T00:00:00\.000'/);
    assert.doesNotMatch(where, /due_date </);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NYC City Record exact lookup accepts only a bounded canonical request ID", async () => {
  const row = {
    request_id: "20260313031",
    start_date: "2026-04-01T00:00:00.000",
    agency_name: "Environmental Protection",
    type_of_notice_description: "Solicitation",
    category_description: "Construction Related Services",
    short_title: "Exact construction lookup",
    section_name: "Procurement",
    due_date: "2026-05-27T10:00:00.000",
  };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    return Response.json([row]);
  };

  try {
    assert.equal(await lookupNycCityRecordConstructionProject("other-source:20260313031"), null);
    assert.equal(
      await lookupNycCityRecordConstructionProject(
        "nyc-city-record-construction-procurement:20260313031' OR 1=1",
      ),
      null,
    );
    assert.equal(calls.length, 0);

    const project = await lookupNycCityRecordConstructionProject(
      "nyc-city-record-construction-procurement:20260313031",
    );
    assert.equal(
      project?.id,
      "nyc-city-record-construction-procurement:20260313031",
    );
    assert.equal(project?.sourceRecordId, "20260313031");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, "/resource/dg92-zbpx.json");
    assert.equal(calls[0].searchParams.get("$limit"), "2");
    assert.equal(calls[0].searchParams.get("$offset"), "0");
    assert.equal(calls[0].searchParams.get("$order"), "request_id ASC");
    const where = calls[0].searchParams.get("$where") ?? "";
    assert.match(where, /section_name = 'Procurement'/);
    assert.doesNotMatch(where, /category_description/);
    assert.match(where, /request_id = '20260313031'/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
