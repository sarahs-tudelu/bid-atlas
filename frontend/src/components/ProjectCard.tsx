import { Link } from "react-router-dom";

import { describeDeadline, formatMoney } from "../lib/format";
import { emailContacts, phoneContacts, telephoneHref } from "../lib/contacts";
import { projectWorkspaceHref } from "../lib/projectNavigation";
import { summarizeFitReasons } from "../lib/productFit";
import { STAGE_LABELS } from "./ProjectSearch";
import type { Project } from "../types";

function location(project: Project): string {
  return (
    [project.address, project.city || project.county, project.state].filter(Boolean).join(" · ") ||
    "Location in source record"
  );
}

export function ProjectCard({ project, returnTo }: { project: Project; returnTo?: string }) {
  const documentCount = project.documents?.length ?? 0;
  const deadline = describeDeadline(project.bidDate);
  const stage = project.stage ?? "unclassified";
  const workspaceHref = projectWorkspaceHref(project.id, returnTo);
  const emailContact = emailContacts(project)[0];
  const phoneContact = phoneContacts(project)[0];
  const needsContactResearch =
    project.contactStatus === "research-needed" || (!emailContact && !phoneContact);

  return (
    <article className="project-card">
      <div className="project-card-topline">
        <div className="project-badges">
          <span className={`stage-badge stage-${stage}`}>{STAGE_LABELS[stage] ?? stage.replace("-", " ")}</span>
          {project.productMatches?.map((match) => (
            <span className="product-badge" key={match.id} title={match.reasons.join(", ")}>
              {match.label}
            </span>
          ))}
          {project.canopyFit && project.canopyFit.band !== "low" ? (
            <span className={`fit-badge fit-${project.canopyFit.band}`} title={project.canopyFit.reasons.join(", ")}>
              Product fit {project.canopyFit.score}
            </span>
          ) : null}
          {project.hasAccessibleDrawings ? (
            <span className="drawing-badge">
              Drawings available
            </span>
          ) : null}
          {needsContactResearch ? (
            <span
              className="research-badge"
              title="The source did not publish a usable email address or phone number."
            >
              Research needed
            </span>
          ) : null}
          {(project.duplicateSourceCount ?? 0) > 1 ? (
            <span
              className="merged-badge"
              title="BidAtlas matched multiple official database records to this project."
            >
              {project.duplicateSourceCount} sources merged
            </span>
          ) : null}
        </div>
        {deadline.tone !== "none" ? (
          <span
            className={`due-badge ${deadline.tone === "urgent" ? "due-urgent" : deadline.tone === "soon" ? "due-soon" : deadline.tone === "passed" ? "due-passed" : ""}`}
            title={deadline.title}
          >
            {deadline.label}
          </span>
        ) : null}
      </div>

      <h3>
        <Link to={workspaceHref}>{project.title}</Link>
      </h3>
      <p className="project-summary">{project.summary || "No summary was published by the source."}</p>

      {project.canopyFit?.reasons.length ? (
        <div className="fit-explanation">
          <strong>Why this score</strong>
          <span>{summarizeFitReasons(project.canopyFit.reasons)}</span>
        </div>
      ) : null}

      <dl className="project-facts">
        <div>
          <dt>Location</dt>
          <dd>{location(project)}</dd>
        </div>
        <div>
          <dt>Agency</dt>
          <dd className={project.agency ? "" : "is-muted"}>{project.agency || "Not published"}</dd>
        </div>
        <div>
          <dt>Value</dt>
          <dd className={project.value === undefined ? "is-muted" : ""}>{formatMoney(project.value)}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd className={documentCount ? "" : "is-muted"}>
            {project.hasAccessibleDrawings
              ? `${project.accessibleDrawingCount ?? 1} public drawing route${(project.accessibleDrawingCount ?? 1) === 1 ? "" : "s"}`
              : documentCount
                ? `${documentCount} official route${documentCount === 1 ? "" : "s"}`
                : "No document route"}
          </dd>
        </div>
      </dl>

      <p className="project-card-provenance">
        <span className="visually-hidden">Source record </span>
        {project.sourceRecordId}
        {project.sourceName ? ` · ${project.sourceName}` : ""}
      </p>

      <div className="project-actions">
        <Link className="button button-primary" to={workspaceHref}>
          Open project workspace
        </Link>
        {emailContact ? (
          <Link className="button button-quiet" to={`/outreach?project=${encodeURIComponent(project.id)}`}>
            Email outreach
          </Link>
        ) : null}
        {phoneContact?.phone ? (
          <a className="button button-quiet" href={telephoneHref(phoneContact.phone)}>
            Call {phoneContact.phone}
          </a>
        ) : null}
        <a className="button button-quiet" href={project.sourceUrl} target="_blank" rel="noreferrer">
          Official source ↗
        </a>
      </div>
    </article>
  );
}
