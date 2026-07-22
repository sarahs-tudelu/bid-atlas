import assert from "node:assert/strict";
import test from "node:test";

const {
  PENNSYLVANIA_DOT_ECMS_URL,
  PENNSYLVANIA_DOT_SOURCE_ID,
  PENNSYLVANIA_DOT_SOURCE_TEMPLATE,
  fetchPennsylvaniaDotDocument,
  fetchPennsylvaniaDotProjectEnrichment,
  fetchPennsylvaniaDotSource,
} = await import("../app/lib/pennsylvania-dot-connector.ts");

const NOW = () => new Date("2026-07-20T16:00:00.000Z");
const BASE = PENNSYLVANIA_DOT_ECMS_URL;

const listHtml = `
  <html><body>
    <h1>Bid Package Search Results</h1>
    <div>Records 1 to 2 of 2</div>
    <select><option value="100" selected>100</option></select>
    <table>
      <tr class="PDEvenRow">
        <td><a href="SVBSLBidPackage?action=Show&amp;ECMS_PROJECT_NUM=3,410&amp;BID_PACKAGE_NUM=1">07/30/2026 11:00 AM</a></td>
        <td><a href="SVPRJ?action=SHOWPROJINFO&amp;ECMS_PROJECT_NUM=3,410">3410<input type="hidden" name="ECMS_PROJECT_NUM" value="3410"></a></td>
        <td>Standard</td><td>02</td><td>Clearfield</td><td>1004</td><td>A02</td><td>---</td>
        <td>500-1000</td><td>BOX CULVERTS</td><td>ECMS</td><td>42%</td>
        <td><a href="SVBSLSearch?action=ShowPlanholdersList&amp;ECMS_PROJECT_NUM=3,410">LOP</a></td><td></td>
      </tr>
      <tr class="PDOddRow">
        <td><a href="SVBSLBidPackage?action=Show&amp;ECMS_PROJECT_NUM=9,999&amp;BID_PACKAGE_NUM=1">08/06/2026 11:00 AM</a></td>
        <td>9999<input type="hidden" name="ECMS_PROJECT_NUM" value="9999"></td>
        <td>Standard</td><td>01</td><td>Adams</td><td>30</td><td>W01</td><td>---</td>
        <td>100-200</td><td>RESURFACING</td><td>ECMS</td><td>0%</td><td>LOP</td><td></td>
      </tr>
    </table>
  </body></html>`;

const activeDetailHtml = `
  <html><body>
    <table><tr>
      <td class="header1title right middle"><a>Advertised</a></td>
    </tr></table>
    <table>
      <tr><td>Short Description:</td><td>Montgomery Run Bridge</td></tr>
      <tr><td>Municipality:</td><td>LAWRENCE</td></tr>
      <tr><td>Anticipated NTP:</td><td>09/14/2026</td></tr>
      <tr><td>Required Completion:</td><td>08/19/2027</td></tr>
    </table>
    <table><tr><td class="Section1Title">Description </td></tr></table>
    <table><tr><td class="data">Furnishing and placing a precast reinforced concrete box culvert, approach paving, and guide rail upgrades.</td></tr></table>
    <a title="View Plans" href="SVPDC?action=SHOW&amp;ECMS_PROJECT_NUM=3410&amp;VERSION_ID=C&amp;SOURCE=PLANS">Plans</a>
    <a title="View Special Provisions" href="SVPDCSP?action=show&amp;ECMS_PROJECT_NUM=3410&amp;VERSION_ID=C">Special Provisions</a>
    <a title="View Project Items and Quantities" href="SVPIQ?action=SHOWLIST&amp;ECMS_PROJECT_NUM=3410&amp;VIEW_SOURCE_CODE=C">Items</a>
    <a title="View Attachments" href="SVPDC?action=SHOW&amp;ECMS_PROJECT_NUM=3410&amp;VERSION_ID=C&amp;SOURCE=ATTACHMENTS">Attachments</a>
    <a title="View Publish Proposal Report" href="SVBSLBidPackage?action=showCurrentProposalReport&amp;ECMS_PROJECT_NUM=3410&amp;BID_PACKAGE_NUM=1">Proposal</a>
    <a title="View Plan Sets" href="SVBSLBidPackage?action=showProposalPlanSets&amp;ECMS_PROJECT_NUM=3410&amp;BID_PACKAGE_NUM=1">Plan sets</a>
    <a href="SVBSLAddendum?action=show&amp;ECMS_PROJECT_NUM=3410&amp;BID_PACKAGE_NUM=1&amp;ADDENDUM_NUM=1">Addendum 1</a>
    <a title="View Plan Sets" href="SVBSLAddendum?action=showProposalPlanSets&amp;ECMS_PROJECT_NUM=3410&amp;BID_PACKAGE_NUM=1&amp;ADDENDUM_NUM=1">Addendum plans</a>
    <a title="View Publish Proposal Report" href="SVBSLAddendum?action=showAddendumProposalReport&amp;ECMS_PROJECT_NUM=3410&amp;BID_PACKAGE_NUM=1&amp;ADDENDUM_NUM=1">Addendum report</a>
    <table><tr class="PDEvenRow"><td>Draft</td><td>PennDOT</td><td>Publish</td><td>06/30/2026 10:52:32 AM</td></tr></table>
  </body></html>`;

