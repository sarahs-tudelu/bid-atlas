"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import styles from "./source-monitor.module.css";

type Monitor = {
  id: string;
  name: string;
  publisher: string;
  jurisdiction: string;
  city?: string;
  state?: string;
  sourceType: string;
  feedUrl: string;
  feedFormat: string;
  cadenceMinutes: number;
  status: "active" | "paused";
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  candidateCount: number;
  verifiedCount: number;
};

type Candidate = {
  id: string;
  monitorId: string;
  projectId?: string;
  title: string;
  summary: string;
  sourceUrl: string;
  publisher: string;
  city?: string;
  state?: string;
  postedAt?: string;
  bidDate?: string;
  documentUrl?: string;
  documentName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  submissionUrl?: string;
  tradeTags: string[];
  opportunityType: "public-bid" | "company-posted";
  status: "needs-review" | "verified" | "rejected" | "expired";
  readinessReasons: string[];
  lastSeenAt: string;
};

type MonitorPayload = { monitors: Monitor[]; candidates: Candidate[] };
type ApiError = { error?: { message?: string } };

const REASON_LABELS: Record<string, string> = {
  "missing-title": "Project title",
  "missing-summary": "Published scope",
  "missing-location": "City or state",
  "missing-deadline": "Bid deadline",
  "deadline-passed": "Current deadline",
  "missing-source-url": "Source posting",
  "source-host-mismatch": "Confirm cross-site posting link",
  "missing-bid-language": "Bid or quote language",
  "missing-bid-documents": "Plans or specifications route",
};

function errorMessage(value: unknown, fallback: string): string {
  if (value && typeof value === "object") {
    const api = value as ApiError;
    if (api.error?.message) return api.error.message;
  }
  return value instanceof Error && value.message ? value.message : fallback;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return {};
  }
}

function dateLabel(value?: string): string {
  if (!value) return "Not checked yet";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}

function deadlineInput(value?: string): string {
  if (!value) return "";
  return value.slice(0, 10);
}

