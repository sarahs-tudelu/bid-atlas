import type { ReactNode } from "react";

interface AsyncStateProps {
  loading: boolean;
  error: string;
  children: ReactNode;
}

export function AsyncState({ loading, error, children }: AsyncStateProps) {
  if (loading) {
    return (
      <div className="loading-panel" role="status">
        <span className="loading-dot" />
        Loading verified records…
      </div>
    );
  }
  if (error) {
    return (
      <div className="error-panel" role="alert">
        <strong>BidAtlas could not load this view.</strong>
        <span>{error}</span>
      </div>
    );
  }
  return children;
}
