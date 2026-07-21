import { DocumentInputError, parseDocumentMetadata } from "../../../../../lib/project-documents/contracts";
import {
  documentErrorResponse,
  privateJson,
  requireDocumentActor,
} from "../../../../../lib/project-documents/http";
import { importProjectDocumentFromUrl } from "../../../../../lib/project-documents/ingestion";
import { normalizeProjectId } from "../../../../../lib/project-research/contracts";
import {
  fetchPennsylvaniaDotDocument,
  PENNSYLVANIA_DOT_SOURCE_ID,
} from "../../../../../lib/pennsylvania-dot-connector.ts";
import {
  getProjectResearchDatabase,
  getProjectResearchRecord,
} from "../../../../../lib/project-research/repository";

export const dynamic = "force-dynamic";

interface DrawingRetrievalRouteProps {
  params: Promise<{ projectId: string; findingId: string }>;
}

export async function POST(
  request: Request,
  { params }: DrawingRetrievalRouteProps,
) {
  try {
    const actor = await requireDocumentActor(request);
    const rawParams = await params;
    const projectId = normalizeProjectId(rawParams.projectId);
    const findingId = rawParams.findingId.trim().slice(0, 240);
    if (!findingId) {
      throw new DocumentInputError(404, "drawing_not_found", "Drawing not found.");
    }

    const database = await getProjectResearchDatabase();
    const research = await getProjectResearchRecord(database, projectId, {
      authenticated: true,
      cached: true,
    });
    const finding = research?.documents.find(
      (document) => document.id === findingId,
    );
    if (!finding || finding.access !== "public-link") {
      throw new DocumentInputError(404, "drawing_not_found", "Drawing not found.");
    }
    if (
      finding.documentType !== "plans" &&
      finding.documentType !== "specifications" &&
      finding.documentType !== "drawings" &&
      finding.documentType !== "cad"
    ) {
      throw new DocumentInputError(
        409,
        "not_a_drawing",
        "The verified project finding is not a plan or drawing file.",
      );
    }

    const sourceId = finding.sourceId ?? research?.sources.find((attempt) =>
      Boolean(
        attempt.sourceId &&
        [attempt.sourceUrl, attempt.finalUrl]
          .filter((url): url is string => Boolean(url))
          .some((url) => url === finding.sourceUrl || url === finding.url),
      ),
    )?.sourceId;
    if (!sourceId) {
      throw new DocumentInputError(
        409,
        "drawing_source_unverified",
        "The drawing link is not attached to a verified project source yet.",
      );
    }

    const metadata = parseDocumentMetadata(
      {
        projectId,
        sourceId,
        name: finding.name,
        documentType: finding.documentType,
        description: finding.evidence,
        sourceUrl: finding.url,
        accessMode: "public",
        visibility: "workspace",
        redistributionAllowed: false,
        fetchBytes: true,
        provenance: {
          publisher: finding.sourceLabel ?? "Official project source",
          sourceName: finding.sourceLabel ?? "Official project source",
          sourceRecordId: finding.id,
          acquisitionNotes: "Pulled on demand from a server-verified project finding.",
        },
      },
      "url-import",
    );
    const pennsylvaniaSessionFetch = sourceId === PENNSYLVANIA_DOT_SOURCE_ID
      ? async (input: RequestInfo | URL) => {
          const requestedUrl = typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
          if (requestedUrl !== finding.url) {
            throw new DocumentInputError(
              502,
              "drawing_source_mismatch",
              "The PennDOT document request no longer matches the verified finding.",
            );
          }
          const fetched = await fetchPennsylvaniaDotDocument(finding.url, {
            requestTimeoutMs: 20_000,
          });
          const bytes = new Uint8Array(fetched.bytes);
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-type": fetched.contentType,
              "content-length": String(bytes.byteLength),
              "content-disposition": `attachment; filename="${fetched.fileName.replace(/["\r\n]/g, "_")}"`,
            },
          });
        }
      : undefined;
    const document = await importProjectDocumentFromUrl(
      metadata,
      actor.id,
      pennsylvaniaSessionFetch,
    );
    return privateJson(
      {
        document,
        links: {
          metadata: `/api/documents/${encodeURIComponent(document.documentId)}`,
          view: `/api/documents/${encodeURIComponent(document.documentId)}/download?disposition=inline`,
          download: `/api/documents/${encodeURIComponent(document.documentId)}/download`,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return documentErrorResponse(error);
  }
}
