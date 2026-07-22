import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { canPreviewDocumentInline } = await import(
  "../app/lib/project-documents/contracts.ts"
);

test("inline drawing previews accept only browser-safe PDF and raster MIME types", () => {
  for (const mimeType of [
    "application/pdf",
    "application/pdf; charset=binary",
    "image/png",
    "image/jpeg",
  ]) {
    assert.equal(canPreviewDocumentInline(mimeType), true, mimeType);
  }
  for (const mimeType of [
    "application/octet-stream",
    "application/zip",
    "application/vnd.autodesk.revit",
    "text/html",
    "image/svg+xml",
  ]) {
    assert.equal(canPreviewDocumentInline(mimeType), false, mimeType);
  }
});

test("project drawing retrieval is click-only, project-bound, and URL-free at the browser boundary", async () => {
  const [panel, retrievalRoute, downloadRoute, dashboard, bidDeskPage] =
    await Promise.all([
      readFile(new URL("../app/ProjectDrawingsPanel.tsx", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../app/api/projects/[projectId]/drawings/[findingId]/route.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../app/api/documents/[documentId]/download/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../app/DashboardClient.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/bid-desk/page.tsx", import.meta.url), "utf8"),
    ]);

  assert.match(panel, /View plans\/drawings/);
  assert.match(panel, /Download drawings/);
  assert.match(panel, /onClick=\{\(\) => openWorkspace\("view"\)\}/);
  assert.match(panel, /method: "POST"/);
  assert.match(panel, /drawings\/\$\{encodeURIComponent\(retrievalId\)\}/);
  assert.doesNotMatch(panel, /\/api\/documents\/import/);
  assert.doesNotMatch(panel, /sourceUrl\s*:/);
  assert.match(panel, /new Map\(candidates\.map\(\(document\) => \[document\.url, document\]\)\)/);
  assert.match(panel, /document\.kind !== "plans" && document\.kind !== "specifications"/);

  assert.match(retrievalRoute, /research\?\.documents\.find/);
  assert.match(retrievalRoute, /document\.id === findingId/);
  assert.match(retrievalRoute, /sourceUrl: finding\.url/);
  assert.match(retrievalRoute, /fetchBytes: true/);
  assert.match(retrievalRoute, /visibility: "workspace"/);
  assert.match(retrievalRoute, /redistributionAllowed: false/);
  assert.match(retrievalRoute, /PENNSYLVANIA_DOT_SOURCE_ID/);
  assert.match(retrievalRoute, /fetchPennsylvaniaDotDocument\(finding\.url/);
  assert.doesNotMatch(retrievalRoute, /request\.json\(/);

  assert.match(downloadRoute, /inlineRequested && !canPreviewDocumentInline\(record\.mimeType\)/);
  assert.match(downloadRoute, /inlineRequested \? "inline" : "attachment"/);
  assert.match(downloadRoute, /Content-Security-Policy/);
  assert.match(downloadRoute, /X-Content-Type-Options/);
  assert.match(downloadRoute, /X-Frame-Options/);

  assert.match(dashboard, /drawings=view#project-drawings/);
  assert.match(dashboard, /drawings=download#project-drawings/);
  assert.match(bidDeskPage, /initialDrawingAction=\{linkedProjectUnresolved \? undefined : initialDrawingAction\}/);
});
