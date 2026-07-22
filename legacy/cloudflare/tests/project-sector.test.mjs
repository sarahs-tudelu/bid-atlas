import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./ts-extension-loader.mjs", import.meta.url));

const { inferredProjectSectorTags } = await import("../app/lib/project-sector.ts");
const {
  matchedProjectTerms,
  normalizeLocationQuery,
  projectMatchesSearch,
  projectMetadataText,
} = await import("../app/lib/search.ts");

function project(searchableFields) {
  return {
    id: "fixture:1",
    sourceId: "fixture",
    sourceRecordId: "1",
    title: "Official permit",
    summary: "Published source metadata",
    stage: "design",
    status: "In review",
    agency: "Fixture building department",
    updatedAt: "2026-07-15T00:00:00.000Z",
    sourceName: "Fixture permits",
    sourceUrl: "https://example.gov/permits/1",
    provenance: "live-api",
    confidence: "official",
    documents: [],
    participants: [],
    searchableFields,
  };
}

test("sector tags normalize common official residential and commercial categories", () => {
  for (const value of [
    "Dwelling - Single Family",
    "1-2FAM",
    "1-3FAM",
    "Accessory Dwelling Unit (ADU)",
    "Duplex alteration",
  ]) {
    assert.deepEqual(inferredProjectSectorTags(value), ["residential"], value);
  }
  for (const value of ["Comm", "Retail fit-out", "Office and warehouse", "Mercantile"]) {
    assert.deepEqual(inferredProjectSectorTags(value), ["commercial"], value);
  }
  assert.deepEqual(inferredProjectSectorTags("Mixed-use building"), ["residential", "commercial"]);
});

test("compact Boston occupancy values classify only in an authoritative sector field", () => {
  for (const value of ["Multi", "1-4FAM", "1Unit", "7More", "1-7FAM", "2unit", "3unit"]) {
    assert.deepEqual(
      inferredProjectSectorTags(value, { sectorField: true }),
      ["residential"],
      value,
    );
  }

  assert.deepEqual(inferredProjectSectorTags("Mixed", { sectorField: true }), [
    "residential",
    "commercial",
  ]);
  assert.deepEqual(inferredProjectSectorTags("Mixed"), []);
  assert.deepEqual(inferredProjectSectorTags("Multi"), []);
  assert.deepEqual(inferredProjectSectorTags("Replace 2unit rooftop equipment"), []);
});

test("normalized sector tags make source categories searchable without claiming plan coverage", () => {
  const residential = project(["Dwelling - Single Family"]);
  const commercial = project(["Comm"]);
  assert.match(projectMetadataText(residential), /\bresidential\b/);
  assert.match(projectMetadataText(commercial), /\bcommercial\b/);
  assert.equal(projectMatchesSearch(residential, {
    keywords: ["residential"],
    match: "all",
    freshness: "all",
    includeArchived: false,
  }), true);
  assert.equal(projectMatchesSearch(commercial, {
    keywords: ["commercial"],
    match: "all",
    freshness: "all",
    includeArchived: false,
  }), true);
});

test("agency and contact wording cannot manufacture a commercial sector tag", () => {
  const publicWork = {
    ...project(["bridge rehabilitation"]),
    agency: "Regional Contracting Office",
    participants: [{
      name: "Procurement Office",
      role: "agency",
      email: "office@example.gov",
    }],
  };
  assert.equal(projectMatchesSearch(publicWork, {
    keywords: ["commercial"],
    match: "all",
    freshness: "all",
    includeArchived: false,
  }), false);
});

test("live keyword matching uses token and phrase boundaries like quoted FTS", () => {
  const falsePositive = {
    ...project(["Filed schedule for Walmart renovation"]),
    title: "Filed Walmart permit",
  };
  const exact = {
    ...project(["LED partition wall package"]),
    title: "LED wall lighting",
  };
  const options = {
    keywords: ["led", "wall"],
    match: "any",
    freshness: "all",
    includeArchived: false,
  };

  assert.equal(projectMatchesSearch(falsePositive, options), false);
  assert.deepEqual(matchedProjectTerms(falsePositive, options), []);
  assert.equal(projectMatchesSearch(exact, options), true);
  assert.deepEqual(matchedProjectTerms(exact, options), ["led", "wall"]);
  assert.equal(projectMatchesSearch(exact, { ...options, keywords: ["partition wall"], match: "phrase" }), true);
});

test("live location search normalizes punctuation, whitespace, and trailing state names", () => {
  const losAngeles = {
    ...project([]),
    address: "100 Main St.",
    city: "Los Angeles",
    county: "Los Angeles",
    state: "CA",
  };
  const newYork = {
    ...project([]),
    city: "New York",
    state: "NY",
  };
  const options = {
    keywords: [],
    match: "all",
    freshness: "all",
    includeArchived: false,
  };

  assert.equal(normalizeLocationQuery(" Los Angeles,   California "), "los angeles ca");
  assert.equal(normalizeLocationQuery("New York, New York"), "new york ny");
  assert.equal(projectMatchesSearch(losAngeles, { ...options, location: "Los Angeles, California" }), true);
  assert.equal(projectMatchesSearch(losAngeles, { ...options, location: "Los Angeles, Nevada" }), false);
  assert.equal(projectMatchesSearch(newYork, { ...options, location: "New York, New York" }), true);
  assert.equal(projectMatchesSearch(newYork, { ...options, state: "New York" }), true);
});