export function SourceMonitorClient() {
  const [payload, setPayload] = useState<MonitorPayload>({ monitors: [], candidates: [] });
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);

  async function load() {
    const response = await fetch("/api/source-monitors", {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    const body = await responseJson(response);
    if (!response.ok || !body || typeof body !== "object" || !("monitors" in body)) {
      throw new Error(errorMessage(body, "Source monitors could not be loaded."));
    }
    setPayload(body as MonitorPayload);
  }

  useEffect(() => {
    let active = true;
    void load()
      .catch((loadError) => active && setError(errorMessage(loadError, "Source monitors could not be loaded.")))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const counts = useMemo(() => ({
    review: payload.candidates.filter((candidate) => candidate.status === "needs-review").length,
    verified: payload.candidates.filter((candidate) => candidate.status === "verified").length,
    active: payload.monitors.filter((monitor) => monitor.status === "active").length,
  }), [payload]);

  async function createMonitor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending("create");
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/source-monitors", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          publisher: data.get("publisher"),
          jurisdiction: data.get("jurisdiction"),
          city: data.get("city"),
          state: data.get("state"),
          sourceType: data.get("sourceType"),
          feedUrl: data.get("feedUrl"),
          feedFormat: data.get("feedFormat"),
          cadenceMinutes: Number(data.get("cadenceMinutes")),
        }),
      });
      const body = await responseJson(response);
      if (!response.ok) throw new Error(errorMessage(body, "The source could not be added."));
      form.reset();
      setShowForm(false);
      await load();
      setMessage("Source added. Run the first scan when you are ready to review its postings.");
    } catch (createError) {
      setError(errorMessage(createError, "The source could not be added."));
    } finally {
      setPending(null);
    }
  }

  async function scan(monitor: Monitor) {
    setPending(`scan:${monitor.id}`);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`/api/source-monitors/${encodeURIComponent(monitor.id)}/scan`, {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const body = await responseJson(response) as { scan?: { discovered?: number; verified?: number; needsReview?: number } } & ApiError;
      if (!response.ok || !body.scan) throw new Error(errorMessage(body, "The source scan failed."));
      await load();
      setMessage(
        `${monitor.name}: ${body.scan.discovered ?? 0} postings found, ${body.scan.verified ?? 0} verified, ${body.scan.needsReview ?? 0} queued for review.`,
      );
    } catch (scanError) {
      setError(errorMessage(scanError, "The source scan failed."));
    } finally {
      setPending(null);
    }
  }

  async function toggleMonitor(monitor: Monitor) {
    setPending(`toggle:${monitor.id}`);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/source-monitors", {
        method: "PUT",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ id: monitor.id, status: monitor.status === "active" ? "paused" : "active" }),
      });
      const body = await responseJson(response);
      if (!response.ok) throw new Error(errorMessage(body, "The source status could not be changed."));
      await load();
      setMessage(`${monitor.name} ${monitor.status === "active" ? "paused" : "resumed"}.`);
    } catch (toggleError) {
      setError(errorMessage(toggleError, "The source status could not be changed."));
    } finally {
      setPending(null);
    }
  }

  async function reviewCandidate(candidate: Candidate, form: HTMLFormElement, action: "verify" | "reject") {
    const data = new FormData(form);
    setPending(`${action}:${candidate.id}`);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`/api/source-monitors/candidates/${encodeURIComponent(candidate.id)}`, {
        method: "PATCH",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "verify" ? {
            title: data.get("title"),
            summary: data.get("summary"),
            city: data.get("city"),
            state: data.get("state"),
            bidDate: data.get("bidDate"),
            documentUrl: data.get("documentUrl"),
            documentName: data.get("documentName"),
            contactName: data.get("contactName"),
            contactEmail: data.get("contactEmail"),
            submissionUrl: data.get("submissionUrl"),
            tradeTags: String(data.get("tradeTags") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
          } : {}),
        }),
      });
      const body = await responseJson(response);
      if (!response.ok) throw new Error(errorMessage(body, `The posting could not be ${action === "verify" ? "published" : "rejected"}.`));
      setReviewing(null);
      await load();
      setMessage(action === "verify" ? "Posting verified and published to Open bids." : "Posting rejected and removed from the actionable queue.");
    } catch (reviewError) {
      setError(errorMessage(reviewError, "The review decision could not be saved."));
    } finally {
      setPending(null);
    }
  }

  if (loading) return <section className={styles.loading}>Loading monitored sources…</section>;

  return (
    <section className={styles.workspace}>
      <div className={styles.stats} aria-label="Source monitor summary">
        <div><strong>{counts.active}</strong><span>active sources</span></div>
        <div><strong>{counts.review}</strong><span>need review</span></div>
        <div><strong>{counts.verified}</strong><span>verified postings</span></div>
        <button type="button" onClick={() => setShowForm((value) => !value)}>
          {showForm ? "Close form" : "Add public source"}
        </button>
      </div>

      <div className={styles.feedback} aria-live="polite">
        {message ? <p className={styles.success}>{message}</p> : null}
        {error ? <p className={styles.error}>{error}</p> : null}
      </div>

      {showForm ? (
        <form className={styles.addForm} onSubmit={(event) => void createMonitor(event)}>
          <header>
            <p className={styles.eyebrow}>NEW MONITORED SOURCE</p>
            <h2>Add one official feed or public planroom</h2>
            <p>Use the original publisher’s HTTPS page, RSS/Atom feed, or JSON feed—not a paid competitor’s login-protected inventory.</p>
          </header>
          <div className={styles.formGrid}>
            <label><span>Source name</span><input name="name" required maxLength={160} placeholder="NYC construction solicitations" /></label>
            <label><span>Publisher</span><input name="publisher" required maxLength={200} placeholder="City agency or general contractor" /></label>
            <label><span>Jurisdiction</span><input name="jurisdiction" required maxLength={200} placeholder="New York City, New York" /></label>
            <label><span>City</span><input name="city" maxLength={120} placeholder="New York" /></label>
            <label><span>State</span><input name="state" required minLength={2} maxLength={2} placeholder="NY" /></label>
            <label><span>Source type</span><select name="sourceType" defaultValue="public-procurement"><option value="public-procurement">Public procurement</option><option value="gc-planroom">GC planroom</option><option value="owner-planroom">Owner/developer planroom</option><option value="builders-exchange">Builders exchange</option></select></label>
            <label className={styles.wide}><span>Public feed or listing URL</span><input name="feedUrl" type="url" required placeholder="https://publisher.example/bids.xml" /></label>
            <label><span>Format</span><select name="feedFormat" defaultValue="auto"><option value="auto">Detect automatically</option><option value="rss">RSS</option><option value="atom">Atom</option><option value="json-feed">JSON feed</option><option value="html">HTML listing</option></select></label>
            <label><span>Check cadence</span><select name="cadenceMinutes" defaultValue="1440"><option value="60">Hourly</option><option value="360">Every 6 hours</option><option value="1440">Daily</option><option value="10080">Weekly</option></select></label>
          </div>
          <div className={styles.formActions}>
            <button type="submit" disabled={pending === "create"}>{pending === "create" ? "Adding…" : "Add source"}</button>
            <button type="button" className={styles.secondary} onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </form>
      ) : null}

      <section className={styles.monitorSection}>
        <header className={styles.sectionHeader}>
          <div><p className={styles.eyebrow}>SOURCE REGISTRY</p><h2>Monitored posting locations</h2></div>
          <p>Active sources refresh automatically on their configured cadence.</p>
        </header>
        <div className={styles.monitorGrid}>
          {payload.monitors.map((monitor) => (
            <article className={styles.monitorCard} key={monitor.id}>
              <header>
                <div><span className={monitor.status === "active" ? styles.live : styles.paused}>{monitor.status}</span><h3>{monitor.name}</h3></div>
                <span>{monitor.sourceType.replaceAll("-", " ")}</span>
              </header>
              <p>{monitor.publisher} · {monitor.jurisdiction}</p>
              <a href={monitor.feedUrl} target="_blank" rel="noreferrer">Open original source</a>
              <dl>
                <div><dt>Found</dt><dd>{monitor.candidateCount}</dd></div>
                <div><dt>Verified</dt><dd>{monitor.verifiedCount}</dd></div>
                <div><dt>Last check</dt><dd>{dateLabel(monitor.lastCheckedAt)}</dd></div>
              </dl>
              {monitor.lastError ? <p className={styles.monitorError}>{monitor.lastError}</p> : null}
              <footer>
                <button type="button" disabled={pending === `scan:${monitor.id}`} onClick={() => void scan(monitor)}>{pending === `scan:${monitor.id}` ? "Scanning…" : "Scan now"}</button>
                <button type="button" className={styles.secondary} disabled={pending === `toggle:${monitor.id}`} onClick={() => void toggleMonitor(monitor)}>{monitor.status === "active" ? "Pause" : "Resume"}</button>
              </footer>
            </article>
          ))}
          {payload.monitors.length === 0 ? <div className={styles.empty}><strong>No monitored sources yet.</strong><p>Add one city procurement feed or public contractor planroom to start the pilot.</p></div> : null}
        </div>
      </section>

      <section className={styles.candidateSection}>
        <header className={styles.sectionHeader}>
          <div><p className={styles.eyebrow}>REVIEW QUEUE</p><h2>Discovered project postings</h2></div>
          <p>Missing evidence stays visible here and never enters Open bids.</p>
        </header>
        <div className={styles.candidateList}>
          {payload.candidates.map((candidate) => {
            const editing = reviewing === candidate.id;
            const monitor = payload.monitors.find((item) => item.id === candidate.monitorId);
            return (
              <article className={styles.candidateCard} key={candidate.id}>
                <div className={styles.candidateMain}>
                  <div className={styles.candidateMeta}>
                    <span className={styles[candidate.status.replace("-", "")]}>{candidate.status.replace("-", " ")}</span>
                    <span>{candidate.opportunityType === "public-bid" ? "Public bid" : "Company posted"}</span>
                    <span>{candidate.city || "Location pending"}{candidate.state ? `, ${candidate.state}` : ""}</span>
                  </div>
                  <h3>{candidate.title}</h3>
                  <p>{candidate.summary}</p>
                  <div className={styles.links}>
                    <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">Original posting</a>
                    {candidate.documentUrl ? <a href={candidate.documentUrl} target="_blank" rel="noreferrer">Bid documents</a> : null}
                    {candidate.projectId ? <a href={`/bid-desk?project=${encodeURIComponent(candidate.projectId)}&source=${encodeURIComponent(candidate.monitorId)}`}>Open in Bid Desk</a> : null}
                  </div>
                </div>
                <aside className={styles.candidateAside}>
                  <span>Bid deadline</span><strong>{candidate.bidDate ? deadlineInput(candidate.bidDate) : "Missing"}</strong>
                  <small>{monitor?.name ?? candidate.publisher}</small>
                </aside>
                {candidate.readinessReasons.length ? (
                  <div className={styles.missing}>
                    <strong>Needed before publishing</strong>
                    <div>{candidate.readinessReasons.map((reason) => <span key={reason}>{REASON_LABELS[reason] ?? reason}</span>)}</div>
                  </div>
                ) : null}
                {candidate.status === "needs-review" ? (
                  editing ? (
                    <form className={styles.reviewForm} onSubmit={(event) => { event.preventDefault(); void reviewCandidate(candidate, event.currentTarget, "verify"); }}>
                      <label className={styles.wide}><span>Project title</span><input name="title" defaultValue={candidate.title} required /></label>
                      <label className={styles.wide}><span>Published scope</span><textarea name="summary" defaultValue={candidate.summary} required rows={4} /></label>
                      <label><span>City</span><input name="city" defaultValue={candidate.city} /></label>
                      <label><span>State</span><input name="state" defaultValue={candidate.state} minLength={2} maxLength={2} required /></label>
                      <label><span>Bid deadline</span><input name="bidDate" type="date" defaultValue={deadlineInput(candidate.bidDate)} required /></label>
                      <label><span>Trade tags</span><input name="tradeTags" defaultValue={candidate.tradeTags.join(", ")} placeholder="roofing, electrical" /></label>
                      <label className={styles.wide}><span>Plans/specifications URL</span><input name="documentUrl" type="url" defaultValue={candidate.documentUrl} required /></label>
                      <label><span>Document label</span><input name="documentName" defaultValue={candidate.documentName} placeholder="Plans and specifications" /></label>
                      <label><span>Contact name</span><input name="contactName" defaultValue={candidate.contactName} /></label>
                      <label><span>Contact email</span><input name="contactEmail" type="email" defaultValue={candidate.contactEmail} /></label>
                      <label><span>Submission URL</span><input name="submissionUrl" type="url" defaultValue={candidate.submissionUrl} /></label>
                      <div className={styles.reviewActions}>
                        <button type="submit" disabled={pending === `verify:${candidate.id}`}>{pending === `verify:${candidate.id}` ? "Publishing…" : "Verify and publish"}</button>
                        <button type="button" className={styles.secondary} onClick={() => setReviewing(null)}>Cancel</button>
                        <button type="button" className={styles.reject} disabled={pending === `reject:${candidate.id}`} onClick={(event) => { if (event.currentTarget.form) void reviewCandidate(candidate, event.currentTarget.form, "reject"); }}>Reject posting</button>
                      </div>
                    </form>
                  ) : (
                    <footer className={styles.candidateActions}>
                      <button type="button" onClick={() => setReviewing(candidate.id)}>Review posting</button>
                    </footer>
                  )
                ) : null}
              </article>
            );
          })}
          {payload.candidates.length === 0 ? <div className={styles.empty}><strong>No postings discovered yet.</strong><p>Run a monitored source to populate the review queue.</p></div> : null}
        </div>
      </section>
    </section>
  );
}
