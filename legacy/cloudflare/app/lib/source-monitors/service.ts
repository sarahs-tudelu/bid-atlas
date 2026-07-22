import { fetchPublicSourceText } from "./network";
import { parsePostedProjectFeed } from "./parser";
import {
  getSourceMonitor,
  listDueSourceMonitors,
  recordSourceMonitorFailure,
  recordSourceMonitorSuccess,
  upsertDiscoveredPostings,
  type CandidateUpsertResult,
  type MonitorD1Database,
} from "./repository";
import { SourceMonitorInputError, type SourceMonitorRecord } from "./contracts";

export type SourceMonitorScanResult = CandidateUpsertResult & {
  monitorId: string;
  monitorName: string;
  fetchedUrl: string;
  contentType: string;
};

export async function scanSourceMonitor(
  db: MonitorD1Database,
  monitor: SourceMonitorRecord,
  now = new Date(),
): Promise<SourceMonitorScanResult> {
  try {
    const fetched = await fetchPublicSourceText(monitor.feedUrl);
    const postings = parsePostedProjectFeed(fetched.body, fetched.contentType, monitor).map((posting) => ({
      ...posting,
      evidence: {
        ...posting.evidence,
        monitoredSource: monitor.feedUrl,
        fetchedUrl: fetched.finalUrl,
        fetchedAt: now.toISOString(),
      },
    }));
    const persisted = await upsertDiscoveredPostings(db, monitor, postings, now);
    await recordSourceMonitorSuccess(db, monitor, persisted, now);
    return {
      ...persisted,
      monitorId: monitor.id,
      monitorName: monitor.name,
      fetchedUrl: fetched.finalUrl,
      contentType: fetched.contentType,
    };
  } catch (error) {
    await recordSourceMonitorFailure(db, monitor, error, now);
    throw error;
  }
}

export async function scanOwnedSourceMonitor(
  db: MonitorD1Database,
  ownerKey: string,
  monitorId: string,
  now = new Date(),
): Promise<SourceMonitorScanResult> {
  const monitor = await getSourceMonitor(db, monitorId, ownerKey);
  if (!monitor) {
    throw new SourceMonitorInputError(404, "source_monitor_not_found", "The source monitor was not found.");
  }
  return scanSourceMonitor(db, monitor, now);
}

export type DueSourceMonitorRun = {
  checked: number;
  succeeded: number;
  failed: number;
  discovered: number;
  verified: number;
  needsReview: number;
  errors: Array<{ monitorId: string; message: string }>;
};

export async function runDueSourceMonitors(
  db: MonitorD1Database,
  now = new Date(),
  limit = 3,
): Promise<DueSourceMonitorRun> {
  const monitors = await listDueSourceMonitors(db, now, limit);
  const result: DueSourceMonitorRun = {
    checked: monitors.length,
    succeeded: 0,
    failed: 0,
    discovered: 0,
    verified: 0,
    needsReview: 0,
    errors: [],
  };
  for (const monitor of monitors) {
    try {
      const scan = await scanSourceMonitor(db, monitor, now);
      result.succeeded += 1;
      result.discovered += scan.discovered;
      result.verified += scan.verified;
      result.needsReview += scan.needsReview;
    } catch (error) {
      result.failed += 1;
      result.errors.push({
        monitorId: monitor.id,
        message: (error instanceof Error ? error.message : "Source scan failed.").slice(0, 500),
      });
    }
  }
  return result;
}
