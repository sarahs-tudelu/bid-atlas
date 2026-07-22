import { NavLink, Outlet } from "react-router-dom";

const primaryLinks = [
  ["/projects", "Open bids"],
  ["/leads", "Leads"],
  ["/companies", "Companies"],
  ["/documents", "Documents"],
  ["/coverage", "Coverage"],
] as const;

export function AppShell() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <NavLink className="brand" to="/" aria-label="BidAtlas home">
          <span className="brand-mark" aria-hidden="true">BA</span>
          <span>BidAtlas</span>
        </NavLink>
        <nav aria-label="Primary navigation">
          {primaryLinks.map(([to, label]) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "active" : "")}>
              {label}
            </NavLink>
          ))}
        </nav>
        <NavLink className="workspace-link" to="/bid-desk">
          Bid desk
        </NavLink>
      </header>
      <div className="truth-banner">
        <strong>Evidence first.</strong> Loaded records are connected public sources, not a claim of complete U.S. coverage.
      </div>
      <Outlet />
      <footer className="site-footer">
        <div>
          <span className="brand-mark" aria-hidden="true">BA</span>
          <p>Public construction intelligence with source-level evidence.</p>
        </div>
        <nav aria-label="Secondary navigation">
          <NavLink to="/source-monitor">Source monitor</NavLink>
          <NavLink to="/integrations">Integrations</NavLink>
          <a href="/api/docs">API docs</a>
        </nav>
      </footer>
    </div>
  );
}
