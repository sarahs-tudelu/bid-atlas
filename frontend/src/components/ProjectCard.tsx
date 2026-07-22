import { Link } from "react-router-dom";

import type { Project } from "../types";

function formatDate(value?: string): string {
  if (!value) return "Deadline not published";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}

function formatMoney(value?: number): string {
  if (value === undefined) return "Value not published";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    notation: value >= 1_000_000 ? "compact" : "standard",
  }).format(value);
}

function location(project: Project): string {
  return [project.address, project.city || project.county, project.state]
    .filter(Boolean)
    .join(" · ") || "Location in source record";
}

export function ProjectCard({ project }: { project: Project }) {
  const documentCount = project.documents?.length ?? 0;
  return (
    <article className="project-card">
      <div className="project-card-topline">
        <span className={`stage-badge stage-${project.stage}`}>{project.stage.replace("-", " ")}</span>
        <span>{project.sourceRecordId}</span>
      </div>
      <h3>{project.title}</h3>
      <p className="project-summary">{project.summary || "No summary was published by the source."}</p>
      <dl className="project-facts">
        <div>
          <dt>Location</dt>
          <dd>{location(project)}</dd>
        </div>
        <div>
          <dt>Deadline</dt>
          <dd>{formatDate(project.bidDate)}</dd>
        </div>
        <div>
          <dt>Value</dt>
          <dd>{formatMoney(project.value)}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>{documentCount} official route{documentCount === 1 ? "" : "s"}</dd>
        </div>
      </dl>
      <div className="project-actions">
        <Link className="button button-primary" to={`/bid-desk?project=${encodeURIComponent(project.id)}`}>
          Open bid desk
        </Link>
        <a className="button button-quiet" href={project.sourceUrl} target="_blank" rel="noreferrer">
          Official source ↗
        </a>
      </div>
    </article>
  );
}
