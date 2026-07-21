import type { Metadata } from "next";
import { BidQueueClient } from "./BidQueueClient";
import { getChatGPTUser } from "./chatgpt-auth";
import { queryConnectedProjects } from "./lib/connected-project-search";
import { getDashboardFeed } from "./lib/dashboard-feed";
import { resolveIntegrationCredential } from "./lib/integration-credentials";

export const metadata: Metadata = {
  title: "BidAtlas — Verified open construction bids",
  description:
    "Search qualified open construction bids with current deadlines and official plans or specifications routes.",
};

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  const samCredential = await resolveIntegrationCredential(
    user?.email.toLowerCase(),
    "sam",
  );
  const feed = await getDashboardFeed({ samApiKey: samCredential?.apiKey });
  const initialSearchPage = await queryConnectedProjects(
    feed,
    {
      keywords: [],
      location: "",
      match: "all",
      stage: "all",
      state: "all",
      freshness: "actionable",
      due: "all",
      readiness: "bid-ready",
      includeArchived: false,
    },
    1,
    10,
  );
  return (
    <BidQueueClient
      mode="home"
      initialSearchPage={initialSearchPage}
      initialSearchState={{ keywords: "", location: "", due: "all" }}
    />
  );
}
