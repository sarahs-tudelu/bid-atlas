import { useState, type FormEvent } from "react";

import { apiRequest } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { ListSkeleton } from "../components/Skeleton";
import { useToast } from "../components/ToastProvider";
import { useApi } from "../hooks/useApi";
import { formatDateTime } from "../lib/format";

interface Monitor {
  id: string;
  name: string;
  url: string;
  status: string;
  updatedAt: string;
}

export function SourceMonitorPage() {
  const monitors = useApi<{ monitors: Monitor[] }>("/api/source-monitors");
  const { notify } = useToast();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setStatus("");
    try {
      await apiRequest<{ monitor: Monitor }>("/api/source-monitors", {
        method: "POST",
        body: JSON.stringify({ name, url }),
      });
      setName("");
      setUrl("");
      setStatus("Added for review");
      notify(`${name} queued for source review.`);
      // Re-read the queue rather than merging locally, so the list always matches the server.
      monitors.refetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not add source";
      setStatus(message);
      notify(message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const queue = monitors.data?.monitors ?? [];

  return (
    <main className="route-page page-width">
      <header className="route-heading">
        <p className="eyebrow">Local-market discovery</p>
        <h1>Source monitor</h1>
        <p>Register public HTTPS feeds and planrooms for review before any record enters the verified bid index.</p>
      </header>

      <div className="two-column">
        <form className="panel-form" onSubmit={submit}>
          <div>
            <p className="eyebrow">Register a source</p>
            <h2>Public posting feed</h2>
          </div>
          <label>
            <span>Source name</span>
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Regional builders exchange"
            />
          </label>
          <label>
            <span>Public HTTPS URL</span>
            <input
              required
              type="url"
              pattern="https://.*"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.gov/bids"
            />
          </label>
          <span className="field-hint">Only HTTPS addresses are accepted. Nothing is indexed until review clears it.</span>
          <button className="button button-primary" type="submit" disabled={submitting}>
            {submitting ? "Adding…" : "Add for review"}
          </button>
          <span role="status">{status}</span>
        </form>

        <section>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Workspace sources</p>
              <h2>Review queue</h2>
            </div>
          </div>
          <AsyncState
            loading={monitors.loading}
            error={monitors.error}
            onRetry={monitors.refetch}
            skeleton={<ListSkeleton count={3} height={104} />}
          >
            {queue.length ? (
              <div className="monitor-list">
                {queue.map((monitor) => (
                  <article key={monitor.id}>
                    <span className="stage-badge">{monitor.status}</span>
                    <h3>{monitor.name}</h3>
                    <a href={monitor.url} target="_blank" rel="noreferrer">
                      {monitor.url}
                    </a>
                    {monitor.updatedAt && <time dateTime={monitor.updatedAt}>Added {formatDateTime(monitor.updatedAt)}</time>}
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-panel">
                <h3>No sources registered</h3>
                <p>Add a public source to begin its review trail.</p>
              </div>
            )}
          </AsyncState>
        </section>
      </div>
    </main>
  );
}
