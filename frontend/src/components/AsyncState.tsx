import type { ReactNode } from "react";

interface AsyncStateProps {
  loading: boolean;
  error: string;
  children: ReactNode;
  /** Layout-matched placeholder shown instead of the generic loading strip. */
  skeleton?: ReactNode;
  /** Wired to `useApi().refetch` so a failed view can be retried in place. */
  onRetry?: () => void;
}

export function AsyncState({ loading, error, children, skeleton, onRetry }: AsyncStateProps) {
  if (loading) {
    if (skeleton) {
      return (
        <>
          <span className="visually-hidden" role="status">
            Loading records…
          </span>
          {skeleton}
        </>
      );
    }
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
        {onRetry && (
          <button className="button button-quiet" type="button" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  }

  return children;
}
