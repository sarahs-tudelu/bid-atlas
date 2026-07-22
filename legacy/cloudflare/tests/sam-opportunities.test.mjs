import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./ts-extension-loader.mjs", import.meta.url));

const {
  getProjectFeed,
  lookupSamOpportunityProject,
  resolveSamOpportunityDescriptionUrl,
  resolveSamOpportunityResourceUrl,
} = await import("../app/lib/connectors.ts");

const SAM_SOURCE_ID = "sam-contract-opportunities";
const NOTICE_ID = "f5d34ce0b1cd4cb29008a8f011223344";

function samRow(overrides = {}) {
  return {
    noticeId: NOTICE_ID,
    title: "Construct a new federal operations building",
    solicitationNumber: "47PB0026R0042",
    fullParentPathName: "GENERAL SERVICES ADMINISTRATION.PUBLIC BUILDINGS SERVICE",
    fullParentPathCode: "047.PBS",
    postedDate: "2026-07-15",
    type: "Solicitation",
    baseType: "Presolicitation",
    active: "Yes",
    responseDeadLine: "2026-08-14T15:00:00-04:00",
    naicsCode: "236220",
    classificationCode: "Y1AA",
    typeOfSetAsideDescription: "Total Small Business Set-Aside",
    description: `https://api.sam.gov/opportunities/v1/noticedesc?noticeid=${NOTICE_ID}&api_key=UPSTREAM-SECRET`,
    resourceLinks: [
      `https://api.sam.gov/opportunities/v1/download?noticeid=${NOTICE_ID}&file=plans.pdf&api_key=UPSTREAM-SECRET`,
      "https://evil.example/not-a-sam-attachment.pdf?api_key=UPSTREAM-SECRET",
    ],
    additionalInfoLink: "https://piee.eb.mil/sol/xhtml/unauth/index.xhtml",
    data: {
      placeOfPerformance: {
        streetAddress: "100 Federal Plaza",
        city: { name: "Atlanta" },
        state: { code: "GA", name: "Georgia" },
        zip: "30303",
      },
      pointOfContact: [
        {
          type: "primary",
          title: "Contract Specialist",
          fullName: "Jordan Official",
          email: "Jordan.Official@GSA.gov",
          phone: "202-555-0199",
        },
      ],
    },
    ...overrides,
  };
}

function response(rows, totalRecords = rows.length) {
  return Response.json({ totalRecords, limit: 250, offset: 0, opportunitiesData: rows });
}

