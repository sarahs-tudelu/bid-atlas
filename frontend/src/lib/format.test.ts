import { describe, expect, it } from "vitest";

import { describeDeadline, formatCount, formatMoney } from "./format";

const NOW = new Date("2026-07-22T12:00:00Z");

describe("describeDeadline", () => {
  it("reports missing deadlines without inventing one", () => {
    expect(describeDeadline(undefined, NOW).tone).toBe("none");
    expect(describeDeadline("", NOW).label).toBe("Deadline not published");
  });

  it("escalates as the deadline approaches", () => {
    expect(describeDeadline("2026-07-22T18:00:00Z", NOW)).toMatchObject({ tone: "urgent", label: "Due today" });
    expect(describeDeadline("2026-07-23T18:00:00Z", NOW)).toMatchObject({ tone: "urgent", label: "Due tomorrow" });
    expect(describeDeadline("2026-07-25T18:00:00Z", NOW)).toMatchObject({ tone: "urgent", label: "Due in 3 days" });
    expect(describeDeadline("2026-07-30T18:00:00Z", NOW)).toMatchObject({ tone: "soon", label: "Due in 8 days" });
  });

  it("falls back to a plain date once the deadline is far out", () => {
    expect(describeDeadline("2026-09-30T18:00:00Z", NOW).tone).toBe("neutral");
  });

  it("marks past deadlines as closed rather than urgent", () => {
    const past = describeDeadline("2026-07-20T18:00:00Z", NOW);
    expect(past.tone).toBe("passed");
    expect(past.label).toContain("Closed");
  });

  it("passes an unparseable value through instead of crashing", () => {
    expect(describeDeadline("upon request", NOW).tone).toBe("none");
  });
});

describe("formatters", () => {
  it("distinguishes an unpublished value from zero", () => {
    expect(formatMoney(undefined)).toBe("Value not published");
    expect(formatMoney(0)).toBe("$0");
    expect(formatCount(undefined)).toBe("—");
    expect(formatCount(0)).toBe("0");
  });

  it("compacts large currency amounts", () => {
    expect(formatMoney(2_400_000)).toBe("$2.4M");
  });
});
