import { Link, useLocation } from "react-router-dom";

export function NotFoundPage() {
  const { pathname } = useLocation();

  return (
    <main className="route-page page-width">
      <div className="empty-panel not-found">
        <p className="eyebrow">404</p>
        <h1>This route is not in the atlas.</h1>
        <p>
          <code>{pathname}</code> does not match a connected view. Return to the verified opportunity index, or start from
          the coverage ledger.
        </p>
        <div className="hero-actions">
          <Link className="button button-primary" to="/projects">
            Browse open bids
          </Link>
          <Link className="button button-quiet" to="/coverage">
            View coverage
          </Link>
        </div>
      </div>
    </main>
  );
}
