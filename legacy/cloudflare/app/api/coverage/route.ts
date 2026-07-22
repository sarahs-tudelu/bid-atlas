import { getDashboardFeed } from "../../lib/dashboard-feed";

export const dynamic = "force-dynamic";

export async function GET() {
  const feed = await getDashboardFeed();
  return Response.json(
    {
      coverage: feed.coverage,
      inventory: feed.inventory,
      sources: feed.sources,
      warnings: feed.warnings,
    },
    { headers: { "Cache-Control": "public, max-age=0, s-maxage=900" } },
  );
}
