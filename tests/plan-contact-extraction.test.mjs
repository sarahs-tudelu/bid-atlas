import assert from "node:assert/strict";
import test from "node:test";

const {
  PLAN_CONTACT_EXTRACTION_CAPABILITY,
  parsePlanContactCandidates,
} = await import("../app/lib/plan-contact-extraction.ts");

function chunk(chunkText, overrides = {}) {
  return {
    id: "chunk-7",
    projectId: "project-1",
    documentVersionId: "version-2",
    extractionId: "extraction-3",
    chunkOrder: 7,
    pageStart: 4,
    pageEnd: 4,
    chunkText,
    sourceUrl: "https://agency.gov/plans/project-1.pdf",
    ...overrides,
  };
}

test("extracts only explicitly labeled title-block contacts with page provenance", () => {
  const candidates = parsePlanContactCandidates([
    chunk(`
OWNER: Harbor View Development LLC
Contact: Maria Lopez
Email: maria.lopez@harborview.example
Phone: (305) 555-0123 ext. 4

ARCHITECT OF RECORD | Studio North Architects, PLLC
Contact Person: Eli James, AIA
E-mail: ejames@studionorth.example
Tel: 212.555.0198

STRUCTURAL ENGINEER:
Organization: Column Engineering, Inc.
Attn: Dev Patel, P.E.
Email: dpatel@column.example
Direct: +1 (646) 555-0181

CONTRACTING AGENCY - City Capital Projects Department
Phone: 718-555-0175
`),
  ]);

  assert.deepEqual(
    candidates.map((candidate) => candidate.role),
    ["owner", "architect", "engineer", "agency"],
  );
  const owner = candidates[0];
  assert.equal(owner.displayName, "Maria Lopez");
  assert.equal(owner.organizationName, "Harbor View Development LLC");
  assert.equal(owner.email, "maria.lopez@harborview.example");
  assert.equal(owner.phone, "+1 305-555-0123");
  assert.equal(owner.phoneExtension, "4");
  assert.equal(owner.verificationStatus, "unverified");
  assert.ok(owner.confidence < 1);
  assert.equal(owner.evidence.pageStart, 4);
  assert.match(owner.evidence.text, /^OWNER:/);
  assert.deepEqual(owner.provenance, {
    method: "explicit-plan-role-label",
    projectId: "project-1",
    documentVersionId: "version-2",
    extractionId: "extraction-3",
    chunkId: "chunk-7",
    chunkOrder: 7,
    pageStart: 4,
    pageEnd: 4,
    sourceUrl: "https://agency.gov/plans/project-1.pdf",
  });

  const architect = candidates[1];
  assert.equal(architect.displayName, "Eli James, AIA");
  assert.equal(architect.organizationName, "Studio North Architects, PLLC");
  assert.equal(architect.email, "ejames@studionorth.example");

  const engineer = candidates[2];
  assert.equal(engineer.displayName, "Dev Patel, P.E.");
  assert.equal(engineer.organizationName, "Column Engineering, Inc.");

  const agency = candidates[3];
  assert.equal(agency.contactType, "organization");
  assert.equal(agency.displayName, "City Capital Projects Department");
});

test("does not invent roles for unlabeled names, plan holders, or prospective bidders", () => {
  const candidates = parsePlanContactCandidates([
    chunk(`
PLAN HOLDERS: Maybe Builders LLC
Jane Smith, Purchasing Manager
jane.smith@maybe.example
Phone: 404-555-0100

PROSPECTIVE BIDDERS: Example Construction Inc.
DEVELOPER: North Parcel Partners LLC
APPLICANT: Pat Lee
Prepared by: Drawing Studio
`),
  ]);

  assert.deepEqual(candidates, []);
});

test("requires page-aware evidence and a plausible role holder", () => {
  const missingPage = parsePlanContactCandidates([
    chunk("OWNER: Example Properties LLC", { pageStart: null, pageEnd: null }),
  ]);
  const missingHolder = parsePlanContactCandidates([
    chunk("GENERAL CONTRACTOR:\nPhone: 555-555-0101", { id: "chunk-8" }),
  ]);

  assert.deepEqual(missingPage, []);
  assert.deepEqual(missingHolder, []);
});

test("normalizes only valid US phone fields and never treats fax as the contact phone", () => {
  const [candidate] = parsePlanContactCandidates([
    chunk(`
PROJECT ARCHITECT: Avery Design Studio
Email: contact@avery.example
Phone: 555-0199
Fax: (212) 555-0144
`, { id: "chunk-9" }),
  ]);

  assert.equal(candidate.displayName, "Avery Design Studio");
  assert.equal(candidate.email, "contact@avery.example");
  assert.equal(candidate.phone, undefined);
});

test("exposes extraction as parser-ready but disabled until real document text exists", () => {
  assert.equal(PLAN_CONTACT_EXTRACTION_CAPABILITY.status, "queued");
  assert.equal(PLAN_CONTACT_EXTRACTION_CAPABILITY.parserReady, true);
  assert.equal(PLAN_CONTACT_EXTRACTION_CAPABILITY.enabled, false);
  assert.equal(PLAN_CONTACT_EXTRACTION_CAPABILITY.persistence, "disabled");
  assert.match(PLAN_CONTACT_EXTRACTION_CAPABILITY.reason, /No production service/i);
});

test("includes the disabled extraction boundary in integration capability flags", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("plan-contact-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/api/integrations"),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  const flags = await response.json();
  assert.deepEqual(flags.planContactExtraction, PLAN_CONTACT_EXTRACTION_CAPABILITY);
  assert.equal(flags.planContactExtraction.enabled, false);
});