const withdrawnDetailHtml = `
  <html><body>
    <td class="header1title right middle">Withdrawn</td>
    <table><tr><td>Short Description:</td><td>Withdrawn package</td></tr></table>
    <input type="hidden" name="ECMS_PROJECT_NUM" value="9999">
  </body></html>`;

const originalPlanListHtml = `
  <html><body><table>
    <tr class="PDEvenRow"><td>
      <a href="SVCOMDownloadDocument?action=EDMS&amp;&amp;docTypeCode=17&amp;docId=1,593,178&amp;timestamp=06/30/2026%2011:04:59%20AM">3410_1_Roadway Plan.pdf</a>
    </td></tr>
  </table></body></html>`;

const addendumPlanListHtml = `
  <html><body><table>
    <tr class="PDEvenRow"><td>
      <a href="SVCOMDownloadDocument?action=EDMS&amp;&amp;docTypeCode=17&amp;docId=1,600,001&amp;timestamp=07/10/2026%2009:00:00%20AM">3410_Addendum_1_Structure_Plan.pdf</a>
    </td></tr>
  </table></body></html>`;

const currentChecklistHtml = `
  <html><body>
    <a href="SVPDCDetail?action=ShowAttachments&amp;ECMS_PROJECT_NUM=3410&amp;CL_LINE_NUM=16&amp;VERSION_ID=C&amp;SOURCE=PLANS">Roadway drawings</a>
  </body></html>`;

const currentAttachmentHtml = `
  <html><body><table>
    <tr class="PDEvenRow"><td>
      <a href="SVCOMDownloadDocument?action=EDMS&amp;&amp;docTypeCode=22&amp;docId=2,293,346&amp;timestamp=06/22/2026%2001:26:52%20PM">ARD0001OF19.pdf</a>
    </td></tr>
  </table></body></html>`;

const planholderCsv = `Contractor,Address,Contractor Type,Contact,Phone,Fax,Email\r\n"Glenn O. Hawbaker, Inc.","1952 Waddle Road, Suite 203",Prime Contractor,"Michael Galloway","814-237-1444","814-237-5348","EstimatingSC@goh-inc.com"\r\n`;

function ecmsFixtureFetch({
  issueCookie = true,
  documentBytes = false,
  documentBody,
  secondActive = false,
  stallDocument = false,
} = {}) {
  const requests = [];
  const issuedCookies = new Set();
  let sessionCounter = 0;
  let planholderListOpened = false;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const headers = new Headers(init.headers);
    requests.push({ url: url.toString(), cookie: headers.get("cookie") });
    const action = url.searchParams.get("action") ?? "";

    if (url.pathname === "/ECMS/") {
      const sessionCookie = `JSESSIONID=fixture-session:${++sessionCounter}`;
      issuedCookies.add(sessionCookie);
      return new Response("<html>ECMS login</html>", {
        status: 200,
        headers: issueCookie
          ? { "set-cookie": `${sessionCookie}; Path=/; HttpOnly` }
          : {},
      });
    }
    assert.equal(issuedCookies.has(headers.get("cookie")), true);
    if (url.pathname.endsWith("/SVCOMLogin") && action === "login") {
      return new Response(
        "<script>window.location='SVCOMLogin?action=showloginbulletins'</script>",
      );
    }
    if (url.pathname.endsWith("/SVCOMLogin") && action === "showloginbulletins") {
      return new Response("You are currently logged in as <b>Anonymous</b>.");
    }
    if (url.pathname.endsWith("/SVCOMMain") && action === "showMenuItem") {
      return new Response("<html>Bid Packages Portal</html>");
    }
    if (url.pathname.endsWith("/SVBSLSearch") && action === "SearchByLetDate") {
      return new Response(listHtml);
    }
    if (url.pathname.endsWith("/SVBSLBidPackage") && action === "Show") {
      const projectNumber = url.searchParams
        .get("ECMS_PROJECT_NUM")
        ?.replace(/\D/g, "");
      return new Response(
        projectNumber === "3410"
          ? activeDetailHtml
          : secondActive && projectNumber === "9999"
            ? activeDetailHtml.replaceAll("3410", "9999")
          : withdrawnDetailHtml,
      );
    }
    if (
      url.pathname.endsWith("/SVBSLBidPackage") &&
      action === "showProposalPlanSets"
    ) {
      return new Response(originalPlanListHtml);
    }
    if (
      url.pathname.endsWith("/SVBSLAddendum") &&
      action === "showProposalPlanSets"
    ) {
      return new Response(addendumPlanListHtml);
    }
    if (
      url.pathname.endsWith("/SVPDC") &&
      url.searchParams.get("SOURCE") === "PLANS"
    ) {
      return new Response(currentChecklistHtml);
    }
    if (
      url.pathname.endsWith("/SVPDCDetail") &&
      action === "ShowAttachments"
    ) {
      return new Response(currentAttachmentHtml);
    }
    if (
      url.pathname.endsWith("/SVBSLSearch") &&
      action === "ShowPlanholdersList"
    ) {
      planholderListOpened = true;
      return new Response("<html>Records 1 to 1 of 1</html>");
    }
    if (
      url.pathname.endsWith("/SVBSLSearch") &&
      action === "ExportPlanHolders"
    ) {
      return new Response(planholderListOpened ? planholderCsv : "", {
        headers: { "content-type": "text/csv" },
      });
    }
    if (
      url.pathname.endsWith("/SVCOMDownloadDocument") &&
      action === "EDMS" &&
      documentBytes
    ) {
      const body = stallDocument
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
              init.signal?.addEventListener("abort", () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              });
            },
          })
        : documentBody ??
          new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
      return new Response(
        body,
        {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="3410_1_Roadway Plan.pdf"',
          },
        },
      );
    }
    return new Response("not found", { status: 404 });
  };
  fetchImpl.requests = requests;
  fetchImpl.issuedCookies = issuedCookies;
  return fetchImpl;
}

