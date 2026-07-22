/**
 * Surfaces the connector warnings the API already returns. A snapshot built from
 * a partly failed refresh should say so rather than read as complete coverage.
 */
export function SourceWarnings({ warnings }: { warnings?: string[] }) {
  if (!warnings?.length) return null;

  return (
    <details className="warning-disclosure">
      <summary>
        {warnings.length} source warning{warnings.length === 1 ? "" : "s"} affected this snapshot
      </summary>
      <ul>
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </details>
  );
}
