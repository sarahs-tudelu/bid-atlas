import { useApi } from "../hooks/useApi";


interface GoogleStatus {
  configured: boolean;
  domain: string;
}

export function LoginPage({ error = "" }: { error?: string }) {
  const status = useApi<GoogleStatus>("/api/auth/google/status");
  const unavailable = !status.loading && (!status.data?.configured || Boolean(status.error));

  return (
    <main className="login-page">
      <section className="login-card">
        <span className="brand-mark" aria-hidden="true">BA</span>
        <p className="eyebrow">TUDELU WORKSPACE</p>
        <h1>Sign in to BidAtlas</h1>
        <p>
          Use your Tudelu Google account to access qualified product opportunities, review prior contact,
          and send approved outreach from your own Gmail mailbox.
        </p>
        {error ? <div className="notice-panel" role="alert">{error}</div> : null}
        {unavailable ? (
          <div className="notice-panel" role="alert">Google sign-in is not configured for this environment.</div>
        ) : null}
        <a
          className={`button button-primary${unavailable ? " is-disabled" : ""}`}
          href="/api/auth/google/start"
          aria-disabled={unavailable}
          onClick={(event) => {
            if (unavailable) event.preventDefault();
          }}
        >
          Continue with Google
        </a>
        <small>Only verified @{status.data?.domain ?? "tudelu.com"} accounts are accepted.</small>
      </section>
    </main>
  );
}
