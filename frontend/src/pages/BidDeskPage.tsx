import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { apiRequest } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { useToast } from "../components/ToastProvider";
import { useApi } from "../hooks/useApi";
import { describeDeadline, formatDateTime, formatMoney } from "../lib/format";
import type { Project, ProjectDocument, ProjectParticipant } from "../types";

interface Draft {
  projectId: string;
  scope: string;
  exclusions: string;
  notes: string;
  updatedAt?: string;
}

const emptyDraft = (projectId: string): Draft => ({ projectId, scope: "", exclusions: "", notes: "" });

/** Only the editable fields decide whether there is unsaved work. */
const fingerprint = (draft: Draft): string => JSON.stringify([draft.scope, draft.exclusions, draft.notes]);

function DocumentLink({ record }: { record: ProjectDocument }) {
  return (
    <li>
      <a className="evidence-doc" href={record.url} target="_blank" rel="noreferrer">
        <div>
          <strong>{record.name}</strong>
          <small>
            {record.kind || "document"}
            {record.access === "free-account" ? " · account required" : " · public"}
          </small>
        </div>
        <span aria-hidden="true">↗</span>
      </a>
    </li>
  );
}

function Contact({ participant }: { participant: ProjectParticipant }) {
  return (
    <li className="evidence-contact">
      <strong>{participant.name || participant.organization || "Unnamed contact"}</strong>
      <span>{[participant.role, participant.name && participant.organization].filter(Boolean).join(" · ") || "Role not published"}</span>
      {participant.email && <a href={`mailto:${participant.email}`}>{participant.email}</a>}
      {participant.phone && <a href={`tel:${participant.phone.replace(/[^\d+]/g, "")}`}>{participant.phone}</a>}
    </li>
  );
}

