import { useState, type FormEvent } from "react";

import { apiRequest } from "../api/client";
import { AsyncState } from "../components/AsyncState";
import { useApi } from "../hooks/useApi";

interface Monitor {
  id: string;
  name: string;
  url: string;
  status: string;
  updatedAt: string;
}

export function SourceMonitorPage() {
  const monitors = useApi<{ monitors: Monitor[] }>("/api/source-monitors");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [created, setCreated] = useState<Monitor[]>([]);
  const [status, setStatus] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("Adding…");
    try {
      const response = await apiRequest<{ monitor: Monitor }>("/api/source-monitors", {
        method: "POST",
        body: JSON.stringify({ name, url }),
      });
      setCreated((current) => [response.monitor, ...current]);
      setName("");
      setUrl("");
      setStatus("Added for review");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not add source");
    }
  };

  return (
    <main className="route-page page-width">
      <header className="route-heading">
        <p className="eyebrow">LOCAL-MARKET DISCOVERY</p>
        <h1>Source monitor</h1>
        <p>Register public HTTPS feeds and planrooms for review before any record enters the verified bid index.</p>
      </header>
      <div className="two-column">
        <form className="panel-form" onSubmit={submit}>
          <div><p className="eyebrow">REGISTER A SOURCE</p><h2>Public posting feed</h2></div>
          <label><span>Source name</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Regional builders exchange" /></label>
          <label><span>Public HTTPS URL</span><input required type="url" pattern="https://.*" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.gov/bids" /></label>
          <button className="button button-primary">Add for review</button>
          <span role="status">{status}</span>
        </form>
        <section>
          <div className="section-heading"><div><p className="eyebrow">WORKSPACE SOURCES</p><h2>Review queue</h2></div></div>
          <AsyncState loading={monitors.loading} error={monitors.error}>
            <div className="monitor-list">
              {[...created, ...(monitors.data?.monitors ?? [])].map((monitor) => (
                <article key={monitor.id}>
                  <div><span className="stage-badge">{monitor.status}</span><h3>{monitor.name}</h3><a href={monitor.url} target="_blank" rel="noreferrer">{monitor.url}</a></div>
                </article>
              ))}
              {!created.length && !monitors.data?.monitors.length && <div className="empty-panel"><h3>No sources registered</h3><p>Add a public source to begin its review trail.</p></div>}
            </div>
          </AsyncState>
        </section>
      </div>
    </main>
  );
}
