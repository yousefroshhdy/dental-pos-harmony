import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dayView } from "@/modules/tracking/logic";
import { DAY_FLAGS, REJECT_REASONS, type DayGap, type DayPoint, type DayShift } from "@/modules/tracking/types";

// Third audit, tracking (M7 purged day, M3 capped point list, M4 shift flags). Synthetic data only (D-03).

const shift: DayShift = {
  id: "00000000-0000-4000-8000-0000000005a1",
  status: "closed",
  start_at: "2026-07-22T06:00:00Z",
  end_at: "2026-07-22T14:00:00Z",
  open: false,
  seconds: 28_800,
  start_lat: null,
  start_lng: null,
  end_lat: null,
  end_lng: null,
  anomaly_flags: [],
};
const wholeShiftGap: DayGap = { shift_id: shift.id, start_at: shift.start_at, end_at: shift.end_at, seconds: 28_800, ongoing: false };
const point = (i: number): DayPoint => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  shift_id: shift.id,
  captured_at: new Date(Date.parse(shift.start_at) + i * 300_000).toISOString(),
  received_at: shift.start_at,
  lat: 30.0444,
  lng: 31.2357,
  accuracy_m: 5,
  source: "pwa",
  anomaly_flags: [],
  usable: true,
});

type Day = Parameters<typeof dayView>[0];
const base: Day = {
  shifts: [shift],
  visits: [],
  stops: [],
  gaps: [],
  points: [],
  flags: [],
  raw_purged: false,
  stored_summary: null,
  shift_seconds: 28_800,
  visit_count: 0,
  visit_seconds: 0,
  idle_stop_seconds: 0,
  gap_seconds: 0,
  distance_m: 0,
  ping_count: 0,
};

// What the pre-fix server answered for a purged day: live figures recomputed from the shift
// alone (one whole-shift gap, no distance), with the true summary only alongside.
const purgedLive: Day = {
  ...base,
  raw_purged: true,
  gaps: [wholeShiftGap],
  gap_seconds: 28_800,
  flags: ["gap"],
  stored_summary: {
    shift_count: 1, shift_seconds: 28_800, visit_count: 2, visit_seconds: 3_600, idle_stop_count: 0, idle_stop_seconds: 0,
    gap_count: 0, gap_seconds: 0, distance_m: 9_271.4, ping_count: 97, flags: [], computed_at: "2026-10-30T03:00:00Z",
  },
};

describe("day page: a purged day shows its stored summary (M7)", () => {
  it("uses the stored figures, not a false whole-shift gap", () => {
    const v = dayView({ ...purgedLive, summary_only: true });
    expect(v.summaryOnly).toBe(true);
    expect(v.figures).toEqual({
      shift_seconds: 28_800, visit_count: 2, visit_seconds: 3_600, idle_stop_seconds: 0, gap_seconds: 0, distance_m: 9_271.4, ping_count: 97,
    });
    expect(v.flags).not.toContain("gap");
    expect(v.timeline.map((e) => e.kind)).toEqual(["shift_start", "shift_end"]);
    expect(v.points).toEqual([]);
    expect(v.purgedWithoutSummary).toBe(false);
  });
  it("still picks the summary from an older server that only says raw_purged", () => {
    const v = dayView(purgedLive);
    expect(v.summaryOnly).toBe(true);
    expect(v.figures.gap_seconds).toBe(0);
    expect(v.timeline.some((e) => e.kind === "gap")).toBe(false);
  });
  it("accepts numeric strings in the summary (PostgREST numeric) and falls back on missing ones", () => {
    const v = dayView({ ...purgedLive, summary_only: true, stored_summary: { distance_m: "1234.5", flags: ["idle_stop", 7] } });
    expect(v.figures.distance_m).toBe(1234.5);
    expect(v.figures.shift_seconds).toBe(28_800);
    expect(v.flags).toEqual(["idle_stop"]);
  });
  it("a purged day without a summary (nothing was recorded) is said so, with the live figures", () => {
    const v = dayView({ ...base, raw_purged: true, summary_only: false, gaps: [wholeShiftGap], gap_seconds: 28_800 });
    expect(v.summaryOnly).toBe(false);
    expect(v.purgedWithoutSummary).toBe(true);
    expect(v.figures.gap_seconds).toBe(28_800);
  });
  it("a live day keeps its gaps, stops and points", () => {
    const v = dayView({ ...base, gaps: [wholeShiftGap], gap_seconds: 28_800, flags: ["gap"], points: [point(1)], ping_count: 1 });
    expect(v.summaryOnly).toBe(false);
    expect(v.timeline.map((e) => e.kind)).toEqual(["shift_start", "gap", "shift_end"]);
    expect(v.flags).toEqual(["gap"]);
    expect(v.points).toHaveLength(1);
    expect(v.pointsTruncated).toBe(false);
  });
});

describe("day page: a capped point list says so (M3)", () => {
  it("is truncated when the server says so or lists fewer points than it counted", () => {
    const listed = [point(1), point(2)];
    expect(dayView({ ...base, points: listed, ping_count: 3000, points_truncated: true }).pointsTruncated).toBe(true);
    expect(dayView({ ...base, points: listed, ping_count: 3000 }).pointsTruncated).toBe(true);
    expect(dayView({ ...base, points: listed, ping_count: 2, points_truncated: false }).pointsTruncated).toBe(false);
  });
  it("keeps the full count for the figures", () => {
    expect(dayView({ ...base, points: [point(1)], ping_count: 3000, points_truncated: true }).figures.ping_count).toBe(3000);
  });
});

describe("shift anomaly flags reach the day (M4)", () => {
  it("knows the shift flags the server carries into the day", () => {
    const flags = ["late_sync", "overlap_clamped", "clock_skew", "no_device_location", "no_device_location_end"];
    expect(dayView({ ...base, flags }).flags.sort()).toEqual([...flags].sort());
    expect(DAY_FLAGS).toEqual(expect.arrayContaining(flags));
  });
  it("lists the new point rejection reasons", () => {
    expect(REJECT_REASONS).toEqual(expect.arrayContaining(["too_late", "too_frequent", "shift_cap"]));
  });
});

const load = (locale: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "tracking.json"), "utf8")) as { day: Record<string, string> };

describe.each(["ar", "en"])("summary-only and truncation labels (%s)", (locale) => {
  const day = load(locale).day;
  it("labels a summary-only day with the retention period", () => {
    expect(day.summaryOnlyTitle?.length).toBeGreaterThan(0);
    expect(day.summaryOnly).toContain("{days}");
    expect(day.pointsDeleted).toContain("{days}");
  });
  it("says how many points are shown out of how many", () => {
    expect(day.pointsTruncated).toContain("{shown}");
    expect(day.pointsTruncated).toContain("{total}");
  });
});
