"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectRecord } from "./lib/types";
import type { ResearchDocumentFinding } from "./lib/project-research/types";
import type { ProjectResearchLoadState } from "./lib/use-project-research";

type DrawingAction = "view" | "download";
type DrawingDocumentType = "plans" | "specifications" | "drawings" | "cad";

interface DrawingCandidate {
  id: string;
  retrievalId?: string;
  name: string;
  url: string;
  documentType: DrawingDocumentType;
  accessMode: "public" | "free-account";
  indexStatus?: string;
  description: string;
}

interface ImportedDrawing {
  documentId: string;
  mimeType: string;
  bytes: number;
  processingStatus: string;
}

interface RetrievalResponse {
  document?: {
    documentId?: string;
    mimeType?: string;
    bytes?: number | null;
    contentHash?: string | null;
    processingStatus?: string;
  };
  error?: string | { message?: string };
}

interface ProjectDrawingsPanelProps {
  project: ProjectRecord;
  researchDocuments: ResearchDocumentFinding[];
  researchLoadState: ProjectResearchLoadState;
  researchError?: string;
  initialAction?: DrawingAction;
  onResearch(): void;
}

const PREVIEWABLE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
]);

export function projectDrawingCandidates(
  project: ProjectRecord,
  researchDocuments: ResearchDocumentFinding[],
): DrawingCandidate[] {
  const candidates: DrawingCandidate[] = [];
  const researchedTypes = new Set(
    researchDocuments
      .filter((document) =>
        document.documentType === "plans" ||
        document.documentType === "specifications" ||
        document.documentType === "drawings" ||
        document.documentType === "cad")
      .map((document) => document.documentType),
  );
  for (const document of project.documents) {
    if (document.kind !== "plans" && document.kind !== "specifications") continue;
    if (
      document.indexStatus === "metadata-only" &&
      researchedTypes.has(document.kind)
    ) {
      continue;
    }
    candidates.push({
      id: `record:${document.url}`,
      name: document.name,
      url: document.url,
      documentType: document.kind,
      accessMode: document.access,
      indexStatus: document.indexStatus,
      description: `Published ${document.kind} link from ${project.sourceName}.`,
    });
  }
  for (const document of researchDocuments) {
    if (
      document.documentType !== "plans" &&
      document.documentType !== "specifications" &&
      document.documentType !== "drawings" &&
      document.documentType !== "cad"
    ) {
      continue;
    }
    candidates.push({
      id: `research:${document.id}`,
      retrievalId: document.id,
      name: document.name,
      url: document.url,
      documentType: document.documentType,
      accessMode: "public",
      indexStatus: document.textExtractionStatus,
      description: document.evidence,
    });
  }
  return Array.from(
    new Map(candidates.map((document) => [document.url, document])).values(),
  );
}

function retrievalErrorMessage(
  body: RetrievalResponse | null,
  fallback: string,
): string {
  if (typeof body?.error === "string") return body.error;
  if (body?.error && typeof body.error === "object" && body.error.message) {
    return body.error.message;
  }
  return fallback;
}

function accessLabel(document: DrawingCandidate): string {
  if (
    document.accessMode === "free-account" ||
    document.indexStatus === "account-gated"
  ) {
    return "official portal account required";
  }
  if (document.indexStatus === "not-public") return "not publicly downloadable";
  if (!document.retrievalId) return "official link · verification required";
  return "verified public drawing link";
}

function canPull(document: DrawingCandidate): boolean {
  return Boolean(document.retrievalId) &&
    document.accessMode === "public" &&
    document.indexStatus !== "account-gated" &&
    document.indexStatus !== "not-public";
}

