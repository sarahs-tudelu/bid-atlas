import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { apiRequest, queryString } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { useApi } from "../hooks/useApi";
import type { OutreachDraft, Project, SearchResponse } from "../types";

interface DraftResponse {
  draft: OutreachDraft;
  reused?: boolean;
}

interface HistoryResponse {
  history: OutreachDraft[];
}

function mailtoUrl(draft: OutreachDraft): string {
  return `mailto:${encodeURIComponent(draft.to)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
}

export function OutreachPage() {
  const [params, setParams] = useSearchParams();
  const projectId = params.get("project") ?? "";
  const candidatesPath = `/api/search${queryString({
    profile: "direct_northeast",
    readiness: "all",
    includeArchived: false,
    limit: 100,
  })}`;
  const candidates = useApi<SearchResponse>(candidatesPath);
  const history = useApi<HistoryResponse>("/api/outreach/history");
  const [draftState, setDraft] = useState<OutreachDraft | null>(null);
  const [failure, setFailure] = useState<{ projectId: string; message: string } | null>(null);
  const [saveStatus, setSaveStatus] = useState("");

  // Both the draft and its failure are tagged with the project they belong to, so
  // switching projects can never show the previous one's draft or error, and
  // progress is derived rather than assigned synchronously inside the effect.
  const draft = draftState?.projectId === projectId ? draftState : null;
  const draftError = failure?.projectId === projectId ? failure.message : "";
  const draftLoading = Boolean(projectId) && !draft && !draftError;

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    apiRequest<DraftResponse>("/api/outreach/generate", {
      method: "POST",
      body: JSON.stringify({ projectId }),
    })
      .then((response) => {
        if (!active) return;
        setDraft(response.draft);
        setFailure(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setFailure({
          projectId,
          message: cause instanceof Error ? cause.message : "The outreach draft could not be loaded.",
        });
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const selectedProject = useMemo(
    () => candidates.data?.projects.find((project) => project.id === projectId),
    [candidates.data, projectId],
  );

  const save = async (statusMessage = "Draft saved."): Promise<OutreachDraft | null> => {
    if (!draft) return null;
    setSaveStatus("Saving…");
    try {
      const response = await apiRequest<DraftResponse>("/api/outreach/draft", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      setDraft(response.draft);
      setSaveStatus(statusMessage);
      history.refetch();
      return response.draft;
    } catch (cause) {
      setSaveStatus(cause instanceof Error ? cause.message : "Draft could not be saved.");
      return null;
    }
  };

  const openEmailClient = async () => {
    const saved = await save("Draft saved. Your email client is opening for final review.");
    if (saved) window.location.assign(mailtoUrl(saved));
  };

  const markSent = async () => {
    if (!draft) return;
    setSaveStatus("Updating history…");
    try {
      const response = await apiRequest<DraftResponse>("/api/outreach/mark-sent", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setDraft(response.draft);
      setSaveStatus("Marked sent in this workspace.");
      history.refetch();
    } catch (cause) {
      setSaveStatus(cause instanceof Error ? cause.message : "Outreach history could not be updated.");
    }
  };

  const regenerate = async () => {
    if (!projectId) return;
    setSaveStatus("Regenerating…");
    try {
      const response = await apiRequest<DraftResponse>("/api/outreach/generate", {
        method: "POST",
        body: JSON.stringify({ projectId, regenerate: true }),
      });
      setDraft(response.draft);
      setFailure(null);
      setSaveStatus("Draft regenerated from the published project evidence.");
      history.refetch();
    } catch (cause) {
      setFailure({
        projectId,
        message: cause instanceof Error ? cause.message : "The outreach draft could not be regenerated.",
      });
    }
  };

  return (
    <main className="route-page page-width">
      <header className="route-heading outreach-heading">
        <p className="eyebrow">REVIEW-FIRST OUTREACH</p>
        <h1>Turn a qualified project into a careful introduction.</h1>
        <p>
          BidAtlas uses only contacts published with the source record. Edit every draft, open it in your own email client,
          and mark it sent only after you send it.
        </p>
      </header>

      <label className="outreach-project-picker">
        <span>Canopy opportunity</span>
        <select
          value={projectId}
          onChange={(event) => {
            const next = new URLSearchParams();
            if (event.target.value) next.set("project", event.target.value);
            setParams(next);
          }}
          disabled={candidates.loading}
        >
          <option value="">Choose a high-fit project</option>
          {candidates.data?.projects.map((project: Project) => (
            <option key={project.id} value={project.id}>
              {project.state ?? "US"} · Fit {project.canopyFit?.score ?? 0} · {project.title}
            </option>
          ))}
        </select>
      </label>

      {draftError ? <div className="error-panel" role="alert">{draftError}</div> : null}
      {draftLoading ? <div className="loading-panel" role="status">Preparing the outreach draft…</div> : null}

      {draft && !draftLoading ? (
        <section className="outreach-layout">
          <aside className="outreach-context">
            <p className="eyebrow">WHY THIS PROJECT</p>
            <h2>{draft.projectTitle}</h2>
            <p className={`fit-callout fit-${draft.canopyFit.band}`}>
              Canopy fit <strong>{draft.canopyFit.score}</strong>
            </p>
            <ul>
              {draft.canopyFit.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
            {selectedProject ? (
              <a href={selectedProject.sourceUrl} target="_blank" rel="noreferrer">Verify official source ↗</a>
            ) : null}
            <p className="field-hint">
              No message is sent by BidAtlas. Your email application remains the final review and delivery boundary.
            </p>
          </aside>

          <form className="draft-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <div className="draft-form-heading">
              <div>
                <p className="eyebrow">EDITABLE DRAFT</p>
                <h2>{draft.status === "sent" ? "Sent outreach" : "Outreach draft"}</h2>
              </div>
              <button className="link-button" type="button" onClick={() => void regenerate()}>Regenerate</button>
            </div>

            {draft.contacts.length ? (
              <label>
                <span>Published contact</span>
                <select
                  value={draft.to}
                  onChange={(event) => {
                    const contact = draft.contacts.find((item) => item.email === event.target.value);
                    setDraft({ ...draft, to: event.target.value, contactName: contact?.name ?? "" });
                  }}
                >
                  {draft.contacts.map((contact) => (
                    <option key={contact.email} value={contact.email}>
                      {contact.name || contact.role} · {contact.email}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="notice-panel">No email address was published with this record. Verify the official source before adding one.</p>
            )}

            <label>
              <span>To</span>
              <input type="email" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} placeholder="Published project contact" />
            </label>
            <label>
              <span>Subject</span>
              <input value={draft.subject} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} required maxLength={300} />
            </label>
            <label>
              <span>Message</span>
              <textarea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} required rows={11} maxLength={10000} />
            </label>

            <div className="outreach-actions">
              <button className="button button-quiet" type="submit">Save draft</button>
              <button className="button button-primary" type="button" disabled={!draft.to} onClick={() => void openEmailClient()}>
                Open in email client
              </button>
              <button className="button button-quiet" type="button" disabled={!draft.to} onClick={() => void markSent()}>
                Mark sent
              </button>
              <span aria-live="polite">{saveStatus}</span>
            </div>
          </form>
        </section>
      ) : null}

      {!projectId && !draftLoading ? (
        <div className="empty-panel">
          <h2>Choose a qualified opportunity</h2>
          <p>Start here or use “Email outreach” on any project card.</p>
          <Link className="button button-primary" to="/projects?profile=direct_northeast">Find Northeast canopy work</Link>
        </div>
      ) : null}

      <section className="outreach-history">
        <div className="section-heading">
          <div><p className="eyebrow">DEVICE WORKSPACE</p><h2>Draft and sent history</h2></div>
        </div>
        <AsyncState loading={history.loading} error={history.error} onRetry={history.refetch}>
          {history.data?.history.length ? (
            <div className="history-list">
              {history.data.history.map((item) => (
                <Link key={item.projectId} to={`/outreach?project=${encodeURIComponent(item.projectId)}`}>
                  <span className={`stage-badge ${item.status === "sent" ? "stage-bidding" : ""}`}>{item.status}</span>
                  <strong>{item.projectTitle}</strong>
                  <small>{item.to || "Recipient not selected"}</small>
                </Link>
              ))}
            </div>
          ) : <p className="evidence-empty">No outreach drafts have been saved on this device.</p>}
        </AsyncState>
      </section>
    </main>
  );
}
