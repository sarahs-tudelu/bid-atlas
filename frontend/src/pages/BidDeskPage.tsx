import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { apiRequest } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { useApi } from "../hooks/useApi";
import type { Project } from "../types";

interface Draft {
  projectId: string;
  scope: string;
  exclusions: string;
  notes: string;
  updatedAt?: string;
}

const emptyDraft = (projectId: string): Draft => ({ projectId, scope: "", exclusions: "", notes: "" });

export function BidDeskPage() {
  const [params] = useSearchParams();
  const projectId = params.get("project") ?? "";
  const projectState = useApi<Project>(projectId ? `/api/projects/${encodeURIComponent(projectId)}` : "/api/projects/__none__");
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(projectId));
  const [saveStatus, setSaveStatus] = useState("");

  useEffect(() => {
    if (!projectId) return;
    apiRequest<{ draft: Draft | null }>(`/api/bid-drafts?projectId=${encodeURIComponent(projectId)}`)
      .then((response) => setDraft(response.draft ?? emptyDraft(projectId)))
      .catch(() => setDraft(emptyDraft(projectId)));
  }, [projectId]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaveStatus("Saving…");
    try {
      const response = await apiRequest<{ draft: Draft }>("/api/bid-drafts", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setDraft(response.draft);
      setSaveStatus("Saved");
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "Save failed");
    }
  };

  if (!projectId) {
    return (
      <main className="route-page page-width">
        <header className="route-heading"><p className="eyebrow">CONTROLLED ESTIMATING</p><h1>Bid desk</h1><p>Choose an opportunity to build a source-backed scope and internal bid package.</p></header>
        <div className="empty-panel"><h2>No project selected</h2><p>Open an opportunity first, then bring it into the bid desk.</p><Link className="button button-primary" to="/projects">Browse open bids</Link></div>
      </main>
    );
  }

  return (
    <main className="route-page page-width">
      <AsyncState loading={projectState.loading} error={projectState.error}>
        {projectState.data && (
          <>
            <header className="route-heading bid-desk-heading">
              <p className="eyebrow">BID DESK · {projectState.data.sourceRecordId}</p>
              <h1>{projectState.data.title}</h1>
              <p>{projectState.data.summary}</p>
              <div className="hero-actions"><a className="button button-primary" href={projectState.data.sourceUrl} target="_blank" rel="noreferrer">Verify official record ↗</a><Link className="button button-quiet" to="/projects">Back to bids</Link></div>
            </header>
            <div className="bid-desk-layout">
              <aside className="evidence-panel">
                <p className="eyebrow">PUBLISHED EVIDENCE</p>
                <h2>Project record</h2>
                <dl>
                  <div><dt>Agency</dt><dd>{projectState.data.agency || "Not published"}</dd></div>
                  <div><dt>Location</dt><dd>{[projectState.data.address, projectState.data.city, projectState.data.state].filter(Boolean).join(" · ") || "Not published"}</dd></div>
                  <div><dt>Bid deadline</dt><dd>{projectState.data.bidDate ? new Date(projectState.data.bidDate).toLocaleString() : "Not published"}</dd></div>
                </dl>
                <h3>Documents</h3>
                <ul>{projectState.data.documents?.map((document) => <li key={document.url}><a href={document.url} target="_blank" rel="noreferrer">{document.name} ↗</a></li>)}</ul>
                <h3>Published contacts</h3>
                <ul>{projectState.data.participants?.map((participant, index) => <li key={`${participant.name}:${index}`}><strong>{participant.name || participant.organization || "Unnamed contact"}</strong><span>{participant.role}</span></li>)}</ul>
              </aside>
              <form className="draft-form" onSubmit={save}>
                <div><p className="eyebrow">INTERNAL WORKSPACE</p><h2>Scope and review notes</h2></div>
                <label><span>Proposed scope</span><textarea value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value })} rows={7} placeholder="Describe the included work…" /></label>
                <label><span>Exclusions</span><textarea value={draft.exclusions} onChange={(event) => setDraft({ ...draft, exclusions: event.target.value })} rows={5} placeholder="List explicit exclusions…" /></label>
                <label><span>Estimator notes</span><textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} rows={6} placeholder="Questions, addenda, and follow-ups…" /></label>
                <div className="save-row"><button className="button button-primary" type="submit">Save draft</button><span role="status">{saveStatus || (draft.updatedAt ? `Saved ${new Date(draft.updatedAt).toLocaleString()}` : "Not saved yet")}</span></div>
              </form>
            </div>
          </>
        )}
      </AsyncState>
    </main>
  );
}
