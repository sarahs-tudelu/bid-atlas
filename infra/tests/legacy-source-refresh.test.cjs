const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const esbuild = require("esbuild");

const built = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, "../handlers/legacy-source-refresh.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  sourcemap: false,
});
const loaded = new Module("legacy-source-refresh-test", module);
loaded.filename = path.resolve(__dirname, "legacy-source-refresh-test.cjs");
loaded.paths = module.paths;
loaded._compile(built.outputFiles[0].text, loaded.filename);
const { mergeFeed } = loaded.exports;

const sourceId = "nyc-dob-now-job-filings";

function snapshot() {
  return {
    projects: [
      { id: `${sourceId}:1`, sourceId, version: "old" },
      { id: `${sourceId}:2`, sourceId, version: "old" },
    ],
    sources: [
      {
        id: sourceId,
        name: "Partial source",
        status: "live",
        snapshotComplete: false,
      },
    ],
    coverage: { states: [] },
    inventory: {},
    warnings: [],
  };
}

test("partial source pages update seen rows and retain unseen rows", () => {
  const merged = mergeFeed(snapshot(), {
    projects: [{ id: `${sourceId}:1`, sourceId, version: "fresh" }],
    sources: [
      {
        id: sourceId,
        name: "Partial source",
        status: "live",
        snapshotComplete: false,
        note: "Bounded page.",
      },
    ],
    warnings: [],
  });

  assert.deepEqual(
    merged.projects.map((project) => project.id).sort(),
    [`${sourceId}:1`, `${sourceId}:2`],
  );
  assert.equal(
    merged.projects.find((project) => project.id === `${sourceId}:1`).version,
    "fresh",
  );
  assert.equal(merged.sources[0].loadedCount, 2);
});

test("complete source pages replace the prior source partition", () => {
  const merged = mergeFeed(snapshot(), {
    projects: [{ id: `${sourceId}:1`, sourceId, version: "fresh" }],
    sources: [
      {
        id: sourceId,
        name: "Complete source",
        status: "live",
        snapshotComplete: true,
      },
    ],
    warnings: [],
  });

  assert.deepEqual(
    merged.projects.map((project) => project.id),
    [`${sourceId}:1`],
  );
});
