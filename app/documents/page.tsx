import type { Metadata } from "next";
import { DashboardClient } from "../DashboardClient";
import { getDashboardFeed } from "../lib/dashboard-feed";

export const metadata: Metadata = {
  title: "Plans and Specifications — BidAtlas",
  description:
    "Search verified project document metadata and lawfully extracted plans, specifications, addenda, drawings, and CAD text.",
};

export const dynamic = "force-dynamic";

interface DocumentsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const DOCUMENT_TYPES = new Set([
  "plans",
  "specifications",
  "addenda",
  "drawings",
  "cad",
  "bid-form",
  "schedule",
  "report",
  "other",
]);
const PROCESSING_STATUSES = new Set([
  "metadata-only",
  "stored-awaiting-extraction",
  "stored-conversion-pending",
  "text-indexed",
]);

function firstParam(value: string | string[] | undefined, max = 300): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim().slice(0, max) || undefined;
}

function positiveInt(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(parsed)));
}

export default async function DocumentsPage({ searchParams }: DocumentsPageProps) {
  const params = await searchParams;
  const feed = await getDashboardFeed();
  const documentType = firstParam(params.type, 40) ?? "";
  const processingStatus = firstParam(params.status, 60) ?? "";
  const requestedLimit = positiveInt(firstParam(params.limit, 3), 10, 50);
  return (
    <DashboardClient
      feed={feed}
      view="documents"
      initialDocumentProjectId={firstParam(params.project)}
      initialDocumentSourceId={firstParam(params.source)}
      initialDocumentSearch={{
        query: firstParam(params.q) ?? "",
        documentType: DOCUMENT_TYPES.has(documentType) ? documentType : "",
        processingStatus: PROCESSING_STATUSES.has(processingStatus) ? processingStatus : "",
        publicOnly: firstParam(params.public, 10) !== "0",
        page: positiveInt(firstParam(params.page, 12), 1, 1_000_000),
        pageSize: [10, 25, 50].includes(requestedLimit) ? requestedLimit : 10,
      }}
    />
  );
}
