import { getDashboardFeed } from "../../lib/dashboard-feed";

export const dynamic = "force-dynamic";

export async function GET() {
  const feed = await getDashboardFeed();
  return Response.json(feed, {
    headers: {
      "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1800",
    },
  });
}
