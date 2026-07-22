import type { Metadata } from "next";
import Link from "next/link";
import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
} from "../chatgpt-auth";
import { SourceMonitorClient } from "./SourceMonitorClient";
import styles from "./source-monitor.module.css";

export const metadata: Metadata = {
  title: "Source Monitor — BidAtlas",
  description: "Monitor public construction bid feeds and verify actionable posted projects.",
};

export const dynamic = "force-dynamic";

export default async function SourceMonitorPage() {
  const user = await getChatGPTUser();
  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/" aria-label="BidAtlas home">
          <span className={styles.brandMark} aria-hidden="true">BA</span>
          <span>BidAtlas</span>
        </Link>
        <nav aria-label="Source monitor navigation">
          <Link href="/projects">Open bids</Link>
          <Link href="/companies">Companies</Link>
          <Link href="/bid-desk">Bid Desk</Link>
          <Link href="/coverage">Coverage</Link>
          <span aria-current="page">Source Monitor</span>
        </nav>
        <div className={styles.account}>
          {user ? (
            <>
              <span title={user.email}>{user.displayName}</span>
              <Link href={chatGPTSignOutPath("/")}>Sign out</Link>
            </>
          ) : (
            <Link href={chatGPTSignInPath("/source-monitor")}>Sign in</Link>
          )}
        </div>
      </header>

      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>LOCAL SOURCE ACQUISITION</p>
          <h1>Turn posted projects into a verified bid queue.</h1>
          <p>
            Watch a public procurement feed or contractor planroom, normalize each
            posting, and publish only opportunities with a live deadline, location,
            source evidence, and plans or specifications route.
          </p>
        </div>
        <aside>
          <strong>What enters Open bids</strong>
          <span>Current posting</span>
          <span>Bid language</span>
          <span>Location and deadline</span>
          <span>Plans or specifications</span>
        </aside>
      </section>

      {user ? (
        <SourceMonitorClient />
      ) : (
        <section className={styles.signedOut}>
          <p className={styles.eyebrow}>PRIVATE WORKSPACE</p>
          <h2>Sign in to register and review sources</h2>
          <p>
            Source configuration and review decisions are account-scoped. Publicly
            verified opportunities remain searchable in the main bid queue.
          </p>
          <Link href={chatGPTSignInPath("/source-monitor")}>Sign in with ChatGPT</Link>
        </section>
      )}
    </main>
  );
}
