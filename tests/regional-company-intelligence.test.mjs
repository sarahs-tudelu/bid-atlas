import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-extension-loader.mjs", import.meta.url);

const { searchRegionalCompanies } = await import(
  "../app/lib/regional-company-intelligence.ts"
);

function fixtureDb(rows) {
  return {
    prepare(sql) {
      assert.match(sql, /p\.state IN \('NY','NJ'\)/);
      assert.match(sql, /pp\.role IN \('owner','contractor'\)/);
      return {
        bindings: [],
        bind(...values) {
          this.bindings = values;
          return this;
        },
        async all() {
          assert.equal(this.bindings.at(-1), "%hudson%");
          return { results: rows };
        },
      };
    },
  };
}

test("regional company search returns only business-valued project roles with official evidence", async () => {
  const rows = [
    {
      organization_id: "owner-business",
      display_name: "Hudson Property Holdings LLC",
      organization_state: "NY",
      role: "owner",
      project_id: "project-1",
      project_title: "Hudson mixed-use renovation",
      project_city: "New York",
      project_state: "NY",
      source_name: "NYC DOB NOW approved construction permits",
      source_url: "https://data.cityofnewyork.us/resource/rbx6-tga4.json",
      last_seen_at: "2026-07-21T00:00:00.000Z",
    },
    {
      organization_id: "private-person",
      display_name: "Hudson Smith",
      organization_state: "NJ",
      role: "owner",
      project_id: "project-2",
      project_title: "Private residence",
      project_city: "Hoboken",
      project_state: "NJ",
      source_name: "Fixture",
      source_url: "https://example.gov/permit/2",
      last_seen_at: "2026-07-20T00:00:00.000Z",
    },
  ];
  const originalFetch = globalThis.fetch;
  const hosts = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    hosts.push(url.hostname);
    if (url.hostname === "data.ny.gov") {
      return Response.json([
        {
          certificate_number: "CRT-100",
          business_name: "Hudson Construction Corp",
          dba_name: "Hudson Builders",
          business_type: "Corporation",
          city: "Albany",
          state: "NY",
          status: "Active",
        },
        {
          certificate_number: "CRT-101",
          business_name: "Hudson Smith",
          status: "Active",
        },
      ]);
    }
    assert.equal(url.hostname, "data.cityofnewyork.us");
    return Response.json([
      {
        license_nbr: "LIC-200",
        business_name: "Hudson Building Services LLC",
        license_type: "Home Improvement Contractor",
        license_status: "Active",
      },
    ]);
  };

  try {
    const result = await searchRegionalCompanies(
      "Hudson",
      "all",
      "all",
      fixtureDb(rows),
    );
    assert.deepEqual(result.indexed.map(({ name }) => name), ["Hudson Property Holdings LLC"]);
    assert.equal(result.indexed[0].projects[0].sourceUrl, rows[0].source_url);
    assert.deepEqual(
      result.registryMatches.map(({ businessName }) => businessName).sort(),
      ["Hudson Building Services LLC", "Hudson Construction Corp"],
    );
    assert.deepEqual([...new Set(hosts)].sort(), ["data.cityofnewyork.us", "data.ny.gov"]);
    assert.equal(result.registryWarnings.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("short company searches stay inside the indexed project evidence and skip registries", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return Response.json([]);
  };
  try {
    const shortDb = {
      prepare() {
        return {
          bind() { return this; },
          async all() { return { results: [] }; },
        };
      },
    };
    const result = await searchRegionalCompanies("H", "owner", "NY", shortDb);
    assert.equal(fetched, false);
    assert.deepEqual(result.registryMatches, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
