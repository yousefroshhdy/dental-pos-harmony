import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type UserContext } from "@/lib/authz/can";
import { createMemoryStore, createQueue } from "@/lib/offline/queue";
import { formatDuration, formatKm } from "@/modules/tracking/format";
import {
  addDays,
  buildTimeline,
  cairoToday,
  canOpenDay,
  canReadTracking,
  canStartShift,
  chunk,
  dayFlags,
  durationParts,
  elapsedSeconds,
  isCollecting,
  isRowFlagged,
  mapsUrl,
  noticeParagraphs,
  parseDay,
  reconcileShift,
  shiftGroup,
  shouldFlush,
  shouldSample,
  sortTeamRows,
  submitTrackingCommand,
  toPing,
  TRACKING_QUEUED_COMMANDS,
  trackingErrorCode,
  trackingToSendResult,
  type LocalShift,
} from "@/modules/tracking/logic";
import type { DayGap, DayShift, DayStop, DayVisit, OpenShift, PingInput, TeamDayRow } from "@/modules/tracking/types";

// Synthetic data only (D-03).
const EMP = "00000000-0000-4000-8000-0000000007e1";
const USER = "00000000-0000-4000-8000-0000000007a1";

const ctx = (perms: Record<string, "own" | "team" | "all">, employee = true): UserContext => ({
  ...ANONYMOUS_CONTEXT,
  user_id: USER,
  active: true,
  status: "active",
  employee: employee ? { id: EMP, employee_no: "E-T1", full_name_en: "Synthetic Rep", full_name_ar: null, job_title: "Rep" } : null,
  permissions: Object.fromEntries(Object.entries(perms).map(([k, scope]) => [k, { scope, limit: null }])),
});

describe("permissions (UX only)", () => {
  it("a rep may start a shift and open only their own day", () => {
    const rep = ctx({ "field.shift.start": "own" });
    expect(canStartShift(rep)).toBe(true);
    expect(canReadTracking(rep)).toBe(false);
    expect(canOpenDay(rep, EMP)).toBe(true);
    expect(canOpenDay(rep, "00000000-0000-4000-8000-0000000007e2")).toBe(false);
  });
  it("a manager reads the team; no employee profile means no shift", () => {
    expect(canReadTracking(ctx({ "field.tracking.read": "team" }))).toBe(true);
    expect(canOpenDay(ctx({ "field.tracking.read": "team" }), "00000000-0000-4000-8000-0000000007e2")).toBe(true);
    expect(canStartShift(ctx({ "field.shift.start": "own" }, false))).toBe(false);
    expect(canStartShift(ANONYMOUS_CONTEXT)).toBe(false);
  });
  it("knows its own error codes", () => {
    expect(trackingErrorCode("NOTICE_REQUIRED")).toBe("NOTICE_REQUIRED");
    expect(trackingErrorCode("PERMISSION_DENIED")).toBeNull();
    expect(trackingErrorCode(undefined)).toBeNull();
  });
});

describe("display helpers", () => {
  it("links to Google Maps with six decimals", () => {
    expect(mapsUrl(30.0444, "31.2357")).toBe("https://www.google.com/maps?q=30.044400,31.235700");
  });
  it("splits durations into hours and minutes", () => {
    expect(durationParts(0)).toEqual({ h: 0, m: 0 });
    expect(durationParts(2400)).toEqual({ h: 0, m: 40 });
    expect(durationParts(14_400)).toEqual({ h: 4, m: 0 });
    expect(durationParts(-50)).toEqual({ h: 0, m: 0 });
    const t = (key: string, v?: Record<string, string | number>) => `${key}:${JSON.stringify(v)}`;
    expect(formatDuration(t, 3_900)).toBe('duration.hm:{"h":"1","m":"05"}');
    expect(formatDuration(t, 600)).toBe('duration.m:{"m":"10"}');
    expect(formatKm(t, "12345.6")).toBe('km:{"value":"12.3"}');
  });
  it("splits the notice into paragraphs", () => {
    expect(noticeParagraphs("One.\n\nTwo\nlines.\n\n  \n\nThree.")).toEqual(["One.", "Two\nlines.", "Three."]);
  });
  it("flags and orders the team rows", () => {
    const row = (name: string, flags: string[]) => ({ employee_id: name, full_name_en: name, full_name_ar: null, flags }) as unknown as TeamDayRow;
    expect(isRowFlagged(row("a", []))).toBe(false);
    expect(isRowFlagged(row("a", ["something_new"]))).toBe(false);
    expect(isRowFlagged(row("a", ["gap"]))).toBe(true);
    expect(dayFlags(["gap", "x", "idle_stop"])).toEqual(["idle_stop", "gap"]);
    expect(sortTeamRows([row("Zed", []), row("Bob", []), row("Amy", ["idle_stop"])], "en").map((r) => r.full_name_en)).toEqual(["Amy", "Bob", "Zed"]);
  });
});

