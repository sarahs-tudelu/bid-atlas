"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

interface DocumentRow {
  id: string;
  projectId: string;
  sourceId: string;
  name: string;
  documentType: string;
  description?: string;
  discipline?: string;
  sheetNumbers?: string | string[];
  keywords?: string | string[];
  sourceUrl?: string;
  accessMode: string;
  visibility: string;
  licenseCode?: string;
  licenseUrl?: string;
  redistributionAllowed?: number | boolean;
  processingStatus: string;
  processingError?: string;
  mimeType?: string;
  contentHash?: string;
  fileName?: string;
  bytes?: number;
  publishedAt?: string;
  updatedAt?: string;
  matchedIn?: string;
}

interface DocumentSearchResponse {
  documents: DocumentRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface DocumentCreatedResponse {
  document: {
    documentId: string;
    versionId: string;
    projectId: string;
    contentHash?: string;
    bytes?: number;
    mimeType?: string;
    processingStatus: string;
    deduplicated: boolean;
  };
  links: { metadata: string; download: string };
}

interface DocumentsClientProps {
  initialProjectId?: string;
  initialSourceId?: string;
  initialSearch?: {
    query: string;
    documentType: string;
    processingStatus: string;
    publicOnly: boolean;
    page: number;
    pageSize: number;
  };
}

const DOCUMENT_TYPES = [
  "plans",
  "specifications",
  "addenda",
  "drawings",
  "cad",
  "bid-form",
  "schedule",
  "report",
  "other",
] as const;

const PROCESSING_STATUSES = [
  "metadata-only",
  "stored-awaiting-extraction",
  "stored-conversion-pending",
  "text-indexed",
] as const;

function displayDate(value?: string): string {
  if (!value) return "Not published";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Not published";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}

function displayBytes(value?: number): string {
  if (!value) return "Metadata only";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} bytes`;
}

function displayStatus(value: string): string {
  return value.replaceAll("-", " ");
}

function listValues(value?: string | string[]): string[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function apiErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

export function DocumentsClient({
  initialProjectId = "",
  initialSourceId = "",
  initialSearch,
}: DocumentsClientProps) {
  const [query, setQuery] = useState(initialSearch?.query ?? "");
  const [projectId, setProjectId] = useState(initialProjectId);
  const [documentType, setDocumentType] = useState(initialSearch?.documentType ?? "");
  const [processingStatus, setProcessingStatus] = useState(initialSearch?.processingStatus ?? "");
  const [publicOnly, setPublicOnly] = useState(initialSearch?.publicOnly ?? true);
  const [pageSize, setPageSize] = useState(initialSearch?.pageSize ?? 10);
  const [page, setPage] = useState(initialSearch?.page ?? 1);
  const [result, setResult] = useState<DocumentSearchResponse>({
    documents: [],
    total: 0,
    page: 1,
    pageSize: 10,
    totalPages: 1,
  });
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");
  const [intakeProjectId, setIntakeProjectId] = useState(initialProjectId);
  const [intakeSourceId, setIntakeSourceId] = useState(initialSourceId);
  const [intakeName, setIntakeName] = useState("");
  const [intakeType, setIntakeType] = useState<(typeof DOCUMENT_TYPES)[number]>("plans");
  const [intakeKeywords, setIntakeKeywords] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [visibility, setVisibility] = useState("workspace");
  const [licenseCode, setLicenseCode] = useState("");
  const [licenseUrl, setLicenseUrl] = useState("");
  const [redistributionAllowed, setRedistributionAllowed] = useState(false);
  const [fetchBytes, setFetchBytes] = useState(true);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [intakeStatus, setIntakeStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const searchRequestId = useRef(0);

  const totalPages = Math.max(1, result.totalPages || Math.ceil(result.total / pageSize));
  const hasFilters = Boolean(query || projectId || documentType || processingStatus || !publicOnly);
  const publicRightsReady = visibility !== "public" || Boolean(
    redistributionAllowed && licenseCode.trim(),
  );
  const searchSummary = useMemo(() => {
    if (searching) return "Searching indexed document metadata and extracted text…";
    if (searchMessage) return searchMessage;
    if (!result.total) return "No documents match this verified scope yet.";
    return `${result.total.toLocaleString("en-US")} document${result.total === 1 ? "" : "s"} matched.`;
  }, [result.total, searchMessage, searching]);

  const runSearch = async (
    requestedPage = 1,
    requestedPageSize = pageSize,
    overrides: Partial<{
      query: string;
      projectId: string;
      documentType: string;
      processingStatus: string;
      publicOnly: boolean;
    }> = {},
  ) => {
    const requestId = searchRequestId.current + 1;
    searchRequestId.current = requestId;
    setSearching(true);
    setSearchMessage("");
    const params = new URLSearchParams({
      page: String(requestedPage),
      limit: String(requestedPageSize),
    });
    const activeQuery = overrides.query ?? query;
    const activeProjectId = overrides.projectId ?? projectId;
    const activeDocumentType = overrides.documentType ?? documentType;
    const activeProcessingStatus = overrides.processingStatus ?? processingStatus;
    const activePublicOnly = overrides.publicOnly ?? publicOnly;
    if (activeQuery.trim()) params.set("q", activeQuery.trim());
    if (activeProjectId.trim()) params.set("projectId", activeProjectId.trim());
    if (activeDocumentType) params.set("documentType", activeDocumentType);
    if (activeProcessingStatus) params.set("processingStatus", activeProcessingStatus);
    if (activePublicOnly) params.set("public", "1");
    try {
      const response = await fetch(`/api/documents/search?${params}`, {
        headers: { accept: "application/json" },
      });
      const body = (await response.json().catch(() => null)) as DocumentSearchResponse | unknown;
      if (searchRequestId.current !== requestId) return;
      if (!response.ok) {
        if (response.status === 401) {
          setSearchMessage("Sign in to search workspace-only project documents, or select public-only search.");
        } else if (response.status === 503) {
          setSearchMessage("Document storage is not active in this environment yet.");
        } else {
          setSearchMessage(apiErrorMessage(body, `Document search failed (${response.status}).`));
        }
        setResult({ documents: [], total: 0, page: requestedPage, pageSize: requestedPageSize, totalPages: 1 });
        return;
      }
      const next = body as DocumentSearchResponse;
      setResult(next);
      setPage(next.page || requestedPage);
      setPageSize(next.pageSize || requestedPageSize);
      if (typeof window !== "undefined") {
        const canonical = new URLSearchParams();
        if (activeQuery.trim()) canonical.set("q", activeQuery.trim());
        if (activeProjectId.trim()) canonical.set("project", activeProjectId.trim());
        if (activeProjectId.trim() === initialProjectId.trim() && initialSourceId.trim()) {
          canonical.set("source", initialSourceId.trim());
        }
        if (activeDocumentType) canonical.set("type", activeDocumentType);
        if (activeProcessingStatus) canonical.set("status", activeProcessingStatus);
        if (!activePublicOnly) canonical.set("public", "0");
        const responsePage = next.page || requestedPage;
        const responsePageSize = next.pageSize || requestedPageSize;
        if (responsePage > 1) canonical.set("page", String(responsePage));
        if (responsePageSize !== 10) canonical.set("limit", String(responsePageSize));
        const nextUrl = `/documents${canonical.size ? `?${canonical}` : ""}`;
        window.history.replaceState(window.history.state, "", nextUrl);
      }
    } catch {
      if (searchRequestId.current !== requestId) return;
      setSearchMessage("Document search is temporarily unavailable.");
      setResult({ documents: [], total: 0, page: requestedPage, pageSize: requestedPageSize, totalPages: 1 });
    } finally {
      if (searchRequestId.current === requestId) setSearching(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(
      () => void runSearch(initialSearch?.page ?? 1, initialSearch?.pageSize ?? 10),
      0,
    );
    // The initial request deliberately runs once; later searches are explicit.
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    void runSearch(1);
  };

  const clearSearch = () => {
    setQuery("");
    setProjectId("");
    setDocumentType("");
    setProcessingStatus("");
    setPublicOnly(true);
    setPage(1);
    window.history.replaceState(window.history.state, "", "/documents");
    void runSearch(1, pageSize, {
      query: "",
      projectId: "",
      documentType: "",
      processingStatus: "",
      publicOnly: true,
    });
  };

  const documentMetadata = () => ({
    projectId: intakeProjectId.trim(),
    sourceId: intakeSourceId.trim(),
    name: intakeName.trim(),
    documentType: intakeType,
    keywords: intakeKeywords.split(",").map((item) => item.trim()).filter(Boolean),
    accessMode: "public",
    visibility,
    licenseCode: licenseCode.trim() || undefined,
    licenseUrl: licenseUrl.trim() || undefined,
    redistributionAllowed,
    provenance: {
      sourceName: "BidAtlas workspace intake",
      acquisitionNotes: "Added by an authenticated workspace user; review provenance and rights before public release.",
    },
  });

  const importDocument = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setIntakeStatus("Importing source metadata…");
    try {
      const response = await fetch("/api/documents/import", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          ...documentMetadata(),
          sourceUrl: sourceUrl.trim(),
          fetchBytes,
        }),
      });
      const body = (await response.json().catch(() => null)) as DocumentCreatedResponse | unknown;
      if (!response.ok) {
        setIntakeStatus(apiErrorMessage(body, response.status === 401
          ? "Sign in through the private workspace to import documents."
          : `Document import failed (${response.status}).`));
        return;
      }
      const created = body as DocumentCreatedResponse;
      setIntakeStatus(
        `${intakeName || "Document"} recorded as ${displayStatus(created.document.processingStatus)}${created.document.deduplicated ? "; existing bytes were reused" : ""}.`,
      );
      setQuery(intakeKeywords);
      setProjectId(intakeProjectId);
      setPublicOnly(false);
      await runSearch(1, pageSize, {
        query: intakeKeywords,
        projectId: intakeProjectId,
        publicOnly: false,
      });
    } catch {
      setIntakeStatus("Document import is temporarily unavailable.");
    } finally {
      setSubmitting(false);
    }
  };

  const uploadDocument = async (event: FormEvent) => {
    event.preventDefault();
    if (!uploadFile) {
      setIntakeStatus("Choose a project document to upload.");
      return;
    }
    if (uploadFile.size > 25 * 1024 * 1024) {
      setIntakeStatus("Files may be no larger than 25 MB.");
      return;
    }
    setSubmitting(true);
    setIntakeStatus("Uploading the private workspace copy…");
    try {
      const metadata = documentMetadata();
      const form = new FormData();
      form.set("file", uploadFile);
      form.set("metadata", JSON.stringify(metadata));
      const response = await fetch("/api/documents/upload", {
        method: "POST",
        headers: { accept: "application/json" },
        body: form,
      });
      const body = (await response.json().catch(() => null)) as DocumentCreatedResponse | unknown;
      if (!response.ok) {
        setIntakeStatus(apiErrorMessage(body, response.status === 401
          ? "Sign in through the private workspace to upload documents."
          : `Document upload failed (${response.status}).`));
        return;
      }
      const created = body as DocumentCreatedResponse;
      setIntakeStatus(
        `Stored ${uploadFile.name} as ${displayStatus(created.document.processingStatus)}${created.document.deduplicated ? "; duplicate bytes were not stored twice" : ""}.`,
      );
      setProjectId(intakeProjectId);
      setPublicOnly(false);
      await runSearch(1, pageSize, {
        projectId: intakeProjectId,
        publicOnly: false,
      });
    } catch {
      setIntakeStatus("Document upload is temporarily unavailable.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <section className="documents-hero">
        <div>
          <p className="eyebrow">PLANS + SPECIFICATIONS LIBRARY</p>
          <h1>Find the requirement inside the documents.</h1>
          <p>
            Search lawfully collected plan, specification, addendum, drawing, and CAD metadata.
            Extracted text is clearly distinguished from metadata-only and conversion-pending files.
          </p>
        </div>
        <div className="documents-guardrail">
          <strong>Rights-aware storage</strong>
          <span>Private by default</span>
          <span>SHA-256 deduplication</span>
          <span>Public download only with explicit redistribution rights</span>
        </div>
      </section>

      <section className="document-search-panel" aria-labelledby="document-search-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">DOCUMENT SEARCH</p>
            <h2 id="document-search-title">Search products, clauses, sheets, and project files</h2>
          </div>
          <span className="document-search-total">{result.total.toLocaleString("en-US")} matches</span>
        </div>
        <form className="document-search-form" onSubmit={submitSearch}>
          <label className="document-field document-field--query">
            <span>Keywords</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={'canopy, "partition wall", lighting'} />
          </label>
          <label className="document-field">
            <span>Project ID</span>
            <input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="Source project identifier" />
          </label>
          <label className="document-field">
            <span>Document type</span>
            <select value={documentType} onChange={(event) => setDocumentType(event.target.value)}>
              <option value="">All document types</option>
              {DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{displayStatus(type)}</option>)}
            </select>
          </label>
          <label className="document-field">
            <span>Processing state</span>
            <select value={processingStatus} onChange={(event) => setProcessingStatus(event.target.value)}>
              <option value="">All processing states</option>
              {PROCESSING_STATUSES.map((status) => <option key={status} value={status}>{displayStatus(status)}</option>)}
            </select>
          </label>
          <label className="document-public-toggle">
            <input type="checkbox" checked={publicOnly} onChange={(event) => setPublicOnly(event.target.checked)} />
            <span><strong>Public-only</strong><small>Workspace files require sign-in.</small></span>
          </label>
          <div className="document-search-actions">
            <button type="submit" disabled={searching}>{searching ? "Searching…" : "Search documents"}</button>
            <button type="button" className="document-clear-button" disabled={!hasFilters} onClick={clearSearch}>Clear</button>
          </div>
        </form>
        <p className="document-search-message" role="status">{searchSummary}</p>

        <div className="document-result-list">
          {result.documents.map((document) => {
            const keywords = listValues(document.keywords);
            const sheets = listValues(document.sheetNumbers);
            const publicQuery = publicOnly ? "?public=1" : "";
            return (
              <article className="document-result-card" key={document.id}>
                <div className="document-result-main">
                  <div className="document-result-kicker">
                    <span>{displayStatus(document.documentType)}</span>
                    <span className={`document-processing document-processing--${document.processingStatus}`}>{displayStatus(document.processingStatus)}</span>
                    {document.matchedIn && <span>Matched: {displayStatus(document.matchedIn)}</span>}
                  </div>
                  <h3>{document.name}</h3>
                  <p>{document.description || "No description was published with this document."}</p>
                  <dl className="document-result-facts">
                    <div><dt>Project</dt><dd>{document.projectId}</dd></div>
                    <div><dt>Source</dt><dd>{document.sourceId}</dd></div>
                    <div><dt>Published</dt><dd>{displayDate(document.publishedAt)}</dd></div>
                    <div><dt>Stored file</dt><dd>{displayBytes(document.bytes)}</dd></div>
                  </dl>
                  {(keywords.length > 0 || sheets.length > 0) && (
                    <div className="document-tags">
                      {keywords.slice(0, 8).map((keyword) => <span key={`keyword-${keyword}`}>{keyword}</span>)}
                      {sheets.slice(0, 8).map((sheet) => <span key={`sheet-${sheet}`}>Sheet {sheet}</span>)}
                    </div>
                  )}
                </div>
                <div className="document-result-actions">
                  <a href={`/api/documents/${encodeURIComponent(document.id)}${publicQuery}`} target="_blank" rel="noreferrer">Metadata ↗</a>
                  {document.bytes ? (
                    <a href={`/api/documents/${encodeURIComponent(document.id)}/download${publicQuery}`}>Download</a>
                  ) : <span>No stored bytes</span>}
                  {document.sourceUrl && <a href={document.sourceUrl} target="_blank" rel="noreferrer">Official source ↗</a>}
                  <small>{document.visibility} · {document.accessMode}</small>
                </div>
              </article>
            );
          })}
        </div>

        <nav className="document-pagination" aria-label="Document result pages">
          <button type="button" disabled={page <= 1 || searching} onClick={() => void runSearch(1)}>First</button>
          <button type="button" disabled={page <= 1 || searching} onClick={() => void runSearch(page - 1)}>Previous</button>
          <span>Page {page} of {totalPages}</span>
          <button type="button" disabled={page >= totalPages || searching} onClick={() => void runSearch(page + 1)}>Next</button>
          <button type="button" disabled={page >= totalPages || searching} onClick={() => void runSearch(totalPages)}>Last</button>
          <label>Results per page
            <select value={pageSize} onChange={(event) => {
              const next = Number(event.target.value);
              setPageSize(next);
              setPage(1);
              void runSearch(1, next);
            }}>
              <option value={10}>10</option><option value={25}>25</option><option value={50}>50</option>
            </select>
          </label>
        </nav>
      </section>

      <section className="document-intake" aria-labelledby="document-intake-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">WORKSPACE INTAKE</p>
            <h2 id="document-intake-title">Add a verified public link or upload an authorized copy</h2>
          </div>
        </div>
        <p className="document-intake-intro">
          Use the source project and source IDs shown in Bid Desk. Uploads remain workspace-only unless
          public access and redistribution rights are explicitly documented.
        </p>
        <div className="document-intake-common">
          <label className="document-field"><span>Project ID</span><input required value={intakeProjectId} onChange={(event) => setIntakeProjectId(event.target.value)} /></label>
          <label className="document-field"><span>Source ID</span><input required value={intakeSourceId} onChange={(event) => setIntakeSourceId(event.target.value)} /></label>
          <label className="document-field"><span>Document name</span><input required value={intakeName} onChange={(event) => setIntakeName(event.target.value)} /></label>
          <label className="document-field"><span>Type</span><select value={intakeType} onChange={(event) => setIntakeType(event.target.value as (typeof DOCUMENT_TYPES)[number])}>{DOCUMENT_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
          <label className="document-field document-field--wide"><span>Keywords, comma separated</span><input value={intakeKeywords} onChange={(event) => setIntakeKeywords(event.target.value)} placeholder="canopy, partition wall, Section 10 22 26" /></label>
          <label className="document-field"><span>Visibility</span><select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="workspace">Workspace</option><option value="private">Private</option><option value="public">Public with documented rights</option></select></label>
          <label className="document-field"><span>License or terms code</span><input required={visibility === "public"} value={licenseCode} onChange={(event) => setLicenseCode(event.target.value)} placeholder="CC-BY-4.0 or terms-reviewed" /></label>
          <label className="document-field document-field--wide"><span>License or terms URL (optional)</span><input type="url" value={licenseUrl} onChange={(event) => setLicenseUrl(event.target.value)} placeholder="https://agency.gov/terms" /></label>
          <label className="document-public-toggle"><input type="checkbox" checked={redistributionAllowed} onChange={(event) => setRedistributionAllowed(event.target.checked)} /><span><strong>Redistribution allowed</strong><small>Confirm from the publisher/license.</small></span></label>
        </div>
        <div className="document-intake-methods">
          <form className="document-intake-card" onSubmit={importDocument}>
            <span className="document-intake-number">01</span>
            <h3>Import official HTTPS source</h3>
            <p>Record metadata, and optionally archive supported public bytes after safety checks.</p>
            <label className="document-field"><span>Official document URL</span><input type="url" required value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://agency.gov/project/plans.pdf" /></label>
            <label className="document-public-toggle"><input type="checkbox" checked={fetchBytes} onChange={(event) => setFetchBytes(event.target.checked)} /><span><strong>Archive supported bytes</strong><small>Otherwise store metadata only.</small></span></label>
            <button type="submit" disabled={submitting || !intakeProjectId || !intakeSourceId || !intakeName || !sourceUrl || !publicRightsReady}>Import source</button>
          </form>
          <form className="document-intake-card" onSubmit={uploadDocument}>
            <span className="document-intake-number">02</span>
            <h3>Upload authorized workspace copy</h3>
            <p>PDF, Office, image, ZIP, DWG, DXF, DGN, IFC, Revit, SketchUp, or PLN up to 25 MB.</p>
            <label className="document-file-field"><span>Project document</span><input type="file" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} /></label>
            {uploadFile && <small>{uploadFile.name} · {displayBytes(uploadFile.size)}</small>}
            <button type="submit" disabled={submitting || !uploadFile || !intakeProjectId || !intakeSourceId || !intakeName || !publicRightsReady}>{visibility === "public" ? "Upload authorized public copy" : "Upload private copy"}</button>
          </form>
        </div>
        {intakeStatus && <p className="document-intake-status" role="status">{intakeStatus}</p>}
      </section>
    </>
  );
}