test("PennDOT ECMS guest feed publishes only active packages with exact ET deadlines and document metadata", async () => {
  const fetchImpl = ecmsFixtureFetch();
  const result = await fetchPennsylvaniaDotSource(PENNSYLVANIA_DOT_SOURCE_ID, {
    fetchImpl,
    now: NOW,
  });

  assert.equal(PENNSYLVANIA_DOT_SOURCE_TEMPLATE.url, BASE);
  assert.equal(result.source.status, "live");
  assert.equal(result.source.recordCount, 2, "source total remains the raw ECMS row count");
  assert.equal(result.source.recordCountUnit, "rows");
  assert.equal(result.source.loadedCount, 1);
  assert.equal(result.projects.length, 1, "withdrawn packages are excluded after detail verification");
  const project = result.projects[0];
  assert.equal(project.sourceRecordId, "3410");
  assert.equal(project.title, "Montgomery Run Bridge");
  assert.match(project.summary, /precast reinforced concrete box culvert/i);
  assert.equal(
    project.bidDate,
    "2026-07-30T15:00:00.000Z",
    "11:00 AM Eastern is 15:00 UTC during daylight saving time",
  );
  assert.equal(project.bidDateTimeZone, "America/New_York");
  assert.equal(project.postedAt, "2026-06-30T14:52:32.000Z");
  assert.ok(project.documents.some((document) => document.kind === "plans"));
  assert.ok(project.documents.some((document) => document.kind === "addendum"));
  assert.ok(project.documents.some((document) => document.kind === "specifications"));
  for (const document of project.documents) {
    const url = new URL(document.url);
    assert.equal(url.hostname, "www.ecms.penndot.pa.gov");
    assert.ok(!/JSESSIONID|dockey=/i.test(document.url));
  }
  for (const request of fetchImpl.requests) {
    if (request.url === BASE) assert.equal(request.cookie, null);
    else assert.equal(fetchImpl.issuedCookies.has(request.cookie), true);
  }
});

test("feed detail workers isolate ECMS sessions and reject cross-project documents", async () => {
  const fetchImpl = ecmsFixtureFetch({ secondActive: true });
  const result = await fetchPennsylvaniaDotSource(PENNSYLVANIA_DOT_SOURCE_ID, {
    fetchImpl,
    now: NOW,
  });
  assert.equal(result.projects.length, 2);
  const detailRequests = fetchImpl.requests.filter((request) => {
    const url = new URL(request.url);
    return (
      url.pathname.endsWith("/SVBSLBidPackage") &&
      url.searchParams.get("action") === "Show"
    );
  });
  assert.equal(new Set(detailRequests.map((request) => request.cookie)).size, 2);
  for (const project of result.projects) {
    for (const document of project.documents) {
      const url = new URL(document.url);
      const identity = [...url.searchParams].find(
        ([key]) => key.toLowerCase() === "ecms_project_num",
      )?.[1];
      if (identity) {
        assert.equal(identity.replace(/\D/g, ""), project.sourceRecordId);
      }
    }
  }
});

