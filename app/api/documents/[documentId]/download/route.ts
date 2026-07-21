import {
  DocumentInputError,
  canReadDocumentAsActor,
  canServeDocumentPublicly,
  canPreviewDocumentInline,
  normalizeFileName,
} from "../../../../lib/project-documents/contracts";
import {
  documentErrorResponse,
  getDocumentActor,
} from "../../../../lib/project-documents/http";
import {
  getDocumentBucket,
  getDocumentDownloadRecord,
} from "../../../../lib/project-documents/storage";

export const dynamic = "force-dynamic";

interface DownloadRouteProps {
  params: Promise<{ documentId: string }>;
}

function contentDispositionHeader(fileName: string, disposition: "attachment" | "inline"): string {
  const safe = normalizeFileName(fileName).replaceAll('"', "-");
  const encoded = encodeURIComponent(safe).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

export async function GET(request: Request, { params }: DownloadRouteProps) {
  try {
    const { documentId: rawDocumentId } = await params;
    const documentId = rawDocumentId.trim().slice(0, 200);
    const record = documentId ? await getDocumentDownloadRecord(documentId) : null;
    if (!record) throw new DocumentInputError(404, "document_not_found", "Document not found.");
    const actor = await getDocumentActor(request);
    const searchParams = new URL(request.url).searchParams;
    const explicitPublic = searchParams.get("public") === "1";
    const inlineRequested = searchParams.get("disposition") === "inline";
    const publiclyEligible = explicitPublic && canServeDocumentPublicly(record);
    if (!canReadDocumentAsActor(record, actor) && !publiclyEligible) {
      throw new DocumentInputError(404, "document_not_found", "Document not found.");
    }
    if (!record.objectKey || !record.contentHash) {
      throw new DocumentInputError(
        409,
        "document_bytes_unavailable",
        "This record contains searchable metadata, but downloadable bytes are not stored yet.",
      );
    }
    if (inlineRequested && !canPreviewDocumentInline(record.mimeType)) {
      throw new DocumentInputError(
        415,
        "inline_preview_unsupported",
        "This file type is available for download but cannot be rendered safely in the in-app viewer.",
      );
    }
    const object = await (await getDocumentBucket()).get(record.objectKey);
    if (!object) {
      throw new DocumentInputError(409, "document_bytes_missing", "The stored document bytes are unavailable.");
    }
    const storedHash = object.customMetadata?.sha256;
    if (storedHash && storedHash !== record.contentHash) {
      throw new DocumentInputError(409, "document_integrity_mismatch", "The stored document failed its integrity check.");
    }
    const headers = new Headers();
    headers.set("Content-Type", record.mimeType ?? "application/octet-stream");
    headers.set(
      "Content-Disposition",
      contentDispositionHeader(record.fileName ?? record.name, inlineRequested ? "inline" : "attachment"),
    );
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Security-Policy", "sandbox");
    headers.set("X-Frame-Options", "SAMEORIGIN");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    if (record.bytes !== null) headers.set("Content-Length", String(record.bytes));
    if (object.httpEtag) headers.set("ETag", object.httpEtag);
    headers.set(
      "Cache-Control",
      publiclyEligible ? "public, max-age=300, s-maxage=300" : "private, no-store",
    );
    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    return documentErrorResponse(error);
  }
}
