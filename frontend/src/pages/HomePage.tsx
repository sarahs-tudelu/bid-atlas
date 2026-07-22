import { Link } from "react-router-dom";

import { AsyncState } from "../components/AsyncState";
import { MetricCard } from "../components/MetricCard";
import { ProjectCard } from "../components/ProjectCard";
import { ProjectGridSkeleton } from "../components/Skeleton";
import { useApi } from "../hooks/useApi";
import { formatCompact, formatCount, formatDateTime } from "../lib/format";
import type { DashboardResponse } from "../types";

export function HomePage() {
  const { data, error, loading, refetch } = useApi<DashboardResponse>("/api/dashboard");
  const stageCounts = data?.inventory.stageCounts ?? {};
  const earlyStage = (stageCounts.planning ?? 0) + (stageCounts.design ?? 0) + (stageCounts.permitting ?? 0);

  return (
    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">Public construction intelligence</p>
          <h1>
            Find the work.
            <br />
            Verify the trail.
          </h1>
          <p className="hero-copy">
            Search connected public records from planning through bid award, with official source evidence attached to every
            result.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary button-large" to="/projects">
              Search open bids
            </Link>
            <Link className="button button-quiet button-large" to="/leads">
              Explore early leads
            </Link>
          </div>
        </div>

        {loading ? (
          <div className="skeleton" style={{ minHeight: 360, borderRadius: "3px 34px 3px 3px" }} aria-hidden="true" />
        ) : (
          data && (
            <aside className="hero-pulse">
              <div>
                <span className="live-dot" /> AWS snapshot
              </div>
              <strong>{formatCount(data.inventory.totalProjects)}</strong>
              <p>connected project records</p>
              <dl>
                <div>
                  <dt>Sources</dt>
                  <dd>{data.sources?.length ?? 0}</dd>
                </div>
                <div>
                  <dt>States/DC</dt>
                  <dd>{data.coverage.statesAndDistrict}</dd>
                </div>
                <div>
                  <dt>Registry</dt>
                  <dd>{formatCompact(data.coverage.registryRowsAvailable)}</dd>
                </div>
              </dl>
              <small>Snapshot {formatDateTime(data.generatedAt, "time not published")}</small>
            </aside>
          )
        )}
      </section>

      <AsyncState
        loading={loading}
        error={error}
        onRetry={refetch}
        skeleton={
          <div className="page-width">
            <ProjectGridSkeleton count={4} />
          </div>
        }
      >
        {data && (
          <>
            <section className="metric-grid page-width" aria-label="Coverage summary">
              <MetricCard
                label="Open bidding records"
                value={formatCount(stageCounts.bidding ?? 0)}
                detail="Published bidding stage"
              />
              <MetricCard label="Early-stage leads" value={formatCount(earlyStage)} detail="Planning through permitting" />
              <MetricCard
                label="Named companies"
                value={formatCount(data.inventory.contractorOrganizations ?? 0)}
                detail="Literal source evidence"
              />
              <MetricCard
                label="Connected source groups"
                value={formatCount(data.coverage.connectedSourceGroups)}
                detail={`${formatCount(data.coverage.identifiedSourceGroups)} identified nationwide`}
              />
            </section>

            <section className="section page-width">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Qualified opportunities</p>
                  <h2>Bid-ready work with a document route</h2>
                </div>
                <Link to="/projects">View all open bids →</Link>
              </div>
              {data.projects?.length ? (
                <div className="project-grid">
                  {data.projects.slice(0, 6).map((project) => (
                    <ProjectCard key={project.id} project={project} />
                  ))}
                </div>
              ) : (
                <div className="empty-panel">
                  <h2>No bid-ready records in this snapshot</h2>
                  <p>The connected sources have not published an open solicitation with a document route yet.</p>
                  <Link className="button button-primary" to="/leads">
                    Explore early leads
                  </Link>
                </div>
              )}
            </section>
          </>
        )}
      </AsyncState>
    </main>
  );
}
