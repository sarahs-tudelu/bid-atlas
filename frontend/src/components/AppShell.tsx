import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { useTheme } from "../hooks/useTheme";

const primaryLinks = [
  ["/projects", "Open bids"],
  ["/leads", "Leads"],
  ["/companies", "Companies"],
  ["/documents", "Documents"],
  ["/coverage", "Coverage"],
] as const;

const secondaryLinks = [
  ["/bid-desk", "Bid desk"],
  ["/outreach", "Outreach"],
  ["/source-monitor", "Source monitor"],
  ["/integrations", "Integrations"],
] as const;

const activeClass = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : "");

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
    </svg>
  );
}

export function AppShell() {
  const { theme, toggleTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  // Escape dismisses the drawer, and an open drawer locks the page behind it.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <header className="topbar">
        <NavLink className="brand" to="/" aria-label="BidAtlas home">
          <span className="brand-mark" aria-hidden="true">BA</span>
          <span>BidAtlas</span>
        </NavLink>

        <nav className="primary-nav" aria-label="Primary navigation">
          {primaryLinks.map(([to, label]) => (
            <NavLink key={to} to={to} className={activeClass}>
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="topbar-actions">
          <NavLink className="workspace-link" to="/bid-desk">
            Bid desk
          </NavLink>
          <button
            className="icon-button"
            type="button"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            className="icon-button nav-toggle"
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          >
            <MenuIcon open={menuOpen} />
          </button>
        </div>
      </header>

      {menuOpen && (
        <>
          <button className="nav-scrim" type="button" aria-label="Close navigation" onClick={closeMenu} />
          <nav className="mobile-nav" aria-label="Mobile navigation">
            <header>
              <p>Navigate</p>
              <button className="icon-button" type="button" onClick={closeMenu} aria-label="Close navigation">
                <MenuIcon open />
              </button>
            </header>
            {[...primaryLinks, ...secondaryLinks].map(([to, label]) => (
              <NavLink key={to} to={to} className={activeClass} onClick={closeMenu}>
                {label}
              </NavLink>
            ))}
          </nav>
        </>
      )}

      <p className="truth-banner">
        <strong>Evidence first.</strong> Loaded records are connected public sources, not a claim of complete U.S. coverage.
      </p>

      <div id="main-content">
        <Outlet />
      </div>

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
