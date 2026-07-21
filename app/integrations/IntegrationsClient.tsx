"use client";

import { useEffect, useState, type FormEvent } from "react";
import styles from "./integrations.module.css";

type ProviderKey = "sam" | "apollo";

type IntegrationStatus = {
  provider: ProviderKey;
  personalCredentialSaved: boolean;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
  note: string;
};

type CapabilityResponse = {
  authenticated: true;
  credentialVault: {
    available: boolean;
    encryption: "AES-256-GCM";
    ownerScoped: true;
  };
  integrations: IntegrationStatus[];
};

const PROVIDERS: Array<{
  key: ProviderKey;
  name: string;
  label: string;
  description: string;
  helpUrl: string;
  helpLabel: string;
}> = [
  {
    key: "sam",
    name: "SAM.gov",
    label: "SAM.gov public API key",
    description:
      "For authenticated federal opportunity search, exact notice lookup, and public notice attachments. Scheduled national ingestion remains a separate platform connector.",
    helpUrl: "https://open.gsa.gov/api/get-opportunities-public-api/",
    helpLabel: "SAM.gov API-key guide",
  },
  {
    key: "apollo",
    name: "Apollo",
    label: "Apollo API key",
    description:
      "For on-demand professional contact enrichment. BidAtlas still requires confirmation before a request can consume Apollo credits.",
    helpUrl: "https://docs.apollo.io/docs/api-keys",
    helpLabel: "Apollo API-key guide",
  },
];

