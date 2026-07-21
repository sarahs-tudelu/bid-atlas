import { proxySamOpportunityAsset } from "../../../../../lib/sam-asset-proxy";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ noticeId: string }> },
) {
  const { noticeId } = await context.params;
  return proxySamOpportunityAsset(request, noticeId, { kind: "description" });
}
