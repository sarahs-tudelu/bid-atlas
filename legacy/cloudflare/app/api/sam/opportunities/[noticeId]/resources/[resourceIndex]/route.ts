import { proxySamOpportunityAsset } from "../../../../../../lib/sam-asset-proxy";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ noticeId: string; resourceIndex: string }> },
) {
  const { noticeId, resourceIndex } = await context.params;
  if (!/^\d{1,2}$/.test(resourceIndex)) {
    return Response.json(
      { error: { code: "invalid_resource_index", message: "The SAM.gov resource index is invalid." } },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  return proxySamOpportunityAsset(request, noticeId, {
    kind: "resource",
    index: Number(resourceIndex),
  });
}
