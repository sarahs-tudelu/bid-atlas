import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { apiRequest, queryString } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../hooks/useAuth";
import { emailContacts } from "../lib/contacts";
import type { OutreachDraft, Project, SearchResponse } from "../types";

interface DraftResponse {
  draft: OutreachDraft;
  reused?: boolean;
}

interface HistoryResponse {
  history: OutreachDraft[];
}

export function OutreachPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const projectId = params.get("project") ?? "";
  const candidates = useApi<SearchResponse>(`/api/search${queryString({
    profile: "direct_northeast",
    readiness: "all",
    includeArchived: false,
    limit: 100,
  })}`);
  const history = useApi<HistoryResponse>("/api/outreach/history");
  const refetchHistory = history.refetch;
  const [draftState, setDraft] = useState<OutreachDraft | null>(null);
  const [failure, setFailure] = useState<{ projectId: string; message: string } | null>(null);
  const [saveStatus, setSaveStatus] = useState("");

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
        refetchHistory();
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
  }, [projectId, refetchHistory]);

  const selectedProject = useMemo(
    () => candidates.data?.projects.find((project) => project.id === projectId),
    [candidates.data, projectId],
  );
  const emailCandidates = useMemo(
    () => candidates.data?.projects.filter((project) => emailContacts(project).length > 0) ?? [],
    [candidates.data],
  );

  const save = async (): Promise<void> => {
    if (!draft || draft.status === "sent") return;
    setSaveStatus("Saving…");
    try {
      const response = await apiRequest<DraftResponse>("/api/outreach/draft", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      setDraft(response.draft);
      setSaveStatus("Draft saved to your Tudelu workspace.");
      history.refetch();
    } catch (cause) {
      setSaveStatus(cause instanceof Error ? cause.message : "Draft could not be saved.");
    }
  };

  const send = async (): Promise<void> => {
    if (!draft || draft.status === "sent") return;
    if (!window.confirm(`Send this message from ${user?.email} to ${draft.to}?`)) return;
    setSaveStatus("Sending through Gmail…");
    try {
      const response = await apiRequest<DraftResponse>("/api/outreach/send", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setDraft(response.draft);
      setSaveStatus("Sent from your Tudelu Gmail account and logged in outreach history.");
      history.refetch();
    } catch (cause) {
      setSaveStatus(cause instanceof Error ? cause.message : "Gmail could not send this message.");
    }
  };

  const refreshGmailHistory = async (): Promise<void> => {
    if (!projectId) return;
    setSaveStatus("Refreshing Gmail history…");
    try {
      const response = await apiRequest<DraftResponse>("/api/outreach/gmail-history", {
        method: "POST",
        body: JSON.stringify({ projectId }),
      });
      setDraft(response.draft);
      setSaveStatus("Gmail history refreshed.");
    } catch (cause) {
      setSaveStatus(cause instanceof Error ? cause.message : "Gmail history could not be refreshed.");
    }
  };

  const personalize = async (): Promise<void> => {
    if (!projectId || draft?.status === "sent") return;
    setSaveStatus("Personalizing with Claude…");
    try {
      const response = await apiRequest<DraftResponse>("/api/outreach/generate", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          regenerate: true,
          personalize: true,
          to: draft?.to ?? "",
        }),
      });
      setDraft(response.draft);
      setFailure(null);
      setSaveStatus("AI personalization applied. Review the draft before sending.");
      history.refetch();
    } catch (cause) {
      setSaveStatus(cause instanceof Error ? cause.message : "The draft could not be personalized.");
    }
  };

  return (
    <main className="route-page page-width">
      <header className="route-heading outreach-heading">
        <p className="eyebrow">GMAIL-CONNECTED OUTREACH</p>
        <h1>Review contact history, then send from your Tudelu mailbox.</h1>
        <p>
          Start with a signed Tudelu template, then optionally personalize it with Claude using source evidence and prior contact snippets. Every message requires your review and confirmation.
        </p>
      </header>

      <label className="outreach-project-picker">
        <span>Contactable canopy opportunity</span>
        <select
          value={projectId}
          onChange={(event) => {
            const next = new URLSearchParams();
            if (event.target.value) next.set("project", event.target.value);
            setParams(next);
          }}
          disabled={candidates.loading}
        >
          <option value="">Choose a qualified project</option>
          {emailCandidates.map((project: Project) => (
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
            <ul>{draft.canopyFit.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            {selectedProject ? <a href={selectedProject.sourceUrl} target="_blank" rel="noreferrer">Verify official source ↗</a> : null}
            <p className="field-hint">Sender: <strong>{user?.email}</strong></p>
          </aside>

          <div className="outreach-workspace">
            <form className="draft-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <div className="draft-form-heading">
                <div><p className="eyebrow">REVIEWED DRAFT</p><h2>{draft.status === "sent" ? "Sent outreach" : "Outreach draft"}</h2></div>
                <button className="link-button" type="button" disabled={draft.status === "sent"} onClick={() => void personalize()}>
                  {draft.generation?.provider === "anthropic" ? "Re-personalize with AI" : "Personalize with AI"}
                </button>
              </div>
              {draft.generation?.provider === "anthropic" ? (
                <p className="field-hint">AI-generated with {draft.generation.model}. Review the source facts, recipient, and message before sending.</p>
              ) : <p className="field-hint">Signed Tudelu template. AI personalization is optional.</p>}

              <label>
                <span>Published contact</span>
                <select
                  value={draft.to}
                  disabled={draft.status === "sent"}
                  onChange={(event) => {
                    const contact = draft.contacts.find((item) => item.email === event.target.value);
                    setDraft({ ...draft, to: event.target.value, contactName: contact?.name ?? "" });
                  }}
                >
                  {draft.contacts.map((contact) => (
                    <option key={contact.email} value={contact.email}>{contact.name || contact.role} · {contact.email}</option>
                  ))}
                </select>
              </label>
              <label><span>Subject</span><input value={draft.subject} disabled={draft.status === "sent"} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} required maxLength={300} /></label>
              <label><span>Message</span><textarea value={draft.body} disabled={draft.status === "sent"} onChange={(event) => setDraft({ ...draft, body: event.target.value })} required rows={11} maxLength={10000} /></label>

              <div className="outreach-actions">
                <button className="button button-quiet" type="submit" disabled={draft.status === "sent"}>Save draft</button>
                <button className="button button-primary" type="button" disabled={!draft.to || draft.status === "sent"} onClick={() => void send()}>
                  Send with Gmail
                </button>
                <span aria-live="polite">{saveStatus}</span>
              </div>
            </form>

            <section className="gmail-history-panel">
              <div className="draft-form-heading">
                <div><p className="eyebrow">GMAIL CONTEXT</p><h2>Prior contact</h2></div>
                <button className="link-button" type="button" onClick={() => void refreshGmailHistory()}>Refresh</button>
              </div>
              {draft.emailHistory?.length ? draft.emailHistory.map((thread) => (
                <article className="gmail-thread" key={thread.threadId}>
                  {thread.messages.map((message) => (
                    <div key={message.id}>
                      <strong>{message.subject || "(No subject)"}</strong>
                      <small>{message.from} → {message.to} · {message.date}</small>
                      <p>{message.snippet}</p>
                    </div>
                  ))}
                </article>
              )) : <p className="evidence-empty">No prior messages with the published project contacts were found.</p>}
              <small>Only headers and short Gmail snippets are retained with the draft; full inbox bodies are not stored.</small>
            </section>
          </div>
        </section>
      ) : null}

      {!projectId && !draftLoading ? (
        <div className="empty-panel">
          <h2>Choose a contactable canopy opportunity</h2>
          <p>Every visible project has a published email or phone number and meets the Canopy fit threshold.</p>
          <Link className="button button-primary" to="/projects?profile=direct_northeast">Find Northeast canopy work</Link>
        </div>
      ) : null}

      <section className="outreach-history">
        <div className="section-heading"><div><p className="eyebrow">TUDELU WORKSPACE</p><h2>Draft and sent history</h2></div></div>
        <AsyncState loading={history.loading} error={history.error} onRetry={history.refetch}>
          {history.data?.history.length ? (
            <div className="history-list">
              {history.data.history.map((item) => (
                <Link key={item.projectId} to={`/outreach?project=${encodeURIComponent(item.projectId)}`}>
                  <span className={`stage-badge ${item.status === "sent" ? "stage-bidding" : ""}`}>{item.status}</span>
                  <strong>{item.projectTitle}</strong>
                  <small>{item.to} {item.sentBy ? `· ${item.sentBy}` : ""}</small>
                </Link>
              ))}
            </div>
          ) : <p className="evidence-empty">No outreach drafts have been saved for this Tudelu account.</p>}
        </AsyncState>
      </section>
    </main>
  );
}
