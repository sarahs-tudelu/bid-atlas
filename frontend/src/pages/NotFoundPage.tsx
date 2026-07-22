import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <main className="route-page page-width">
      <div className="empty-panel not-found">
        <p className="eyebrow">404</p>
        <h1>This route is not in the atlas.</h1>
        <p>Return to the verified opportunity index.</p>
        <Link className="button button-primary" to="/projects">Browse open bids</Link>
      </div>
    </main>
  );
}
