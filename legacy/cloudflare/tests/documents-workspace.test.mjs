import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path, init) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("documents-test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, init),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("documents render as a separate searchable and paginated workspace", async () => {
  const response = await render("/documents?project=example%3A1&source=example-source");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /PLANS \+ SPECIFICATIONS LIBRARY/i);
  assert.match(html, /Search products, clauses, sheets, and project files/i);
  assert.match(html, /Results per page/i);
  assert.match(html, /Import official HTTPS source/i);
  assert.match(html, /Upload authorized workspace copy/i);
  assert.match(html, /example:1/);
  assert.match(html, /example-source/);
  assert.match(html, /href="\/documents"[^>]*aria-current="page"/i);
  assert.doesNotMatch(html, /session-only: it does not save/i);
});

test("documents route restores shareable search, scope, and page-size parameters", async () => {
  const response = await render(
    "/documents?q=canopy%2C%20lighting&project=example%3A1&source=example-source&type=plans&status=metadata-only&public=0&page=3&limit=25",
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /value="canopy, lighting"/);
  assert.match(html, /value="example:1"/);
  assert.match(html, /value="plans" selected=""/);
  assert.match(html, /value="metadata-only" selected=""/);
  assert.match(html, /<option value="25" selected="">25<\/option>/);
  assert.doesNotMatch(html, /type="checkbox" checked=""[^>]*\/?>\s*<span><strong>Public-only/i);
});

test("document search clamps an out-of-range page", async () => {
  const route = await readFile(
    new URL("../app/api/documents/search/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /const totalPages = Math\.max\(1, Math\.ceil\(result\.total \/ pageSize\)\)/);
  assert.match(route, /const responsePage = Math\.min\(page, totalPages\)/);
  assert.match(route, /responsePage !== page[\s\S]*searchDocumentMetadata\(\{ \.\.\.searchOptions, page: responsePage \}\)/);
  assert.match(route, /page: responsePage,[\s\S]*totalPages/);
});

test("private bid-draft persistence refuses anonymous writes", async () => {
  const response = await render("/api/bid-drafts", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "unauthorized");
});

test("document intake refuses anonymous imports before reading a source URL", async () => {
  const response = await render("/api/documents/import", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sourceUrl: "https://example.gov/plans.pdf" }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "unauthorized");
});

test("document extraction rejects an ordinary workspace session", async () => {
  const response = await render("/api/documents/doc-1/extractions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "oai-authenticated-user-email": "workspace@example.com",
    },
    body: "{}",
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, "internal_document_service_required");
});

test("multipart upload requires a bounded Content-Length before parsing", async () => {
  const response = await render("/api/documents/upload", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=bidatlas-test",
      "oai-authenticated-user-email": "workspace@example.com",
    },
    body: "--bidatlas-test--\r\n",
  });
  assert.equal(response.status, 411);
  const body = await response.json();
  assert.equal(body.error.code, "content_length_required");
});
