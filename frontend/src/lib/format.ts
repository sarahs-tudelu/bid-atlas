const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function parse(value?: string | null): Date | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

export function formatDate(value?: string | null, fallback = "Not published"): string {
  const date = parse(value);
  if (!date) return value || fallback;
  return DATE.format(date);
}

export function formatDateTime(value?: string | null, fallback = "Not published"): string {
  const date = parse(value);
  if (!date) return value || fallback;
  return DATE_TIME.format(date);
}

export function formatMoney(value?: number | null, fallback = "Value not published"): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return fallback;
  const compact = value >= 1_000_000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    // Compact notation keeps one decimal, so a $2.4M job is not shown as $2M.
    maximumFractionDigits: compact ? 1 : 0,
    notation: compact ? "compact" : "standard",
  }).format(value);
}

export function formatCompact(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatCount(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US");
}

export type DeadlineTone = "none" | "neutral" | "soon" | "urgent" | "passed";

export interface Deadline {
  tone: DeadlineTone;
  label: string;
  /** Full date for a tooltip, so the short label never hides the real deadline. */
  title: string;
}

const DAY_MS = 86_400_000;

/**
 * Turns a raw bid date into how much time is actually left, which is the thing
 * an estimator scans for first.
 */
export function describeDeadline(value?: string | null, now = new Date()): Deadline {
  const date = parse(value);
  if (!date) return { tone: "none", label: "Deadline not published", title: "Deadline not published" };

  const title = DATE_TIME.format(date);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDue = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDue - startOfToday) / DAY_MS);

  if (days < 0) return { tone: "passed", label: `Closed ${DATE.format(date)}`, title };
  if (days === 0) return { tone: "urgent", label: "Due today", title };
  if (days === 1) return { tone: "urgent", label: "Due tomorrow", title };
  if (days <= 3) return { tone: "urgent", label: `Due in ${days} days`, title };
  if (days <= 14) return { tone: "soon", label: `Due in ${days} days`, title };
  return { tone: "neutral", label: DATE.format(date), title };
}
