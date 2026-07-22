import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workerSource = readFileSync(
  new URL("../worker/index.ts", import.meta.url),
  "utf8",
);

function blockAfter(needle) {
  const signatureStart = workerSource.indexOf(needle);
  assert.notEqual(signatureStart, -1, `Missing ${needle}`);

  const blockStart = workerSource.indexOf("{", signatureStart);
  assert.notEqual(blockStart, -1, `Missing body for ${needle}`);

  let depth = 0;
  for (let index = blockStart; index < workerSource.length; index += 1) {
    if (workerSource[index] === "{") depth += 1;
    if (workerSource[index] === "}") depth -= 1;
    if (depth === 0) return workerSource.slice(blockStart + 1, index);
  }

  assert.fail(`Unclosed body for ${needle}`);
}

test("scheduled refresh gives ingestion and discovery independent lifetime promises", () => {
  const body = blockAfter("function runScheduledWork");

  assert.equal((body.match(/ctx\.waitUntil\s*\(/g) ?? []).length, 3);
  assert.match(
    body,
    /ctx\.waitUntil\(\s*runIngestion\(\s*env,\s*['"]incremental['"]\s*\)\s*\);/,
  );
  assert.match(
    body,
    /ctx\.waitUntil\(\s*runJurisdictionDiscovery\(\s*env,\s*\{\s*trigger:\s*['"]scheduled['"]\s*,?\s*\}\s*\)\s*,?\s*\);/,
  );
  assert.match(
    body,
    /ctx\.waitUntil\(\s*runDueSourceMonitors\(\s*env\.DB\s*\)\s*\);/,
  );
  assert.doesNotMatch(body, /\bawait\b/);
});

test("scheduled hook delegates without wrapping both jobs in one promise", () => {
  const body = blockAfter("scheduled(");

  assert.match(body, /runScheduledWork\(\s*env,\s*ctx\s*\);/);
  assert.doesNotMatch(body, /ctx\.waitUntil\(\s*runScheduledWork\(/);
});
