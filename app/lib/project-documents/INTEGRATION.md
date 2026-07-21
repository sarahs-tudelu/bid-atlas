# Durable project-document integration

This tranche stores structured document metadata in the logical D1 `DB` binding and file bytes in the logical R2 `DOCUMENTS` binding declared in `.openai/hosting.json`. It does not change project-source ingestion or automatically redistribute source files.

## API integration points

### Import a public source URL

`POST /api/documents/import` with `Content-Type: application/json` and an authenticated workspace session or `Authorization: Bearer <BIDATLAS_INTERNAL_TOKEN>`.

```json
{
  "projectId": "source:project-record",
  "sourceId": "official-source-id",
  "name": "Issued architectural plans",
  "documentType": "plans",
  "description": "Architectural drawing set",
  "discipline": "architectural",
  "sheetNumbers": ["A-101", "A-201"],
  "keywords": ["canopy", "partition wall"],
  "sourceUrl": "https://public.example.gov/files/plans.pdf",
  "sourceVersionId": "addendum-2",
  "accessMode": "public",
  "visibility": "workspace",
  "licenseCode": "source-terms-reviewed",
  "licenseUrl": "https://public.example.gov/terms",
  "redistributionAllowed": false,
  "publishedAt": "2026-07-16T12:00:00Z",
  "fetchBytes": true,
  "provenance": {
    "publisher": "Example public owner",
    "sourceRecordId": "IFB-2026-101"
  }
}
```

Set `fetchBytes` to `false` when only a lawful source link and searchable metadata should be retained. Oversize or unsupported remote files also become metadata-only records instead of being silently dropped.

### Upload a file

`POST /api/documents/upload` as `multipart/form-data`. Include one `file` part and either a `metadata` part containing the JSON object above or individual metadata fields. `sourceUrl` is optional for an upload; when absent, the service records an internal upload URN rather than inventing a public URL. The request must carry a valid `Content-Length` no larger than 26 MiB so the worker can reject oversize bodies before `formData()` buffers them; the file itself remains limited to 25 MiB.

Both ingestion routes return HTTP 201:

```json
{
  "document": {
    "documentId": "doc_...",
    "versionId": "dver_...",
    "projectId": "source:project-record",
    "contentHash": "sha256...",
    "bytes": 12345,
    "mimeType": "application/pdf",
    "processingStatus": "stored-awaiting-extraction",
    "deduplicated": false
  },
  "links": {
    "metadata": "/api/documents/doc_...",
    "download": "/api/documents/doc_.../download"
  }
}
```

### Search and retrieve metadata

- `GET /api/documents/search?q=canopy&projectId=...&documentType=plans&processingStatus=text-indexed&page=1&limit=20`
- `GET /api/documents/:documentId`

Workspace authentication is required by default. `workspace` records are readable by signed-in workspace users, while `private` records are readable only by their `uploaded_by` owner or the internal document service. Append `public=1` only for an explicitly public, rights-gated metadata view. Search covers the `document_metadata_fts` metadata index and existing `document_chunk_fts` extracted-text index. Responses never include R2 object keys.

### Submit OCR, PDF, or CAD-conversion text

`POST /api/documents/:documentId/extractions` is the handoff for an OCR/PDF parser or CAD-conversion job. It requires `Authorization: Bearer <BIDATLAS_INTERNAL_TOKEN>`; an ordinary workspace session is intentionally insufficient because this route replaces indexed text and processing state:

```json
{
  "versionId": "dver_...",
  "extractor": "example-ocr",
  "extractorVersion": "2026-07",
  "method": "ocr",
  "language": "en",
  "pages": 42,
  "confidence": 0.93,
  "chunks": [
    { "pageStart": 1, "pageEnd": 1, "text": "A-101 FLOOR PLAN canopy..." }
  ]
}
```

Allowed methods are `native-text`, `ocr`, `cad-converter`, and `manual`. Plain text, CSV, and text DXF uploads are indexed immediately when small enough without calling the protected callback. PDF/image extraction and opaque CAD conversion remain `stored-awaiting-extraction` or `stored-conversion-pending` until the internal service calls this endpoint.

### Download bytes

`GET /api/documents/:documentId/download` returns an attachment for an authenticated workspace request. An unauthenticated request must explicitly use `?public=1`, and bytes are served only when all of these are true:

1. document visibility is `public`;
2. source access is `public`;
3. a source license or reviewed terms code is recorded;
4. redistribution permission is explicitly recorded;
5. the content-addressed blob is present; and
6. a separate security/review process has changed `document_blobs.security_status` from `unscanned` to `approved`.

Uploads and URL imports therefore never become public downloads by default. Downloads use attachment disposition, `nosniff`, and a sandbox content-security policy.

Remote byte imports accept public HTTPS only, validate every redirect, fail closed unless public DNS A/AAAA lookups return only public addresses, and enforce a 20-second deadline across DNS, redirect, and body reads. The Workers `fetch` API does not expose an IP-pinning control, so DNS validation materially reduces private-address SSRF but cannot eliminate the resolver-to-fetch rebinding window; deployment-level egress policy remains the final network boundary.

## Storage and processing model

- `documents` is the searchable project-linked metadata record, including type, discipline, sheets, keywords, license, access, visibility, provenance, and processing state.
- `document_versions` records every source version or content version.
- `document_blobs` deduplicates bytes globally by SHA-256. R2 keys use `project-documents/sha256/<prefix>/<hash>`; access rights remain on the document record, not the shared blob.
- `document_extractions`, `document_chunks`, and `document_chunk_fts` hold parser output with page provenance.
- `document_metadata_fts` is maintained by D1 triggers from `documents`.

The schema change is migration `drizzle/0010_sticky_mephisto.sql`. Apply it before enabling any of the routes in a hosted environment.
