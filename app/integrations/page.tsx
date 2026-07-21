import type { Metadata } from "next";
import Link from "next/link";
import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
} from "../chatgpt-auth";
import { IntegrationsClient } from "./IntegrationsClient";
import styles from "./integrations.module.css";

export const metadata: Metadata = {
  title: "Integrations — BidAtlas",
  description: "Manage private, account-scoped API keys for BidAtlas integrations.",
};

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const user = await getChatGPTUser();
  const signInPath = chatGPTSignInPath("/integrations");

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/" aria-label="BidAtlas home">
          <span className={styles.brandMark}>BA</span>
          <span>BidAtlas</span>
        </Link>
        <nav className={styles.nav} aria-label="Integration page navigation">
          <Link href="/projects">Projects</Link>
          <Link href="/documents">Documents</Link>
          <Link href="/bid-desk">Bid Desk</Link>
          <Link href="/coverage">Coverage</Link>
          <Link href="/source-monitor">Source Monitor</Link>
          <span aria-current="page">Integrations</span>
        </nav>
        <div className={styles.account}>
          {user ? (
            <>
              <span title={user.email}>{user.displayName}</span>
              <Link href={chatGPTSignOutPath("/")}>Sign out</Link>
            </>
          ) : (
            <Link href={signInPath}>Sign in</Link>
          )}
        </div>
      </header>

      <section className={styles.hero}>
        <p className={styles.eyebrow}>Private account settings</p>
        <h1>Connect optional research services</h1>
        <p>
          Add a key once and BidAtlas can use it only for your account. Keys are
          encrypted before storage, never shown again, and never placed in links.
        </p>
      </section>

      {user ? (
        <IntegrationsClient />
      ) : (
        <section className={styles.signedOut} aria-labelledby="integration-sign-in-title">
          <p className={styles.eyebrow}>Authentication required</p>
          <h2 id="integration-sign-in-title">Sign in before adding a private API key</h2>
          <p>
            The integration catalog is available, but credential storage is tied to an
            authenticated workspace account so one user can never read or replace another
            user&apos;s keys.
          </p>
          <Link href={signInPath}>Sign in with ChatGPT</Link>
        </section>
      )}
    </main>
  );
}
