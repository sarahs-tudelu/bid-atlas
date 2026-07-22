import { Link } from "react-router-dom";

import { AsyncState } from "../components/AsyncState";
import { MetricCard } from "../components/MetricCard";
import { ProjectCard } from "../components/ProjectCard";
import { useApi } from "../hooks/useApi";
import type { DashboardResponse } from "../types";

function compact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function HomePage() {
  const { data, error, loading } = useApi<DashboardResponse>("/api/dashboard");

  return (
    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">PUBLIC CONSTRUCTION INTELLIGENCE</p>
          <h1>Find the work.<br />Verify the trail.</h1>
          <p className="hero-copy">
            Search connected public records from planning through bid award, with official source evidence attached to every result.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary button-large" to="/projects">Search open bids</Link>
            <Link className="button button-quiet button-large" to="/leads">Explore early leads</Link>
          </div>
        </div>
        <AsyncState loading={loading} error={error}>
          {data && (
            <aside className="hero-pulse">
              <div><span className="live-dot" /> AWS snapshot</div>
              <strong>{data.inventory.totalProjects.toLocaleString()}</strong>
              <p>connected project records</p>
              <dl>
                <div><dt>Sources</dt><dd>{data.sources.length}</dd></div>
                <div><dt>States/DC</dt><dd>{data.coverage.statesAndDistrict}</dd></div>
                <div><dt>Registry</dt><dd>{compact(data.coverage.registryRowsAvailable)}</dd></div>
              </dl>
              <small>Snapshot {new Date(data.generatedAt).toLocaleString()}</small>
            </aside>
          )}
        </AsyncState>
      </section>

      <AsyncState loading={loading} error={error}>
        {data && (
          <>
            <section className="metric-grid page-width" aria-label="Coverage summary">
              <MetricCard label="Open bidding records" value={data.inventory.stageCounts.bidding ?? 0} detail="Published bidding stage" />
              <MetricCard label="Early-stage leads" value={(data.inventory.stageCounts.planning ?? 0) + (data.inventory.stageCounts.design ?? 0) + (data.inventory.stageCounts.permitting ?? 0)} detail="Planning through permitting" />
              <MetricCard label="Named companies" value={data.inventory.contractorOrganizations ?? 0} detail="Literal source evidence" />
              <MetricCard label="Connected source groups" value={data.coverage.connectedSourceGroups} detail={`${data.coverage.identifiedSourceGroups} identified nationwide`} />
            </section>

            <section className="section page-width">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">QUALIFIED OPPORTUNITIES</p>
                  <h2>Bid-ready work with a document route</h2>
                </div>
                <Link to="/projects">View all open bids →</Link>
              </div>
              <div className="project-grid">
                {data.projects.slice(0, 6).map((project) => <ProjectCard key={project.id} project={project} />)}
              </div>
            </section>
          </>
        )}
      </AsyncState>
    </main>
  );
}
