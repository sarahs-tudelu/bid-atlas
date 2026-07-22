import { AsyncState } from "../components/AsyncState";
import { useApi } from "../hooks/useApi";

interface Provider {
  id: string;
  name: string;
  configured: boolean;
  detail: string;
}

export function IntegrationsPage() {
  const { data, error, loading } = useApi<{ providers: Provider[] }>("/api/integrations");
  return (
    <main className="route-page page-width">
      <header className="route-heading">
        <p className="eyebrow">CONTROLLED CONNECTORS</p>
        <h1>Integrations</h1>
        <p>Runtime capability is visible here without returning, logging, or exposing credentials.</p>
      </header>
      <AsyncState loading={loading} error={error}>
        <div className="integration-grid">
          {data?.providers.map((provider) => (
            <article className="integration-card" key={provider.id}>
              <div><span className={`status-dot ${provider.configured ? "connected" : ""}`} /><span>{provider.configured ? "Connected" : "Not configured"}</span></div>
              <h2>{provider.name}</h2>
              <p>{provider.detail}</p>
            </article>
          ))}
        </div>
      </AsyncState>
    </main>
  );
}