test("exact-project enrichment expands actual plan actions and public planholder contacts on demand", async () => {
  const fetchImpl = ecmsFixtureFetch();
  const enrichment = await fetchPennsylvaniaDotProjectEnrichment("3,410", {
    fetchImpl,
    now: NOW,
  });

  assert.equal(enrichment.projectNumber, "3410");
  assert.equal(enrichment.planholders.length, 1);
  assert.deepEqual(enrichment.planholders[0], {
    contractor: "Glenn O. Hawbaker, Inc.",
    address: "1952 Waddle Road, Suite 203",
    contractorType: "Prime Contractor",
    contact: "Michael Galloway",
    phone: "814-237-1444",
    fax: "814-237-5348",
    email: "estimatingsc@goh-inc.com",
  });
  assert.ok(
    enrichment.participants.some(
      (participant) =>
        participant.role === "contractor" &&
        participant.name === "Michael Galloway" &&
        participant.organization === "Glenn O. Hawbaker, Inc.",
    ),
  );
  const directPlans = enrichment.documents.filter((document) =>
    /SVCOMDownloadDocument/i.test(document.url),
  );
  assert.equal(directPlans.length, 2);
  assert.ok(directPlans.some((document) => /Roadway Plan\.pdf/i.test(document.name)));
  assert.ok(directPlans.some((document) => /Addendum 1/i.test(document.name)));
  assert.equal(
    directPlans.some((document) => /ARD0001OF19\.pdf/i.test(document.name)),
    false,
    "current sheet expansion stays a fallback when consolidated plan sets exist",
  );
  for (const document of enrichment.documents) {
    assert.ok(!/JSESSIONID|dockey=/i.test(document.url));
  }
  const showIndex = fetchImpl.requests.findIndex((request) =>
    request.url.includes("action=ShowPlanholdersList"),
  );
  const exportIndex = fetchImpl.requests.findIndex((request) =>
    request.url.includes("action=ExportPlanHolders"),
  );
  assert.ok(showIndex >= 0 && exportIndex > showIndex, "planholder export requires list initialization first");
});

test("session-aware document fetch returns bytes from a stable ECMS action URL", async () => {
  const fetchImpl = ecmsFixtureFetch({ documentBytes: true });
  const stableUrl = new URL("SVCOMDownloadDocument", BASE);
  stableUrl.searchParams.set("action", "EDMS");
  stableUrl.searchParams.set("docTypeCode", "17");
  stableUrl.searchParams.set("docId", "1,593,178");
  stableUrl.searchParams.set("timestamp", "06/30/2026 11:04:59 AM");
  const document = await fetchPennsylvaniaDotDocument(stableUrl.toString(), {
    fetchImpl,
  });
  assert.equal(document.sourceUrl, stableUrl.toString());
  assert.equal(document.fileName, "3410_1_Roadway Plan.pdf");
  assert.equal(new TextDecoder().decode(document.bytes.slice(0, 4)), "%PDF");
});

test("session-aware document fetch stops a chunked body at the byte ceiling", async () => {
  const documentBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2]));
      controller.enqueue(new Uint8Array([3, 4, 5, 6, 7, 8]));
      controller.close();
    },
  });
  const fetchImpl = ecmsFixtureFetch({ documentBytes: true, documentBody });
  const stableUrl = new URL("SVCOMDownloadDocument", BASE);
  stableUrl.searchParams.set("action", "EDMS");
  stableUrl.searchParams.set("docId", "1,593,178");
  await assert.rejects(
    () =>
      fetchPennsylvaniaDotDocument(stableUrl.toString(), {
        fetchImpl,
        maxDocumentBytes: 8,
      }),
    /exceeds the download safety limit/,
  );
});

test("session-aware document timeout remains active while the body streams", async () => {
  const fetchImpl = ecmsFixtureFetch({
    documentBytes: true,
    stallDocument: true,
  });
  const stableUrl = new URL("SVCOMDownloadDocument", BASE);
  stableUrl.searchParams.set("action", "EDMS");
  stableUrl.searchParams.set("docId", "1,593,178");
  await assert.rejects(
    () =>
      fetchPennsylvaniaDotDocument(stableUrl.toString(), {
        fetchImpl,
        requestTimeoutMs: 25,
      }),
    (error) => error instanceof Error && error.name === "AbortError",
  );
});

test("missing anonymous session cookie fails closed instead of reporting a healthy zero", async () => {
  const fetchImpl = ecmsFixtureFetch({ issueCookie: false });
  await assert.rejects(
    () =>
      fetchPennsylvaniaDotSource(PENNSYLVANIA_DOT_SOURCE_ID, {
        fetchImpl,
        now: NOW,
      }),
    /did not issue an anonymous JSESSIONID/,
  );
});