function triggerDownload(documentId: string): void {
  const anchor = document.createElement("a");
  anchor.href = `/api/documents/${encodeURIComponent(documentId)}/download`;
  anchor.download = "";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export function ProjectDrawingsPanel({
  project,
  researchDocuments,
  researchLoadState,
  researchError,
  initialAction,
  onResearch,
}: ProjectDrawingsPanelProps) {
  const drawings = useMemo(
    () => projectDrawingCandidates(project, researchDocuments),
    [project, researchDocuments],
  );
  const handledInitialAction = useRef(false);
  const mounted = useRef(true);
  const inFlight = useRef(new Map<string, Promise<ImportedDrawing>>());
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [loadingId, setLoadingId] = useState<string>();
  const [loaded, setLoaded] = useState<Record<string, ImportedDrawing>>({});
  const [preview, setPreview] = useState<{ documentId: string; name: string }>();
  const [message, setMessage] = useState("");
  const researchBusy =
    researchLoadState === "checking" || researchLoadState === "researching";

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  useEffect(() => {
    if (!initialAction || handledInitialAction.current) {
      return;
    }
    handledInitialAction.current = true;
    setExpanded(true);
    setMessage(
      initialAction === "download"
        ? "Choose an official drawing below to pull and download."
        : "Choose an official drawing below to pull into the in-app viewer.",
    );
    if (drawings.length === 0 && !researchBusy) onResearch();
  }, [drawings.length, initialAction, onResearch, project.id, researchBusy]);

  const retrieveDrawing = (drawing: DrawingCandidate): Promise<ImportedDrawing> => {
    const retrievalId = drawing.retrievalId;
    if (!retrievalId) {
      return Promise.reject(
        new Error("BidAtlas must verify this source link before pulling its bytes."),
      );
    }
    const requestKey = `${project.id}:${retrievalId}`;
    const pending = inFlight.current.get(requestKey);
    if (pending) return pending;

    const request = (async () => {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(project.id)}/drawings/${encodeURIComponent(retrievalId)}`,
        {
          method: "POST",
          headers: { accept: "application/json" },
        },
      );
      const body = (await response.json().catch(() => null)) as RetrievalResponse | null;
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(
            "Sign in through the private workspace to pull and view project drawings.",
          );
        }
        throw new Error(
          retrievalErrorMessage(
            body,
            `The official drawing could not be loaded (HTTP ${response.status}).`,
          ),
        );
      }
      const imported = body?.document;
      if (
        !imported?.documentId ||
        !imported.contentHash ||
        !imported.bytes ||
        !imported.mimeType
      ) {
        throw new Error(
          "The verified link was retained, but its bytes were unavailable, oversized, or not a supported drawing file. Open the official source to continue.",
        );
      }
      return {
        documentId: imported.documentId,
        mimeType: imported.mimeType.split(";", 1)[0].toLowerCase(),
        bytes: imported.bytes,
        processingStatus:
          imported.processingStatus ?? "stored-awaiting-extraction",
      };
    })();
    inFlight.current.set(requestKey, request);
    const clearRequest = () => {
      if (inFlight.current.get(requestKey) === request) inFlight.current.delete(requestKey);
    };
    void request.then(clearRequest, clearRequest);
    return request;
  };

  const pullDrawing = async (
    drawing: DrawingCandidate,
    action: DrawingAction,
  ) => {
    setExpanded(true);
    setSelectedId(drawing.id);
    setMessage("");
    if (!canPull(drawing)) {
      if (
        drawing.accessMode === "free-account" ||
        drawing.indexStatus === "account-gated"
      ) {
        setMessage(
          "This file requires the official portal account. BidAtlas will not bypass its login or access controls.",
        );
      } else {
        setMessage(
          "BidAtlas is verifying this exact link before pulling bytes. Run project research or use the official-source link.",
        );
        if (!researchBusy) onResearch();
      }
      return;
    }

    const existing = loaded[drawing.id];
    if (existing) {
      if (action === "download") {
        triggerDownload(existing.documentId);
        setMessage("The stored official drawing download has started.");
      } else if (PREVIEWABLE_MIME_TYPES.has(existing.mimeType)) {
        setPreview({ documentId: existing.documentId, name: drawing.name });
        setMessage("Drawing loaded from the secure project document store.");
      } else {
        setMessage(
          "This file type cannot be rendered safely in the browser. Download the original file or open the official source.",
        );
      }
      return;
    }

    setLoadingId(drawing.id);
    setPreview(undefined);
    setMessage("Loading drawing from the verified official source…");
    try {
      const stored = await retrieveDrawing(drawing);
      if (!mounted.current) return;
      setLoaded((current) => ({ ...current, [drawing.id]: stored }));
      if (action === "download") {
        triggerDownload(stored.documentId);
        setMessage(
          "The official drawing was pulled on demand and the download has started.",
        );
      } else if (PREVIEWABLE_MIME_TYPES.has(stored.mimeType)) {
        setPreview({ documentId: stored.documentId, name: drawing.name });
        setMessage("The official drawing was pulled on demand and is ready below.");
      } else {
        setMessage(
          stored.processingStatus === "stored-conversion-pending"
            ? "The original CAD/package file is stored. In-app preview needs conversion; download the original for now."
            : "This file type cannot be rendered safely in the browser. Download the original file instead.",
        );
      }
    } catch (error) {
      if (!mounted.current) return;
      setMessage(
        error instanceof Error
          ? error.message
          : "The official drawing could not be loaded. Retry or open the official source.",
      );
    } finally {
      if (mounted.current) setLoadingId(undefined);
    }
  };

  const openWorkspace = (action: DrawingAction) => {
    setExpanded(true);
    setMessage("");
    if (drawings.length === 0) {
      setMessage("Finding official drawings for this exact project…");
      if (!researchBusy) onResearch();
      return;
    }
    const firstPullable = drawings.find(canPull);
    if (action === "view" && firstPullable) {
      void pullDrawing(firstPullable, "view");
      return;
    }
    if (action === "download" && drawings.length === 1) {
      void pullDrawing(drawings[0], "download");
      return;
    }
    if (!firstPullable && !researchBusy) onResearch();
    setMessage(
      action === "download"
        ? "Choose a verified drawing below to download."
        : "Choose a verified drawing below to view.",
    );
  };

  return (
    <section
      id="project-drawings"
      className="project-drawings"
      aria-label="Project plans and drawings"
    >
      <div className="project-drawings__primary-actions">
        <button
          type="button"
          className="project-drawings__view-button"
          aria-expanded={expanded}
          aria-controls="project-drawings-workspace"
          onClick={() => openWorkspace("view")}
        >
          View plans/drawings
        </button>
        <button
          type="button"
          className="project-drawings__download-button"
          aria-expanded={expanded}
          aria-controls="project-drawings-workspace"
          onClick={() => openWorkspace("download")}
        >
          Download drawings
        </button>
      </div>
      <small className="project-drawings__on-demand-note">
        Files are pulled only when requested. Project matching, access rules, and file limits remain enforced.
      </small>

      {expanded && (
        <div id="project-drawings-workspace" className="project-drawings__workspace">
          <header>
            <div>
              <strong>Plans &amp; drawing viewer</strong>
              <span>
                {drawings.length} drawing link{drawings.length === 1 ? "" : "s"} for this exact project
              </span>
            </div>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-label="Close plans and drawing viewer"
            >
              Close
            </button>
          </header>

          {researchBusy && drawings.length === 0 && (
            <div className="project-drawings__state" role="status">
              Finding official drawings…
            </div>
          )}
          {!researchBusy && drawings.length === 0 && (
            <div className="project-drawings__empty">
              <strong>No public drawing file is verified yet.</strong>
              <p>
                BidAtlas checked the current project record without treating a permit page, bidder list, or bid listing as a plan set.
              </p>
              {researchError && <small>{researchError}</small>}
              <div>
                <button type="button" onClick={onResearch}>Research drawings again</button>
                <a href={project.sourceUrl} target="_blank" rel="noreferrer">
                  Open official project record ↗
                </a>
              </div>
            </div>
          )}

          {drawings.length > 0 && (
            <div className="project-drawings__layout">
              <div className="project-drawings__files" aria-label="Available project drawings">
                {drawings.map((drawing) => {
                  const stored = loaded[drawing.id];
                  const busy = loadingId === drawing.id;
                  const pullable = canPull(drawing);
                  return (
                    <article
                      className={selectedId === drawing.id ? "is-selected" : undefined}
                      key={drawing.id}
                    >
                      <div>
                        <strong>{drawing.name}</strong>
                        <small>{drawing.documentType} · {accessLabel(drawing)}</small>
                      </div>
                      <div className="project-drawings__file-actions">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void pullDrawing(drawing, "view")}
                        >
                          {busy ? "Loading…" : pullable ? "View in app" : "Verify to view"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void pullDrawing(drawing, "download")}
                        >
                          {pullable ? "Download" : "Verify to download"}
                        </button>
                        <a href={drawing.url} target="_blank" rel="noreferrer">Official source ↗</a>
                      </div>
                      {stored && (
                        <small className="project-drawings__stored-state">
                          Pulled on demand · {(stored.bytes / 1024 / 1024).toFixed(1)} MB
                        </small>
                      )}
                    </article>
                  );
                })}
              </div>

              <div className="project-drawings__preview">
                {preview ? (
                  <iframe
                    key={preview.documentId}
                    title={`Drawing viewer: ${preview.name}`}
                    src={`/api/documents/${encodeURIComponent(preview.documentId)}/download?disposition=inline`}
                  />
                ) : (
                  <div>
                    <strong>On-demand viewer</strong>
                    <p>
                      Select View in app. PDF, PNG, and JPEG drawings render here only after the exact official file is pulled.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
          {message && <p className="project-drawings__message" role="status">{message}</p>}
        </div>
      )}
    </section>
  );
}