export function IntegrationsClient() {
  const [capabilities, setCapabilities] = useState<CapabilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingProvider, setPendingProvider] = useState<ProviderKey | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ProviderKey | null>(null);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/integrations", {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json() as CapabilityResponse | ApiError;
        if (!response.ok || !("authenticated" in body)) {
          throw new Error(apiErrorMessage(body, "Integration settings could not be loaded."));
        }
        setCapabilities(body);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(safeMessage(loadError, "Integration settings could not be loaded."));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  async function saveCredential(
    provider: ProviderKey,
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const apiKey = String(new FormData(form).get("apiKey") ?? "");
    setPendingProvider(provider);
    setConfirmRemove(null);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/integrations", {
        method: "PUT",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider, apiKey }),
      });
      const body = await response.json() as CapabilityResponse | ApiError;
      if (!response.ok || !("authenticated" in body)) {
        throw new Error(apiErrorMessage(body, "The API key could not be saved."));
      }
      form.reset();
      setCapabilities(body);
      setMessage(`${providerName(provider)} key saved privately.`);
    } catch (saveError) {
      setError(safeMessage(saveError, "The API key could not be saved."));
    } finally {
      setPendingProvider(null);
    }
  }

  async function removeCredential(provider: ProviderKey) {
    setPendingProvider(provider);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/integrations", {
        method: "DELETE",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider }),
      });
      const body = await response.json() as CapabilityResponse | ApiError;
      if (!response.ok || !("authenticated" in body)) {
        throw new Error(apiErrorMessage(body, "The saved API key could not be removed."));
      }
      setCapabilities(body);
      setConfirmRemove(null);
      setMessage(`${providerName(provider)} key removed.`);
    } catch (removeError) {
      setError(safeMessage(removeError, "The saved API key could not be removed."));
    } finally {
      setPendingProvider(null);
    }
  }

  if (loading) {
    return <section className={styles.loading} aria-live="polite">Opening your private integration settings…</section>;
  }

  return (
    <section className={styles.workspace} aria-label="API key integrations">
      <div className={styles.securityBar}>
        <div>
          <strong>Account-scoped vault</strong>
          <span>AES-256-GCM encryption · keys are write-only in this screen</span>
        </div>
        <span className={capabilities?.credentialVault.available ? styles.ready : styles.blocked}>
          {capabilities?.credentialVault.available ? "Vault ready" : "Vault setup required"}
        </span>
      </div>

      {!capabilities?.credentialVault.available ? (
        <div className={styles.vaultNotice} role="alert">
          Private key storage is locked until the site owner configures the
          credential-vault master key. No key will be accepted or stored while it is locked.
        </div>
      ) : null}

      <div className={styles.feedback} aria-live="polite">
        {message ? <p className={styles.success}>{message}</p> : null}
        {error ? <p className={styles.error}>{error}</p> : null}
      </div>

      <div className={styles.grid}>
        {PROVIDERS.map((provider) => {
          const status = capabilities?.integrations.find(
            (integration) => integration.provider === provider.key,
          );
          const pending = pendingProvider === provider.key;
          const saved = Boolean(status?.personalCredentialSaved);

          return (
            <article className={styles.card} key={provider.key}>
              <div className={styles.cardHeader}>
                <div>
                  <p className={styles.providerType}>Optional data provider</p>
                  <h2>{provider.name}</h2>
                </div>
                <span className={status?.active ? styles.active : saved ? styles.saved : styles.off}>
                  {status?.active ? "Active" : saved ? "Saved" : "Not connected"}
                </span>
              </div>

              <p className={styles.description}>{provider.description}</p>
              <p className={styles.statusNote}>{status?.note}</p>
              {status?.updatedAt ? (
                <p className={styles.updated}>Updated {formatDate(status.updatedAt)}</p>
              ) : null}

              <form className={styles.form} onSubmit={(event) => void saveCredential(provider.key, event)}>
                <label htmlFor={`${provider.key}-api-key`}>{provider.label}</label>
                <div className={styles.inputRow}>
                  <input
                    id={`${provider.key}-api-key`}
                    name="apiKey"
                    type="password"
                    minLength={8}
                    maxLength={2048}
                    autoComplete="new-password"
                    spellCheck={false}
                    required
                    disabled={pending || !capabilities?.credentialVault.available}
                    placeholder={saved ? "Enter a replacement key" : "Paste API key"}
                    aria-describedby={`${provider.key}-privacy-note`}
                  />
                  <button
                    type="submit"
                    disabled={pending || !capabilities?.credentialVault.available}
                  >
                    {pending ? "Saving…" : saved ? "Replace key" : "Save key"}
                  </button>
                </div>
                <p id={`${provider.key}-privacy-note`} className={styles.privacyNote}>
                  The key is sent only in this HTTPS request body and is never returned by the API.
                </p>
              </form>

              <div className={styles.cardFooter}>
                <a href={provider.helpUrl} target="_blank" rel="noreferrer">
                  {provider.helpLabel}
                </a>
                {saved ? (
                  confirmRemove === provider.key ? (
                    <div className={styles.removeConfirm}>
                      <span>Remove this key?</span>
                      <button type="button" onClick={() => void removeCredential(provider.key)} disabled={pending}>
                        Yes, remove
                      </button>
                      <button type="button" onClick={() => setConfirmRemove(null)} disabled={pending}>
                        Keep it
                      </button>
                    </div>
                  ) : (
                    <button
                      className={styles.removeButton}
                      type="button"
                      onClick={() => setConfirmRemove(provider.key)}
                      disabled={pending}
                    >
                      Remove saved key
                    </button>
                  )
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      <aside className={styles.boundary}>
        <strong>What saving a key does not do</strong>
        <p>
          It does not authorize outreach, submit bids, expose personal data, or
          make private plans public. Apollo calls still require credit confirmation;
          SAM.gov personal keys power your interactive federal research but do not
          replace the site owner&apos;s scheduled national-ingestion key.
        </p>
      </aside>
    </section>
  );
}

type ApiError = { error?: { message?: string } };

function apiErrorMessage(value: CapabilityResponse | ApiError, fallback: string): string {
  return "error" in value && value.error?.message ? value.error.message : fallback;
}

function safeMessage(value: unknown, fallback: string): string {
  return value instanceof Error && value.message ? value.message : fallback;
}

function providerName(provider: ProviderKey): string {
  return provider === "sam" ? "SAM.gov" : "Apollo";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