test("SAM connector maps federal contacts, scope facets, locations, deadlines, and account-gated assets without leaking keys", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    return response([samRow()], 8421);
  };
  try {
    const apiKey = "sam-behavior-key-contacts-0001";
    const feed = await getProjectFeed({
      sourceId: SAM_SOURCE_ID,
      samApiKey: apiKey,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].origin, "https://api.sam.gov");
    assert.equal(calls[0].pathname, "/opportunities/v2/search");
    assert.equal(calls[0].searchParams.get("api_key"), apiKey);
    assert.equal(calls[0].searchParams.get("ncode"), "23");
    assert.equal(calls[0].searchParams.get("limit"), "250");
    assert.equal(calls[0].searchParams.get("offset"), "0");
    assert.deepEqual(calls[0].searchParams.getAll("ptype"), ["p", "o", "k", "r", "a", "s", "i", "u"]);

    const source = feed.sources.find((candidate) => candidate.id === SAM_SOURCE_ID);
    assert.equal(source?.recordCount, 8421);
    assert.equal(source?.loadedCount, 1);
    const project = feed.projects[0];
    assert.equal(project.id, `${SAM_SOURCE_ID}:${NOTICE_ID}`);
    assert.equal(project.stage, "bidding");
    assert.equal(project.state, "GA");
    assert.equal(project.city, "Atlanta");
    assert.equal(project.postalCode, "30303");
    assert.equal(project.bidDate, "2026-08-14T19:00:00.000Z");
    assert.match(project.summary, /236220/);
    assert.ok(project.searchableFields.includes("Y1AA"));
    assert.ok(project.searchableFields.includes("Total Small Business Set-Aside"));
    assert.deepEqual(
      project.participants.find((participant) => participant.participantType === "person"),
      {
        name: "Jordan Official",
        role: "agency",
        participantType: "person",
        organization: "GENERAL SERVICES ADMINISTRATION.PUBLIC BUILDINGS SERVICE",
        email: "jordan.official@gsa.gov",
        phone: "202-555-0199",
        sourceUrl: `https://sam.gov/opp/${NOTICE_ID}/view`,
      },
    );
    assert.ok(
      project.documents.some(
        (document) =>
          document.url === `/api/sam/opportunities/${NOTICE_ID}/description` &&
          document.kind === "source-record" &&
          document.access === "free-account" &&
          document.indexStatus === "account-gated",
      ),
    );
    assert.ok(
      project.documents.some(
        (document) =>
          document.url === `/api/sam/opportunities/${NOTICE_ID}/resources/0` &&
          document.kind === "source-record",
      ),
    );
    assert.equal(project.documents.some((document) => document.url.includes("evil.example")), false);
    const serialized = JSON.stringify(feed);
    assert.doesNotMatch(serialized, /UPSTREAM-SECRET|sam-behavior-key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SAM connector does not invent a deadline timezone and labels inactive publication state separately from physical completion", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response([
    samRow({
      noticeId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      active: "No",
      type: "Presolicitation",
      responseDeadLine: "2026-08-14T15:00:00",
      resourceLinks: [],
      description: null,
    }),
  ]);
  try {
    const feed = await getProjectFeed({
      sourceId: SAM_SOURCE_ID,
      samApiKey: "sam-behavior-key-inactive-0002",
    });
    const project = feed.projects[0];
    assert.equal(project.bidDate, undefined);
    assert.equal(project.stage, "cancelled");
    assert.match(project.status, /Inactive\/archived/);
    assert.match(project.summary, /physical-project cancellation is not established/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SAM interactive cache stays inside hourly cadence and preserves the real upstream check time", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response([samRow({ noticeId: "cache-check-20260716" })], 1);
  };
  try {
    const options = {
      sourceId: SAM_SOURCE_ID,
      samApiKey: "sam-cache-time-key-0005",
    };
    const first = await getProjectFeed(options);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await getProjectFeed(options);
    const firstSource = first.sources.find((source) => source.id === SAM_SOURCE_ID);
    const secondSource = second.sources.find((source) => source.id === SAM_SOURCE_ID);
    assert.equal(calls, 1);
    assert.equal(firstSource?.cadence, "Every hour");
    assert.equal(secondSource?.lastChecked, firstSource?.lastChecked);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SAM exact lookup and asset resolvers validate identities and strip every API key from returned URLs", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    return Response.json({ totalRecords: 1, limit: 2, offset: 0, opportunitiesData: [samRow()] });
  };
  try {
    const apiKey = "sam-exact-sensitive-key-0003";
    assert.equal(await lookupSamOpportunityProject("wrong-source:bad", apiKey), null);
    assert.equal(calls.length, 0);

    const project = await lookupSamOpportunityProject(`${SAM_SOURCE_ID}:${NOTICE_ID}`, apiKey);
    assert.equal(project?.sourceRecordId, NOTICE_ID);
    assert.equal(calls[0].searchParams.get("noticeid"), NOTICE_ID);
    assert.equal(calls[0].searchParams.get("limit"), "2");
    assert.equal(calls[0].searchParams.has("ncode"), false);

    const resource = await resolveSamOpportunityResourceUrl(NOTICE_ID, 0, apiKey);
    assert.equal(
      resource,
      `https://api.sam.gov/opportunities/v1/download?noticeid=${NOTICE_ID}&file=plans.pdf`,
    );
    const description = await resolveSamOpportunityDescriptionUrl(NOTICE_ID, apiKey);
    assert.equal(
      description,
      `https://api.sam.gov/opportunities/v1/noticedesc?noticeid=${NOTICE_ID}`,
    );
    assert.equal((resource + description).includes(apiKey), false);
    assert.equal((resource + description).includes("UPSTREAM-SECRET"), false);
    assert.equal(await resolveSamOpportunityResourceUrl(NOTICE_ID, -1, apiKey), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SAM response validation fails closed and the attachment proxy keeps credentials server-side", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ opportunitiesData: [] });
  try {
    const feed = await getProjectFeed({
      sourceId: SAM_SOURCE_ID,
      samApiKey: "sam-behavior-key-malformed-0004",
    });
    assert.equal(feed.projects.length, 0);
    assert.equal(
      feed.sources.find((candidate) => candidate.id === SAM_SOURCE_ID)?.status,
      "degraded",
    );
    assert.match(feed.warnings.join("\n"), /valid totalRecords/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const [proxy, descriptionRoute, resourceRoute] = await Promise.all([
    readFile(new URL("../app/lib/sam-asset-proxy.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/sam/opportunities/[noticeId]/description/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/sam/opportunities/[noticeId]/resources/[resourceIndex]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(proxy, /actor\.kind !== "workspace-user"/);
  assert.match(proxy, /resolveIntegrationCredential\(actor\.id, "sam"\)/);
  assert.match(proxy, /url\.searchParams\.set\("api_key", apiKey\)/);
  assert.match(proxy, /url\.port && url\.port !== "443"/);
  assert.match(proxy, /redirect: "manual"/);
  assert.match(proxy, /sam_notice_lookup_failed/);
  assert.match(proxy, /function safeAttachmentToken/);
  assert.match(proxy, /safeAttachmentToken\(noticeId\)/);
  assert.match(proxy, /Content-Disposition/);
  assert.match(proxy, /Content-Security-Policy/);
  assert.doesNotMatch(descriptionRoute + resourceRoute, /api_key/);
});
