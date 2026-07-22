import { AsyncState } from "../components/AsyncState";
import { CardGridSkeleton } from "../components/Skeleton";
import { useApi } from "../hooks/useApi";

interface Provider {
  id: string;
  name: string;
  configured: boolean;
  detail: string;
}

export function IntegrationsPage() {
  const { data, error, loading, refetch } = useApi<{ providers: Provider[] }>("/api/integrations");
  const providers = data?.providers ?? [];
  const connected = providers.filter((provider) => provider.configured).length;

  return (
    <main className="route-page page-width">
      <header className="route-heading">
        <p className="eyebrow">Controlled connectors</p>
        <h1>Integrations</h1>
        <p>Runtime capability is visible here without returning, logging, or exposing credentials.</p>
      </header>

      <AsyncState loading={loading} error={error} onRetry={refetch} skeleton={<CardGridSkeleton count={4} height={150} />}>
        {data &&
          (providers.length ? (
            <>
              <p className="results-toolbar" aria-live="polite">
                <strong>{connected}</strong> of {providers.length} connector{providers.length === 1 ? "" : "s"} configured
              </p>
              <div className="integration-grid">
                {providers.map((provider) => (
                  <article className="integration-card" key={provider.id}>
                    <div>
                      <span className={`status-dot ${provider.configured ? "connected" : ""}`} />
                      <span>{provider.configured ? "Connected" : "Not configured"}</span>
                    </div>
                    <h2>{provider.name}</h2>
                    <p>{provider.detail}</p>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-panel">
              <h2>No connectors registered</h2>
              <p>Runtime credentials have not been provisioned for this deployment.</p>
            </div>
          ))}
      </AsyncState>
    </main>
  );
}