describe("timeline", () => {
  const shift = (open: boolean): DayShift => ({
    id: "s1",
    status: open ? "open" : "closed",
    start_at: "2026-10-01T06:00:00Z",
    end_at: "2026-10-01T10:00:00Z",
    open,
    seconds: 14_400,
    start_lat: null,
    start_lng: null,
    end_lat: null,
    end_lng: null,
    anomaly_flags: [],
  });
  const visit = { id: "v1", start_at: "2026-10-01T08:10:00Z" } as DayVisit;
  const stop = { start_at: "2026-10-01T06:00:00Z" } as DayStop;
  const gap = { start_at: "2026-10-01T07:35:00Z" } as DayGap;

  it("orders shift start → stops, gaps and visits by time → shift end", () => {
    const kinds = buildTimeline({ shifts: [shift(false)], visits: [visit], stops: [stop], gaps: [gap] }).map((e) => e.kind);
    expect(kinds).toEqual(["shift_start", "stop", "gap", "visit", "shift_end"]);
  });
  it("an open shift has no end entry", () => {
    expect(buildTimeline({ shifts: [shift(true)], visits: [], stops: [], gaps: [] }).map((e) => e.kind)).toEqual(["shift_start"]);
  });
});

describe("Cairo days", () => {
  it("parses only real calendar days", () => {
    expect(parseDay("2026-10-01")).toBe("2026-10-01");
    expect(parseDay(["2026-02-28"])).toBe("2026-02-28");
    expect(parseDay("2026-02-31")).toBeNull();
    expect(parseDay("01/10/2026")).toBeNull();
    expect(parseDay(undefined)).toBeNull();
  });
  it("steps days across month ends and DST changes", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-10-30", -1)).toBe("2026-10-29"); // Egypt leaves DST on the last Thursday of October
  });
  it("today is the Cairo date, not the UTC one", () => {
    // 22:30 UTC on 31 Dec is already 1 Jan in Cairo (UTC+2 in winter).
    expect(cairoToday(new Date("2026-12-31T22:30:00Z"))).toBe("2027-01-01");
  });
});

describe("device shift state", () => {
  const server: OpenShift = {
    id: "srv-1",
    client_ref: "ref-1",
    status: "open",
    started_at: "2026-10-30T06:00:00Z",
    window_start: "2026-10-30T06:00:00Z",
    max_end_at: "2026-10-30T16:00:00Z",
    overdue: false,
    last_ping_at: null,
    last_ping_received_at: null,
    ping_count: 0,
  };
  const local = (over: Partial<LocalShift> = {}): LocalShift => ({
    ref: "ref-1",
    startedAt: "2026-10-30T06:00:00Z",
    maxEndAt: "2026-10-30T16:00:00Z",
    confirmed: true,
    confirmedAtMs: 1_000,
    serverId: "srv-1",
    overdue: false,
    ...over,
  });
  const now = Date.parse("2026-10-30T08:00:00Z");

  it("follows the server's open shift", () => {
    expect(reconcileShift(null, server, { fetchedAtMs: 5_000, nowMs: now, lastEnded: null })).toMatchObject({ ref: "ref-1", confirmed: true, serverId: "srv-1" });
  });
  it("does not re-open a shift this device already ended (its end waits to sync)", () => {
    expect(reconcileShift(local(), server, { fetchedAtMs: 5_000, nowMs: now, lastEnded: { ref: "ref-1", atMs: 4_000 } })).toBeNull();
  });
  it("forgets a confirmed shift the server no longer has (ended elsewhere, auto-closed)", () => {
    expect(reconcileShift(local(), null, { fetchedAtMs: 5_000, nowMs: now, lastEnded: null })).toBeNull();
  });
  it("ignores a read that started before the start was confirmed", () => {
    expect(reconcileShift(local({ confirmedAtMs: 6_000 }), null, { fetchedAtMs: 5_000, nowMs: now, lastEnded: null })).not.toBeNull();
  });
  it("keeps an offline start until its maximum length", () => {
    const pending = local({ confirmed: false, confirmedAtMs: null });
    expect(reconcileShift(pending, null, { fetchedAtMs: 5_000, nowMs: now, lastEnded: null })).toBe(pending);
    expect(reconcileShift(pending, null, { fetchedAtMs: 5_000, nowMs: Date.parse("2026-10-30T17:00:00Z"), lastEnded: null })).toBeNull();
  });
  it("collects only while a shift is open, not overdue and under the cap", () => {
    expect(isCollecting(null, now)).toBe(false);
    expect(isCollecting(local(), now)).toBe(true);
    expect(isCollecting(local({ overdue: true }), now)).toBe(false);
    expect(isCollecting(local(), Date.parse("2026-10-30T16:00:01Z"))).toBe(false);
    expect(elapsedSeconds(local(), now)).toBe(7_200);
    expect(elapsedSeconds(local(), Date.parse("2026-10-30T20:00:00Z"))).toBe(36_000);
  });
});