export function BidDeskPage() {
  const [params] = useSearchParams();
  const projectId = params.get("project") ?? "";
  const { notify } = useToast();

  const projectState = useApi<Project>(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}` : "/api/projects/__none__",
  );

  const [draft, setDraft] = useState<Draft>(() => emptyDraft(projectId));
  const [savedFingerprint, setSavedFingerprint] = useState(() => fingerprint(emptyDraft(projectId)));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const dirty = fingerprint(draft) !== savedFingerprint;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    apiRequest<{ draft: Draft | null }>(`/api/bid-drafts?projectId=${encodeURIComponent(projectId)}`)
      .then((response) => {
        if (cancelled) return;
        const loaded = response.draft ?? emptyDraft(projectId);
        setDraft(loaded);
        setSavedFingerprint(fingerprint(loaded));
      })
      .catch(() => {
        if (cancelled) return;
        setDraft(emptyDraft(projectId));
        setSavedFingerprint(fingerprint(emptyDraft(projectId)));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError("");
    try {
      const response = await apiRequest<{ draft: Draft }>("/api/bid-drafts", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setDraft(response.draft);
      setSavedFingerprint(fingerprint(response.draft));
      notify("Bid draft saved.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Save failed";
      setSaveError(message);
      notify(message, "error");
    } finally {
      setSaving(false);
    }
  }, [draft, notify]);

  // Ctrl/Cmd+S saves without leaving the keyboard, and a reload warns about unsaved work.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty && !saving) void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirty, saving, save]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const project = projectState.data;
  const deadline = useMemo(() => describeDeadline(project?.bidDate), [project?.bidDate]);

  if (!projectId) {
    return (
      <main className="route-page page-width">
        <header className="route-heading">
          <p className="eyebrow">Controlled estimating</p>
          <h1>Bid desk</h1>
          <p>Choose an opportunity to build a source-backed scope and internal bid package.</p>
        </header>
        <div className="empty-panel">
          <h2>No project selected</h2>
          <p>Open an opportunity first, then bring it into the bid desk.</p>
          <Link className="button button-primary" to="/projects">
            Browse open bids
          </Link>
        </div>
      </main>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };

  return (
    <main className="route-page page-width">
      <AsyncState loading={projectState.loading} error={projectState.error} onRetry={projectState.refetch}>
        {project && (
          <>
            <header className="route-heading bid-desk-heading">
              <p className="eyebrow">Bid desk · {project.sourceRecordId}</p>
              <h1>{project.title}</h1>
              {project.summary && <p>{project.summary}</p>}
              <div className="hero-actions">
                <a className="button button-primary" href={project.sourceUrl} target="_blank" rel="noreferrer">
                  Verify official record ↗
                </a>
                <Link className="button button-quiet" to={`/outreach?project=${encodeURIComponent(project.id)}`}>
                  Email outreach
                </Link>
                <Link className="button button-quiet" to="/projects">
                  Back to bids
                </Link>
              </div>
            </header>

            <div className="bid-desk-layout">
              <aside className="evidence-panel">
                <p className="eyebrow">Published evidence</p>
                <h2>Project record</h2>
                <dl>
                  <div>
                    <dt>Agency</dt>
                    <dd>{project.agency || "Not published"}</dd>
                  </div>
                  <div>
                    <dt>Location</dt>
                    <dd>{[project.address, project.city || project.county, project.state].filter(Boolean).join(" · ") || "Not published"}</dd>
                  </div>
                  <div>
                    <dt>Bid deadline</dt>
                    <dd>
                      {formatDateTime(project.bidDate)}
                      {deadline.tone !== "none" && deadline.tone !== "neutral" && (
                        <>
                          {" "}
                          <span
                            className={`due-badge ${deadline.tone === "urgent" ? "due-urgent" : deadline.tone === "soon" ? "due-soon" : "due-passed"}`}
                          >
                            {deadline.label}
                          </span>
                        </>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Published value</dt>
                    <dd>{formatMoney(project.value)}</dd>
                  </div>
                </dl>

                <h3>Documents</h3>
                {project.documents?.length ? (
                  <ul>
                    {project.documents.map((record) => (
                      <DocumentLink key={record.url} record={record} />
                    ))}
                  </ul>
                ) : (
                  <p className="evidence-empty">No document route was published by the source.</p>
                )}

                <h3>Published contacts</h3>
                {project.participants?.length ? (
                  <ul>
                    {project.participants.map((participant, index) => (
                      <Contact key={`${participant.name ?? participant.organization ?? "contact"}:${index}`} participant={participant} />
                    ))}
                  </ul>
                ) : (
                  <p className="evidence-empty">No contact was published by the source.</p>
                )}
              </aside>

              <form className="draft-form" onSubmit={submit}>
                <div>
                  <p className="eyebrow">Internal workspace</p>
                  <h2>Scope and review notes</h2>
                </div>

                <label>
                  <span>Proposed scope</span>
                  <textarea
                    value={draft.scope}
                    onChange={(event) => setDraft({ ...draft, scope: event.target.value })}
                    rows={7}
                    placeholder="Describe the included work…"
                  />
                </label>
                <label>
                  <span>Exclusions</span>
                  <textarea
                    value={draft.exclusions}
                    onChange={(event) => setDraft({ ...draft, exclusions: event.target.value })}
                    rows={5}
                    placeholder="List explicit exclusions…"
                  />
                </label>
                <label>
                  <span>Estimator notes</span>
                  <textarea
                    value={draft.notes}
                    onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                    rows={6}
                    placeholder="Questions, addenda, and follow-ups…"
                  />
                </label>

                <div className="save-row">
                  <button className="button button-primary" type="submit" disabled={saving || !dirty}>
                    {saving ? "Saving…" : "Save draft"}
                  </button>
                  <span role="status">
                    {saveError ? (
                      <span className="is-error">{saveError}</span>
                    ) : saving ? (
                      "Saving…"
                    ) : dirty ? (
                      <span className="is-dirty">Unsaved changes</span>
                    ) : draft.updatedAt ? (
                      <span className="is-saved">Saved {formatDateTime(draft.updatedAt)}</span>
                    ) : (
                      "Not saved yet"
                    )}
                  </span>
                  <span>
                    <kbd>Ctrl</kbd> + <kbd>S</kbd> saves
                  </span>
                </div>
              </form>
            </div>
          </>
        )}
      </AsyncState>
    </main>
  );
}
