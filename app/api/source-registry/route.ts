import { STATE_SOURCE_REGISTRY } from "../../lib/state-source-registry";

export async function GET() {
  return Response.json({
    generatedAt: new Date().toISOString(),
    scope: "50 states plus the District of Columbia",
    nationallyComplete: false,
    notice:
      "These 102 official state procurement and transportation entry points are discovery roots. Universities, authorities, local governments, below-threshold work, and separate plan rooms still require their own source records.",
    sources: STATE_SOURCE_REGISTRY,
  });
}