describe("sampling and batching", () => {
  it("keeps one point per interval", () => {
    expect(shouldSample(null, 0, 300_000)).toBe(true);
    expect(shouldSample(0, 200_000, 300_000)).toBe(false);
    expect(shouldSample(0, 295_000, 300_000)).toBe(true); // timer drift slack
  });
  const ping = (minutesAgo: number, now: number): PingInput => ({
    id: `p${minutesAgo}`,
    lat: 30,
    lng: 31,
    accuracy_m: 10,
    captured_at: new Date(now - minutesAgo * 60_000).toISOString(),
    source: "pwa",
  });
  it("flushes three points, or one that waited ten minutes", () => {
    const now = Date.parse("2026-10-30T08:00:00Z");
    expect(shouldFlush([], now)).toBe(false);
    expect(shouldFlush([ping(1, now)], now)).toBe(false);
    expect(shouldFlush([ping(10, now)], now)).toBe(true);
    expect(shouldFlush([ping(3, now), ping(2, now), ping(1, now)], now)).toBe(true);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("rounds a point like the database columns", () => {
    expect(toPing({ id: "x", lat: 30.04441234, lng: 31.23579999, accuracy: 12.345, timestampMs: Date.parse("2026-10-30T08:00:00Z") })).toEqual({
      id: "x",
      lat: 30.044412,
      lng: 31.2358,
      accuracy_m: 12.3,
      captured_at: "2026-10-30T08:00:00.000Z",
      source: "pwa",
    });
    expect(toPing({ id: "y", lat: 1, lng: 2, accuracy: null, timestampMs: 0 }).accuracy_m).toBeNull();
  });
});

describe("send now or save on the device", () => {
  const cmd = { command: TRACKING_QUEUED_COMMANDS.startShift, id: "00000000-0000-4000-8000-0000000007c1", args: { client_ref: "x" }, groupKey: shiftGroup("x") };
  const queue = () => createQueue(createMemoryStore(), USER);

  it("online: sent directly", async () => {
    const out = await submitTrackingCommand(cmd, { online: true, queue: queue(), send: async () => ({ ok: true as const, data: { shift_id: "s" } }) });
    expect(out).toEqual({ kind: "sent", data: { shift_id: "s" } });
  });
  it("offline: saved, never sent", async () => {
    let sent = 0;
    const out = await submitTrackingCommand(cmd, { online: false, queue: queue(), send: async () => (sent++, { ok: true as const, data: null }) });
    expect(out.kind).toBe("queued");
    expect(sent).toBe(0);
  });
  it("a lost answer is saved (the command is idempotent); a business error is not", async () => {
    const q = queue();
    const lost = await submitTrackingCommand(cmd, { online: true, queue: q, send: async () => Promise.reject(new Error("network")) });
    expect(lost.kind).toBe("queued");
    const q2 = queue();
    const refused = await submitTrackingCommand(cmd, {
      online: true,
      queue: q2,
      send: async () => ({ ok: false as const, code: "NOTICE_REQUIRED", messageKey: "UNKNOWN" as const, retryable: false }),
    });
    expect(refused).toMatchObject({ kind: "error", code: "NOTICE_REQUIRED" });
    expect(await q2.list()).toEqual([]);
  });
  it("waits behind an unresolved earlier item of the same shift", async () => {
    const q = queue();
    await q.enqueue({ command: TRACKING_QUEUED_COMMANDS.recordPings, args: { pings: [] }, groupKey: shiftGroup("x") });
    const out = await submitTrackingCommand({ ...cmd, id: "00000000-0000-4000-8000-0000000007c2", command: TRACKING_QUEUED_COMMANDS.endShift }, {
      online: true,
      queue: q,
      send: async () => ({ ok: true as const, data: null }),
    });
    expect(out.kind).toBe("queued");
  });
  it("maps an unknown outcome to an ambiguous failure the engine re-sends", () => {
    expect(trackingToSendResult({ ok: false, code: "UNAVAILABLE", messageKey: "UNAVAILABLE", retryable: true })).toMatchObject({
      ok: false,
      error: { ambiguous: true, retryable: false },
    });
    expect(trackingToSendResult({ ok: true, data: { replayed: true } })).toEqual({ ok: true, data: { replayed: true } });
  });
});
