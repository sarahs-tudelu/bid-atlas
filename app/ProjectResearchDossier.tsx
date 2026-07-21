import type { ProjectResearchRecord } from "./lib/project-research/types";
import type { ProjectResearchLoadState } from "./lib/use-project-research";

interface ProjectResearchDossierProps {
  research?: ProjectResearchRecord;
  loadState: ProjectResearchLoadState;
  error?: string;
  apolloStatus: string;
  onRefresh(): void;
}

function statusLabel(
  loadState: ProjectResearchLoadState,
  research?: ProjectResearchRecord,
): string {
  if (loadState === "checking") return "Checking cache";
  if (loadState === "researching") return "Researching now";
  if (loadState === "signin-required") return "Sign-in required";
  if (loadState === "unavailable") return "Storage unavailable";
  if (loadState === "error") return "Needs attention";
  if (research?.status === "partial") return "Partial · gaps shown";
  if (research?.status === "complete") return research.cached ? "Complete · cached" : "Complete";
  return "Not researched";
}

function displayDate(value?: string): string {
  if (!value) return "not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not recorded";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function confidenceLabel(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}% source confidence`;
}

export function ProjectResearchDossier({
  research,
  loadState,
  error,
  apolloStatus,
  onRefresh,
}: ProjectResearchDossierProps) {
  const busy = loadState === "checking" || loadState === "researching";
  const namedContacts = research?.contacts.filter((contact) => contact.displayName) ?? [];
  const routedContacts = research?.contacts.filter((contact) => contact.email || contact.phone) ?? [];
  const terminalFinding = research?.lifecycle.find((finding) => finding.terminal);

  return (
    <section className="bid-desk__panel bid-desk__research-dossier">
      <div className="bid-desk__panel-heading">
        <div>
          <p className="bid-desk__eyebrow">ON-DEMAND PROJECT RESEARCH</p>
          <h3>Contacts, plans, scope, and current status</h3>
        </div>
        <span
          className={`bid-desk__provider-state bid-desk__research-state--${loadState}`}
          role="status"
        >
          {statusLabel(loadState, research)}
        </span>
      </div>

      <p className="bid-desk__panel-intro">
        Opening an exact project checks its official source, caches the result, and records evidence
        for every finding. Missing information stays visible as a gap; no person or channel is
        invented.
      </p>

      <div className="bid-desk__research-summary" aria-label="Research result summary">
        <div>
          <strong>{namedContacts.length}</strong>
          <span>named contacts</span>
        </div>
        <div>
          <strong>{routedContacts.length}</strong>
          <span>published channels</span>
        </div>
        <div>
          <strong>{research?.documents.length ?? 0}</strong>
          <span>document links</span>
        </div>
        <div>
          <strong>{research?.gaps.length ?? 0}</strong>
          <span>open gaps</span>
        </div>
      </div>

      {busy && (
        <div className="bid-desk__research-callout" aria-live="polite">
          <strong>{loadState === "checking" ? "Checking the cached dossier" : "Research is running"}</strong>
          <p>
            Official pages are read with bounded requests. A project may return partial results when
            plans, contacts, or status are not publicly exposed.
          </p>
        </div>
      )}

      {(loadState === "signin-required" || loadState === "unavailable" || loadState === "error") && (
        <div className="bid-desk__research-callout bid-desk__research-callout--warning" role="alert">
          <strong>
            {loadState === "signin-required"
              ? "Sign in to run private workspace research"
              : loadState === "unavailable"
                ? "The research store is not available in this environment"
                : "The exact-source research needs attention"}
          </strong>
          <p>{error ?? "Retry the official-source check."}</p>
        </div>
      )}

      {terminalFinding && (
        <div className="bid-desk__research-callout bid-desk__research-callout--terminal">
          <strong>Official terminal status: {terminalFinding.officialStatus}</strong>
          <p>This record remains available for history and deduplication, but it is blocked from bid release.</p>
          <a href={terminalFinding.sourceUrl} target="_blank" rel="noreferrer">View status evidence</a>
        </div>
      )}

      {research?.contacts.length ? (
        <div className="bid-desk__research-section">
          <div className="bid-desk__research-section-heading">
            <strong>Source-backed contacts</strong>
            <span>{research.contacts.length} finding{research.contacts.length === 1 ? "" : "s"}</span>
          </div>
          <div className="bid-desk__research-card-list">
            {research.contacts.map((contact) => (
              <article className="bid-desk__research-card" key={contact.id}>
                <strong>{contact.displayName ?? contact.organization ?? "Published contact channel"}</strong>
                <span>{[contact.role, contact.organization].filter(Boolean).join(" · ") || "Role not labeled"}</span>
                <div className="bid-desk__research-channels">
                  {contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}
                  {contact.phone && <a href={`tel:${contact.phone}`}>{contact.phone}</a>}
                </div>
                <p>{contact.evidence}</p>
                <small>
                  {confidenceLabel(contact.confidence)} · observed {displayDate(contact.observedAt)} ·{" "}
                  <a href={contact.sourceUrl} target="_blank" rel="noreferrer">official evidence</a>
                </small>
              </article>
            ))}
          </div>
        </div>
      ) : research && !busy ? (
        <div className="bid-desk__document-gap">
          No named or routed contact was found in the checked official sources. This is a blocking
          research gap, not permission to guess a homeowner, architect, or contractor.
        </div>
      ) : null}

      {research?.documents.length ? (
        <div className="bid-desk__research-section">
          <div className="bid-desk__research-section-heading">
            <strong>Discovered project files</strong>
            <span>Official links</span>
          </div>
          <ul className="bid-desk__document-list">
            {research.documents.map((document) => (
              <li key={document.id}>
                <a href={document.url} target="_blank" rel="noreferrer">
                  <strong>{document.name}</strong>
                  <small>
                    {document.documentType} · {document.textExtractionStatus.replaceAll("-", " ")} ·{" "}
                    evidence retained
                  </small>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {research?.scopeFacts.length ? (
        <div className="bid-desk__research-section">
          <div className="bid-desk__research-section-heading">
            <strong>What the project includes</strong>
            <span>{research.scopeFacts.length} sourced fact{research.scopeFacts.length === 1 ? "" : "s"}</span>
          </div>
          <ul className="bid-desk__research-fact-list">
            {research.scopeFacts.slice(0, 24).map((fact) => (
              <li key={fact.id}>
                <span>{fact.factType.replaceAll("-", " ")}</span>
                <strong>{fact.value}</strong>
                <a href={fact.sourceUrl} target="_blank" rel="noreferrer">Evidence</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {research?.lifecycle.length ? (
        <div className="bid-desk__research-section">
          <div className="bid-desk__research-section-heading">
            <strong>Lifecycle verification</strong>
            <span>Exact official field</span>
          </div>
          <ul className="bid-desk__research-fact-list">
            {research.lifecycle.map((finding) => (
              <li key={finding.id}>
                <span>{finding.terminal ? "terminal" : "active / non-terminal"}</span>
                <strong>{finding.officialStatus}</strong>
                <a href={finding.sourceUrl} target="_blank" rel="noreferrer">Evidence</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {research?.gaps.length ? (
        <div className="bid-desk__research-section bid-desk__research-gaps">
          <div className="bid-desk__research-section-heading">
            <strong>Still missing</strong>
            <span>Explicit gaps</span>
          </div>
          <ul>
            {research.gaps.map((gap) => (
              <li key={gap.id}>
                <strong>{gap.gapType.replaceAll("-", " ")}</strong>
                <span>{gap.message}</span>
                {gap.nextAction && <small>{gap.nextAction}</small>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {research?.extractionHandoffs.length ? (
        <div className="bid-desk__research-callout">
          <strong>{research.extractionHandoffs.length} plan-extraction handoff{research.extractionHandoffs.length === 1 ? "" : "s"}</strong>
          <p>
            Public files were discovered and queued for the document pipeline. “Awaiting extractor”
            does not mean the PDF, drawing, OCR text, or CAD contents have already been read.
          </p>
        </div>
      ) : null}

      {research && (
        <details className="bid-desk__research-sources">
          <summary>Source attempts and cache details</summary>
          <p>
            Completed {displayDate(research.completedAt)} · fresh until {displayDate(research.freshUntil)} · attempt{" "}
            {research.attempt}/{research.maxAttempts}
          </p>
          <ul>
            {research.sources.map((source) => (
              <li key={source.id}>
                <a href={source.finalUrl ?? source.sourceUrl} target="_blank" rel="noreferrer">
                  {source.finalUrl ?? source.sourceUrl}
                </a>
                <span>{source.status}{source.httpStatus ? ` · HTTP ${source.httpStatus}` : ""}</span>
              </li>
            ))}
          </ul>
          <small>{research.notice}</small>
        </details>
      )}

      <div className="bid-desk__research-actions">
        <button className="bid-desk__secondary-button" type="button" disabled={busy} onClick={onRefresh}>
          {busy ? "Research in progress…" : "Research official sources again"}
        </button>
        <small>Optional professional enrichment: {apolloStatus}. Official project evidence remains primary.</small>
      </div>
    </section>
  );
}
