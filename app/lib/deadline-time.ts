export type BidDateTimeZone =
  | "UTC"
  | "America/Chicago"
  | "America/Detroit"
  | "America/Los_Angeles"
  | "America/New_York";

export const DEFAULT_BID_DATE_TIME_ZONE: BidDateTimeZone = "UTC";
export const NYC_CITY_RECORD_TIME_ZONE: BidDateTimeZone = "America/New_York";

const SOURCE_BID_DATE_TIME_ZONES = {
  "michigan-dot-bid-lettings": "America/Detroit",
  "nyc-city-record-construction-procurement": NYC_CITY_RECORD_TIME_ZONE,
  "ohio-dot-filed-construction-projects": "America/New_York",
  "pennsylvania-dot-ecms-bid-packages": "America/New_York",
  "texas-dot-state-let-construction": "America/Chicago",
} as const satisfies Record<string, BidDateTimeZone>;

const DATE_ONLY_DEADLINE = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/i;

/** Calendar date encoded as the system's explicit "time not published" sentinel. */
export function dateOnlyBidDeadline(value: string | undefined): string | undefined {
  const match = DATE_ONLY_DEADLINE.exec(value ?? "");
  return match && Number.isFinite(Date.parse(value!)) ? match[1] : undefined;
}

export function bidDateTimeZoneForSource(
  sourceId: string,
): BidDateTimeZone | undefined {
  return SOURCE_BID_DATE_TIME_ZONES[
    sourceId as keyof typeof SOURCE_BID_DATE_TIME_ZONES
  ];
}

export function sourceBidDateTimeZones(): ReadonlyArray<
  readonly [string, BidDateTimeZone]
> {
  return Object.entries(SOURCE_BID_DATE_TIME_ZONES);
}

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const floatingDateTime =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?)?$/;
const formatterCache = new Map<BidDateTimeZone, Intl.DateTimeFormat>();

function formatter(timeZone: BidDateTimeZone): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, created);
  return created;
}

function calendarPartsAt(
  instant: Date,
  timeZone: BidDateTimeZone,
): CalendarParts {
  const values = new Map(
    formatter(timeZone)
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.get("year") ?? Number.NaN,
    month: values.get("month") ?? Number.NaN,
    day: values.get("day") ?? Number.NaN,
    hour: values.get("hour") ?? Number.NaN,
    minute: values.get("minute") ?? Number.NaN,
    second: values.get("second") ?? Number.NaN,
  };
}

function wallClockTimestamp(parts: CalendarParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function validCalendarParts(parts: CalendarParts): boolean {
  const timestamp = wallClockTimestamp(parts);
  if (!Number.isFinite(timestamp)) return false;
  const normalized = new Date(timestamp);
  return (
    normalized.getUTCFullYear() === parts.year &&
    normalized.getUTCMonth() + 1 === parts.month &&
    normalized.getUTCDate() === parts.day &&
    normalized.getUTCHours() === parts.hour &&
    normalized.getUTCMinutes() === parts.minute &&
    normalized.getUTCSeconds() === parts.second
  );
}

function sameCalendarParts(left: CalendarParts, right: CalendarParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

/**
 * Convert a floating source timestamp into a real UTC instant using the
 * source's published IANA timezone. Nonexistent DST wall times fail closed.
 */
export function sourceLocalDateTimeToIso(
  value: string | undefined,
  timeZone: BidDateTimeZone,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // Preserve an explicit upstream offset instead of applying source-local
  // semantics a second time.
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    const explicit = new Date(trimmed);
    return Number.isFinite(explicit.getTime()) ? explicit.toISOString() : undefined;
  }

  const match = floatingDateTime.exec(trimmed);
  if (!match) return undefined;
  const desired: CalendarParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? 0),
    minute: Number(match[5] ?? 0),
    second: Number(match[6] ?? 0),
  };
  if (!validCalendarParts(desired)) return undefined;
  const milliseconds = Number((match[7] ?? "0").padEnd(3, "0"));

  // Iteratively reconcile the desired wall clock with the wall clock seen in
  // the target timezone. This handles both standard and daylight offsets
  // without relying on the host process timezone.
  let candidate = wallClockTimestamp(desired);
  for (let pass = 0; pass < 4; pass += 1) {
    const observed = calendarPartsAt(new Date(candidate), timeZone);
    const difference = wallClockTimestamp(desired) - wallClockTimestamp(observed);
    if (difference === 0) {
      const withMilliseconds = new Date(candidate + milliseconds);
      return sameCalendarParts(calendarPartsAt(withMilliseconds, timeZone), desired)
        ? withMilliseconds.toISOString()
        : undefined;
    }
    candidate += difference;
  }
  return undefined;
}

export function calendarDateInTimeZone(
  instant: Date,
  timeZone: BidDateTimeZone,
): string {
  if (!Number.isFinite(instant.getTime())) throw new Error("Calendar date requires a valid instant.");
  const parts = calendarPartsAt(instant, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function addCalendarDays(calendarDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendarDate);
  if (!match || !Number.isInteger(days)) throw new Error("Calendar-day shift requires a valid date and integer day count.");
  const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    start.getUTCFullYear() !== Number(match[1]) ||
    start.getUTCMonth() + 1 !== Number(match[2]) ||
    start.getUTCDate() !== Number(match[3])
  ) {
    throw new Error("Calendar-day shift requires a valid date.");
  }
  start.setUTCDate(start.getUTCDate() + days);
  return start.toISOString().slice(0, 10);
}

export function addCalendarYears(calendarDate: string, years: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendarDate);
  if (!match || !Number.isInteger(years)) throw new Error("Calendar-year shift requires a valid date and integer year count.");
  const year = Number(match[1]) + years;
  const month = Number(match[2]);
  const requestedDay = Number(match[3]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(requestedDay, lastDay);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function calendarDayWindow(
  dayCount: number,
  now: Date,
  timeZone: BidDateTimeZone,
): { start: string; end: string } {
  if (!Number.isInteger(dayCount) || dayCount < 1) {
    throw new Error("Calendar window requires a positive integer day count.");
  }
  const sourceDay = calendarDateInTimeZone(now, timeZone);
  const endSourceDay = addCalendarDays(sourceDay, dayCount);
  const start = sourceLocalDateTimeToIso(`${sourceDay}T00:00:00.000`, timeZone);
  const end = sourceLocalDateTimeToIso(`${endSourceDay}T00:00:00.000`, timeZone);
  if (!start || !end) throw new Error("Unable to resolve calendar window.");
  return { start, end };
}

export function formatBidDeadline(
  value: string | undefined,
  timeZone: BidDateTimeZone = DEFAULT_BID_DATE_TIME_ZONE,
): string {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp) || timestamp <= 86_400_000) return "Not published";
  if (dateOnlyBidDeadline(value)) {
    const date = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(timestamp));
    return `${date} - time not published`;
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}
