import type { Metadata } from "next";
import { DashboardClient } from "../DashboardClient";
import { getChatGPTUser } from "../chatgpt-auth";
import { getDashboardFeed } from "../lib/dashboard-feed";
import { resolveIntegrationCredential } from "../lib/integration-credentials";

export const metadata: Metadata = {
  title: "Coverage ledger — BidAtlas",
  description:
    "Review active public-source adapters, known data gaps, and BidAtlas coverage across every state and DC.",
};

export const dynamic = "force-dynamic";

export default async function CoveragePage() {
  const user = await getChatGPTUser();
  const samCredential = await resolveIntegrationCredential(
    user?.email.toLowerCase(),
    "sam",
  );
  const feed = await getDashboardFeed({ samApiKey: samCredential?.apiKey });
  return <DashboardClient feed={feed} view="coverage" />;
}
