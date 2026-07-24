import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { apiRequest, queryString } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../hooks/useAuth";
import { emailContacts } from "../lib/contacts";
import type {
  OutreachConfig,
  OutreachDraft,
  PartnerDirectoryResponse,
  PartnerOrganization,
  Project,
  SearchResponse,
} from "../types";

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
    profile: "direct_national",
    readiness: "all",
    includeArchived: false,
    limit: 100,
  })}`);
  const prospects = useApi<PartnerDirectoryResponse>(`/api/partner-directory${queryString({
    limit: 100,
  })}`);
  const history = useApi<HistoryResponse>("/api/outreach/history");
  const outreachConfig = useApi<OutreachConfig>("/api/outreach/config");
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
  const selectedProspect = useMemo(() => {
    if (!projectId.startsWith("prospect:")) return undefined;
    const organizationId = projectId.slice("prospect:".length);
    return prospects.data?.organizations.find((organization) => organization.id === organizationId);
  }, [projectId, prospects.data]);
  const emailCandidates = useMemo(
    () => candidates.data?.projects.filter((project) => emailContacts(project).length > 0) ?? [],
    [candidates.data],
  );
  const emailProspects = useMemo(
    () => prospects.data?.organizations.filter((organization) => Boolean(organization.email)) ?? [],
    [prospects.data],
  );
  const sourceUrl = draft?.sourceUrl || selectedProject?.sourceUrl || selectedProspect?.sourceUrl;

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
    const priorContactWarning = draft.priorContactCount
      ? ` Team history contains ${draft.priorContactCount} prior message${draft.priorContactCount === 1 ? "" : "s"} involving this project owner, logged by ${draft.priorContactedBy?.join(", ") || "another Tudelu employee"}.`
      : "";
    if (!window.confirm(`Send this message from ${draft.senderEmail} to ${draft.to}?${priorContactWarning}`)) return;
    setSaveStatus(draft.senderMode === "marketing" ? "Sending through the marketing mailbox…" : "Sending through Gmail…");
    try {
      const response = await apiRequest<DraftResponse>("/api/outreach/send", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setDraft(response.draft);
      setSaveStatus(
        draft.senderMode === "marketing"
          ? `Sent from ${response.draft.senderEmail}; responses will be forwarded to ${response.draft.replyOwnerEmail}.`
          : "Sent from your Tudelu Gmail account and logged in outreach history.",
      );
      history.refetch();
    } catch (cause) {
      setSaveStatus(cause instanceof Error ? cause.message : "The email provider could not send this message.");
    }
  };

  const refreshGmailHistory = async (): Promise<void> => {
    if (!projectId) return;
    setSaveStatus("Refreshing contact history…");
    try {
      const response = await apiRequest<DraftResponse>("/api/outreach/gmail-history", {
        method: "POST",
        body: JSON.stringify({ projectId }),
      });
      setDraft(response.draft);
      setSaveStatus("Contact history refreshed.");
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
          senderMode: draft?.senderMode ?? "marketing",
          marketingSenderEmail: draft?.marketingSenderEmail ?? draft?.senderEmail ?? "",
          replyOwnerEmail: draft?.replyOwnerEmail ?? "",
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

  const changeSender = async (
    senderMode: "marketing" | "employee",
    marketingSenderEmail = "",
  ): Promise<void> => {
    if (
      !projectId
      || draft?.status === "sent"
      || (
        senderMode === draft?.senderMode
        && (
          senderMode === "employee"
          || marketingSenderEmail === (draft?.marketingSenderEmail ?? draft?.senderEmail)
        )
      )
    ) return;
    setSaveStatus("Updating sender identity…");
    try {
      const response = await apiRequest<DraftResponse>("/api/outreach/generate", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          regenerate: true,
          senderMode,
          marketingSenderEmail,
          to: draft?.to ?? "",
          replyOwnerEmail: draft?.replyOwnerEmail ?? outreachConfig.data?.defaultReplyOwnerEmail ?? "",
        }),
      });
      setDraft(response.draft);
      setSaveStatus(`Sender changed to ${response.draft.senderEmail}. Review the regenerated draft.`);
      history.refetch();
    } catch (cause) {
      setSaveStatus(cause instanceof Error ? cause.message : "The sender could not be changed.");
    }
  };

  return (
    <main className="route-page page-width">
      <header className="route-heading outreach-heading">
        <p className="eyebrow">MARKETING + GMAIL OUTREACH</p>
        <h1>Choose the right Tudelu sender for each reviewed message.</h1>
        <p>
          Select any authorized marketing mailbox and route responses to the responsible sales owner, or send from your own connected Gmail account. Every message still requires review and confirmation.
        </p>
      </header>

      <label className="outreach-project-picker">
        <span>Contactable bid or research prospect</span>
        <select
          value={projectId}
          onChange={(event) => {
            const next = new URLSearchParams();
            if (event.target.value) next.set("project", event.target.value);
            setParams(next);
          }}
          disabled={candidates.loading || prospects.loading}
        >
          <option value="">Choose a bid or prospect</option>
          <optgroup label="Qualified bids">
            {emailCandidates.map((project: Project) => (
              <option key={project.id} value={project.id}>
                {project.state ?? "US"} · Fit {project.canopyFit?.score ?? 0} · {project.title}
              </option>
            ))}
          </optgroup>
          <optgroup label="Research prospects">
            {emailProspects.map((organization: PartnerOrganization) => (
              <option key={organization.id} value={`prospect:${organization.id}`}>
                {organization.priorityRank ? `Priority ${organization.priorityRank} · ` : ""}
                {organization.state} · {organization.name}
              </option>
            ))}
          </optgroup>
        </select>
      </label>

      {draftError ? <div className="error-panel" role="alert">{draftError}</div> : null}
      {draftLoading ? <div className="loading-panel" role="status">Preparing the outreach draft…</div> : null}

      {draft && !draftLoading ? (
        <section className="outreach-layout">
          <aside className="outreach-context">
            <p className="eyebrow">
              {draft.recordType === "prospect" ? "WHY THIS PROSPECT" : "WHY THIS PROJECT"}
            </p>
            <h2>{draft.projectTitle}</h2>
            {draft.recordType === "prospect" ? (
              <>
                <p className="fit-callout prospect-fit-callout">
                  {draft.prospectPriorityRank ? `Research priority #${draft.prospectPriorityRank}` : "Research-qualified"}
                </p>
                <div className="partner-scope-list" aria-label="Relevant product scopes">
                  {(draft.productTypes ?? []).map((product) => (
                    <span key={product}>
                      {product === "partition-walls" ? "Partition walls" : product[0].toUpperCase() + product.slice(1)}
                    </span>
                  ))}
                </div>
                <ul>
                  {(draft.prospectFitReasons ?? []).map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
              </>
            ) : (
              <>
                <p className={`fit-callout fit-${draft.canopyFit.band}`}>
                  Product fit <strong>{draft.canopyFit.score}</strong>
                </p>
                <ul>{draft.canopyFit.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              </>
            )}
            {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">Verify published source ↗</a> : null}
            <p className="field-hint">Sender: <strong>{draft.senderEmail}</strong></p>
            <p className="field-hint">Reply owner: <strong>{draft.replyOwnerEmail}</strong></p>
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
                <span>Send from</span>
                <select
                  value={
                    draft.senderMode === "employee"
                      ? "employee"
                      : `marketing:${draft.marketingSenderEmail ?? draft.senderEmail}`
                  }
                  disabled={draft.status === "sent"}
                  onChange={(event) => {
                    if (event.target.value === "employee") {
                      void changeSender("employee");
                      return;
                    }
                    void changeSender("marketing", event.target.value.slice("marketing:".length));
                  }}
                >
                  {(outreachConfig.data?.marketingAccounts ?? [{
                    email: outreachConfig.data?.marketing.email ?? draft.senderEmail,
                    name: outreachConfig.data?.marketing.name ?? "Tudelu marketing",
                    status: "configured",
                    statusCode: 0,
                    warmupStatus: 0,
                    providerCode: 0,
                    setupPending: false,
                  }]).map((account) => (
                    <option key={account.email} value={`marketing:${account.email}`}>
                      {account.name} · {account.email}{account.status === "active" || account.status === "configured" ? "" : ` · ${account.status}`}
                    </option>
                  ))}
                  <option value="employee">My Tudelu Gmail · {user?.email}</option>
                </select>
                {outreachConfig.data?.marketingAccountsWarning ? (
                  <small className="field-hint">{outreachConfig.data.marketingAccountsWarning}</small>
                ) : null}
              </label>
              {draft.senderMode === "marketing" ? (
                <label>
                  <span>Route responses to</span>
                  <select
                    value={draft.replyOwnerEmail}
                    disabled={draft.status === "sent"}
                    onChange={(event) => {
                      const owner = outreachConfig.data?.salesReplyOwners.find((item) => item.email === event.target.value);
                      setDraft({
                        ...draft,
                        replyOwnerEmail: event.target.value,
                        replyOwnerName: owner?.name ?? event.target.value,
                      });
                    }}
                  >
                    {(outreachConfig.data?.salesReplyOwners ?? []).map((owner) => (
                      <option key={owner.email} value={owner.email}>{owner.name} · {owner.email}</option>
                    ))}
                  </select>
                </label>
              ) : null}

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
                  {draft.senderMode === "marketing" ? "Send from marketing" : "Send with my Gmail"}
                </button>
                <span aria-live="polite">{saveStatus}</span>
              </div>
            </form>

            <section className="gmail-history-panel">
              <div className="draft-form-heading">
                <div><p className="eyebrow">TUDELU TEAM CONTACT CONTEXT</p><h2>Prior contact</h2></div>
                <button className="link-button" type="button" onClick={() => void refreshGmailHistory()}>Refresh</button>
              </div>
              {draft.priorContactCount ? (
                <div className="team-contact-alert" role="status">
                  <strong>
                    {draft.priorContactCount} prior team message{draft.priorContactCount === 1 ? "" : "s"} found
                  </strong>
                  <span>
                    Contacted by {draft.priorContactedBy?.join(", ") || "a Tudelu employee"}
                    {draft.lastPriorContactAt ? ` · Latest ${draft.lastPriorContactAt}` : ""}
                  </span>
                </div>
              ) : null}
              {draft.emailHistory?.length ? draft.emailHistory.map((thread) => (
                <article className="gmail-thread" key={thread.threadId}>
                  {thread.messages.map((message) => (
                    <div key={message.id}>
                      <strong>{message.subject || "(No subject)"}</strong>
                      <small>
                        {message.from} → {message.to} · {message.date}
                        {message.sentBy ? ` · Logged by ${message.sentBy}` : ""}
                      </small>
                      <p>{message.snippet}</p>
                    </div>
                  ))}
                </article>
              )) : <p className="evidence-empty">No prior messages from any connected Tudelu employee were found.</p>}
              <small>Team history checks sent outreach and project correspondence across connected Tudelu accounts. Only headers and short snippets are retained; full inbox bodies are not stored.</small>
            </section>
          </div>
        </section>
      ) : null}

      {!projectId && !draftLoading ? (
        <div className="empty-panel">
          <h2>Choose a contactable bid or research prospect</h2>
          <p>Bid contacts come from public project records. Prospect contacts come from the source-backed tri-state research directory.</p>
          <div className="hero-actions">
            <Link className="button button-primary" to="/projects?profile=direct_national">Find nationwide product work</Link>
            <Link className="button button-quiet" to="/companies?view=directory">Browse tri-state prospects</Link>
          </div>
        </div>
      ) : null}

      <section className="outreach-history">
        <div className="section-heading"><div><p className="eyebrow">TUDELU TEAM WORKSPACE</p><h2>Draft and sent history</h2></div></div>
        <AsyncState loading={history.loading} error={history.error} onRetry={history.refetch}>
          {history.data?.history.length ? (
            <div className="history-list">
              {history.data.history.map((item) => (
                <Link
                  key={`${item.workspaceOwner ?? item.sentBy ?? ""}:${item.projectId}:${item.sentAt ?? item.updatedAt ?? ""}`}
                  to={`/outreach?project=${encodeURIComponent(item.projectId)}`}
                >
                  <span className={`stage-badge ${item.status === "sent" ? "stage-bidding" : ""}`}>{item.status}</span>
                  <strong>{item.projectTitle}</strong>
                  <small>{item.to} {item.sentBy ? `· ${item.sentBy}` : ""}</small>
                </Link>
              ))}
            </div>
          ) : <p className="evidence-empty">No outreach drafts or team sends have been logged.</p>}
        </AsyncState>
      </section>
    </main>
  );
}
