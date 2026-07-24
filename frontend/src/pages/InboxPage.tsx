import { useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { apiRequest, queryString } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { useApi } from "../hooks/useApi";
import { formatDateTime } from "../lib/format";
import { projectWorkspaceHref } from "../lib/projectNavigation";
import type { CorrespondenceMessage, InboxResponse } from "../types";

const MATCH_EXPLANATIONS: Record<CorrespondenceMessage["matchedBy"], string> = {
  "gmail-thread": "Filed by an existing project Gmail thread",
  "project-reference": "Filed by the project or solicitation reference",
  "published-contact": "Filed by a unique published project contact",
  "contact-and-title": "Filed by contact and project-title evidence",
  "sent-from-project": "Logged when sent from this project",
  manual: "Assigned to this project by a team member",
  "needs-review": "More than one project may match",
};

function formatBytes(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} KB`;
  return `${value} B`;
}

export function InboxPage() {
  const [params, setParams] = useSearchParams();
  const projectId = params.get("project") ?? "";
  const requestedStatus = params.get("status") ?? "all";
  const status = ["all", "assigned", "unassigned"].includes(requestedStatus) ? requestedStatus : "all";
  const requestedPage = Number(params.get("page") ?? "1");
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const query = params.get("q") ?? "";
  const [search, setSearch] = useState(query);
  const [syncing, setSyncing] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [assignments, setAssignments] = useState<Record<string, string>>({});

  const path = `/api/inbox${queryString({
    projectId,
    status,
    q: query,
    page,
    limit: 25,
  })}`;
  const inbox = useApi<InboxResponse>(path);
  const activeProject = inbox.data?.projects.find((project) => project.id === projectId);

  const visibleProjects = useMemo(
    () => inbox.data?.projects.filter((project) => project.messageCount > 0) ?? [],
    [inbox.data],
  );

  const changeFilters = (updates: Record<string, string>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(updates)) {
      if (value && value !== "all") next.set(key, value);
      else next.delete(key);
    }
    if (!Object.hasOwn(updates, "page")) next.delete("page");
    setParams(next);
  };

  const sync = async (): Promise<void> => {
    setSyncing(true);
    setActionMessage("Checking project-related Gmail threads and contacts…");
    try {
      const result = await apiRequest<{ sync: InboxResponse["meta"]["sync"] }>("/api/inbox/sync", {
        method: "POST",
      });
      setActionMessage(
        `Sync complete: ${result.sync?.messagesStored ?? 0} messages checked and ${result.sync?.filedAttachments ?? 0} attachments filed.`,
      );
      inbox.refetch();
    } catch (cause) {
      setActionMessage(cause instanceof Error ? cause.message : "Gmail sync could not be completed.");
    } finally {
      setSyncing(false);
    }
  };

  const assign = async (message: CorrespondenceMessage): Promise<void> => {
    const project = assignments[message.messageId] || message.candidateProjectIds[0] || "";
    if (!project) {
      setActionMessage("Choose a project before assigning this message.");
      return;
    }
    setActionMessage("Filing correspondence under the selected project…");
    try {
      await apiRequest(`/api/inbox/messages/${encodeURIComponent(message.messageId)}/project`, {
        method: "PUT",
        body: JSON.stringify({ projectId: project }),
      });
      setActionMessage("Correspondence filed under the project.");
      inbox.refetch();
    } catch (cause) {
      setActionMessage(cause instanceof Error ? cause.message : "The message could not be assigned.");
    }
  };

  const submitSearch = (event: FormEvent): void => {
    event.preventDefault();
    changeFilters({ q: search.trim() });
  };

  return (
    <main className="route-page page-width">
      <header className="route-heading inbox-heading">
        <p className="eyebrow">CONNECTED GMAIL · PROJECT FILES</p>
        <h1>Project correspondence inbox</h1>
        <p>
          Sent and received messages are organized by project. Attachments from published GC, architect,
          and agency contacts are privately filed with the matching project.
        </p>
        <div className="hero-actions">
          <button className="button button-primary" type="button" disabled={syncing} onClick={() => void sync()}>
            {syncing ? "Syncing Gmail…" : "Sync Gmail now"}
          </button>
          <Link className="button button-quiet" to="/outreach">Create outreach</Link>
        </div>
        <p className="inbox-action-status" role="status">{actionMessage}</p>
      </header>

      <AsyncState loading={inbox.loading} error={inbox.error} onRetry={inbox.refetch}>
        {inbox.data ? (
          <>
            {!inbox.data.meta.gmailConnected || !inbox.data.meta.gmailReadAccess ? (
              <section className="inbox-connect-panel">
                <div>
                  <p className="eyebrow">GMAIL PERMISSION NEEDED</p>
                  <h2>Reconnect your Tudelu Google account</h2>
                  <p>Read-only Gmail access is required to find project replies and file their attachments.</p>
                </div>
                <a className="button button-primary" href="/api/auth/google/start?next=%2Finbox">Reconnect Google</a>
              </section>
            ) : null}

            <section className="inbox-metrics" aria-label="Inbox totals">
              <div><strong>{inbox.data.meta.allMessages}</strong><span>Project messages</span></div>
              <div><strong>{inbox.data.meta.assignedMessages}</strong><span>Filed to projects</span></div>
              <div><strong>{inbox.data.meta.unassignedMessages}</strong><span>Need assignment</span></div>
              <div>
                <strong>{inbox.data.meta.sync?.filedAttachments ?? 0}</strong>
                <span>Files in latest sync</span>
              </div>
            </section>

            <div className="inbox-layout">
              <aside className="inbox-folders">
                <div>
                  <p className="eyebrow">PROJECT FOLDERS</p>
                  <h2>Correspondence</h2>
                </div>
                <button
                  className={!projectId && status === "all" ? "active" : ""}
                  type="button"
                  onClick={() => changeFilters({ project: "", status: "all" })}
                >
                  <span>All project mail</span><strong>{inbox.data.meta.allMessages}</strong>
                </button>
                <button
                  className={status === "unassigned" ? "active" : ""}
                  type="button"
                  onClick={() => changeFilters({ project: "", status: "unassigned" })}
                >
                  <span>Needs assignment</span><strong>{inbox.data.meta.unassignedMessages}</strong>
                </button>
                {visibleProjects.map((project) => (
                  <button
                    className={projectId === project.id ? "active" : ""}
                    key={project.id}
                    type="button"
                    onClick={() => changeFilters({ project: project.id, status: "all" })}
                    title={project.title}
                  >
                    <span>
                      <small>{project.sourceRecordId}</small>
                      {project.title}
                    </span>
                    <strong>{project.messageCount}</strong>
                  </button>
                ))}
              </aside>

              <section className="inbox-content">
                <div className="inbox-toolbar">
                  <div>
                    <p className="eyebrow">{activeProject ? activeProject.sourceRecordId : status === "unassigned" ? "REVIEW QUEUE" : "ALL PROJECTS"}</p>
                    <h2>{activeProject?.title ?? (status === "unassigned" ? "Needs assignment" : "Correspondence")}</h2>
                  </div>
                  <form onSubmit={submitSearch}>
                    <label className="sr-only" htmlFor="inbox-search">Search correspondence</label>
                    <input
                      id="inbox-search"
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search subject, contact, or project"
                    />
                    <button className="button button-quiet" type="submit">Search</button>
                  </form>
                </div>

                {inbox.data.messages.length ? (
                  <div className="correspondence-list">
                    {inbox.data.messages.map((message) => (
                      <article className="correspondence-row" key={message.messageId}>
                        <div className="correspondence-meta">
                          <span className={`direction-badge direction-${message.direction}`}>{message.direction}</span>
                          <time dateTime={message.occurredAt}>{formatDateTime(message.occurredAt)}</time>
                        </div>
                        <div className="correspondence-main">
                          <h3>{message.subject || "(No subject)"}</h3>
                          <p className="correspondence-address">
                            {message.direction === "received" ? message.from : `To ${message.to}`}
                          </p>
                          <p>{message.snippet || "No Gmail preview was available."}</p>
                          {message.attachments.length ? (
                            <ul className="correspondence-files">
                              {message.attachments.map((attachment) => (
                                <li key={`${message.messageId}:${attachment.downloadUrl}`}>
                                  <a href={attachment.downloadUrl}>
                                    <span>{attachment.name}</span>
                                    <small>{formatBytes(attachment.size)}</small>
                                  </a>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {message.attachmentWarnings.map((warning) => (
                            <small className="attachment-warning" key={warning}>{warning}</small>
                          ))}
                        </div>
                        <div className="correspondence-project">
                          {message.projectId ? (
                            <>
                              <Link to={projectWorkspaceHref(
                                message.projectId,
                                `/inbox?project=${encodeURIComponent(message.projectId)}`,
                              )}>
                                <small>{message.sourceRecordId}</small>
                                <strong>{message.projectTitle}</strong>
                              </Link>
                              <span title={MATCH_EXPLANATIONS[message.matchedBy]}>
                                {MATCH_EXPLANATIONS[message.matchedBy]}
                              </span>
                            </>
                          ) : (
                            <div className="correspondence-assign">
                              <strong>Choose project</strong>
                              <select
                                aria-label={`Project for ${message.subject}`}
                                value={assignments[message.messageId] || message.candidateProjectIds[0] || ""}
                                onChange={(event) => setAssignments({
                                  ...assignments,
                                  [message.messageId]: event.target.value,
                                })}
                              >
                                <option value="">Select a project</option>
                                {inbox.data!.projects.map((project) => (
                                  <option key={project.id} value={project.id}>
                                    {project.sourceRecordId} · {project.title}
                                  </option>
                                ))}
                              </select>
                              <button className="button button-quiet" type="button" onClick={() => void assign(message)}>
                                File message
                              </button>
                            </div>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="empty-panel">
                    <h2>No correspondence in this view</h2>
                    <p>Sync Gmail or choose another project folder. Only project-related contacts and threads are indexed.</p>
                  </div>
                )}

                {inbox.data.meta.totalPages > 1 ? (
                  <nav className="pagination" aria-label="Correspondence pages">
                    <button
                      type="button"
                      disabled={inbox.data.meta.page <= 1}
                      onClick={() => changeFilters({ page: String(inbox.data!.meta.page - 1) })}
                    >
                      Previous
                    </button>
                    <span>Page {inbox.data.meta.page} of {inbox.data.meta.totalPages}</span>
                    <button
                      type="button"
                      disabled={inbox.data.meta.page >= inbox.data.meta.totalPages}
                      onClick={() => changeFilters({ page: String(inbox.data!.meta.page + 1) })}
                    >
                      Next
                    </button>
                  </nav>
                ) : null}
              </section>
            </div>

            <p className="inbox-privacy-note">
              BidAtlas checks only known project contacts, tracked Gmail threads, and project references. It stores
              headers, a short Gmail preview, matching evidence, and matched attachments—not a copy of the full mailbox.
              {inbox.data.meta.sync?.lastSuccessfulSync
                ? ` Last synced ${formatDateTime(inbox.data.meta.sync.lastSuccessfulSync)}.`
                : ""}
            </p>
          </>
        ) : null}
      </AsyncState>
    </main>
  );
}
