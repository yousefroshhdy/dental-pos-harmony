import { can, type UserContext } from "@/lib/authz/can";
import type { TranslatedCode } from "@/lib/errors";
import type { EnqueueInput } from "@/lib/offline/queue";
import type { Json, JsonObject, QueueItem, SendResult } from "@/lib/offline/types";
import { cairoDate, zonedLocalToInstant } from "@/modules/field/logic";
import { DAY_FLAGS, type DayGap, type DayPoint, type DayShift, type DayStop, type DayVisit, type DeviceResult, type OpenShift, type PingInput, type TeamDayRow, type TrackingDay, type TrackingNotice } from "./types";

/**
 * Pure logic for work-hours tracking (D-14). UI gating here is cosmetic:
 * Postgres re-checks every command and read (docs/AUTHORIZATION.md §5).
 */

// ---------------------------------------------------------------------------
// Permissions (UX only)
// ---------------------------------------------------------------------------

/** The manager screens (/tracking): field.tracking.read at any scope. */
export function canReadTracking(ctx: UserContext): boolean {
  return can(ctx, "field.tracking.read");
}

/** The shift card and the collector: field.shift.start and an employee profile. */
export function canStartShift(ctx: UserContext): boolean {
  return can(ctx, "field.shift.start") && ctx.employee !== null;
}

/** A rep may always open their own day (D-14); others need field.tracking.read (the DB checks the scope). */
export function canOpenDay(ctx: UserContext, employeeId: string): boolean {
  return (ctx.active && ctx.employee?.id === employeeId) || canReadTracking(ctx);
}

/** Command error codes with a tracking-specific message under `tracking.errors.*`. */
export const TRACKING_ERROR_CODES = ["NOTICE_REQUIRED", "NOTICE_OUTDATED", "SHIFT_OPEN", "NO_OPEN_SHIFT", "NO_EMPLOYEE_PROFILE"] as const;
export type TrackingErrorCode = (typeof TRACKING_ERROR_CODES)[number];

export function trackingErrorCode(code: string | undefined): TrackingErrorCode | null {
  return (TRACKING_ERROR_CODES as readonly string[]).includes(code ?? "") ? (code as TrackingErrorCode) : null;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** "Open in Google Maps" (no map library, no new dependency). */
export function mapsUrl(lat: number | string, lng: number | string): string {
  const f = (v: number | string) => Number(v).toFixed(6);
  return `https://www.google.com/maps?q=${f(lat)},${f(lng)}`;
}

/** Whole hours and minutes of a duration in seconds (negative → 0). */
export function durationParts(seconds: number | null | undefined): { h: number; m: number } {
  const total = Math.max(0, Math.round(Number(seconds ?? 0) / 60));
  return { h: Math.floor(total / 60), m: total % 60 };
}

export function minutesOf(seconds: number | null | undefined): number {
  return Math.max(0, Math.round(Number(seconds ?? 0) / 60));
}

/** Metres (numeric from PostgREST may be a string) → kilometres. */
export function kilometres(metres: number | string | null | undefined): number {
  const n = Number(metres ?? 0);
  return Number.isFinite(n) ? Math.max(0, n) / 1000 : 0;
}

/** Known day flags only (unknown values from a newer server are ignored). */
export function dayFlags(flags: readonly string[] | null | undefined): (typeof DAY_FLAGS)[number][] {
  return DAY_FLAGS.filter((f) => (flags ?? []).includes(f));
}

/** A team row the manager should look at: an idle stop, a gap, an anomaly or an auto-closed day. */
export function isRowFlagged(row: Pick<TeamDayRow, "flags">): boolean {
  return dayFlags(row.flags).length > 0;
}

/** Flagged rows first, then by name. */
export function sortTeamRows(rows: TeamDayRow[], locale: string): TeamDayRow[] {
  const name = (r: TeamDayRow) => (locale === "ar" && r.full_name_ar ? r.full_name_ar : r.full_name_en);
  return [...rows].sort((a, b) => Number(isRowFlagged(b)) - Number(isRowFlagged(a)) || name(a).localeCompare(name(b), locale));
}

export type TimelineEntry =
  | { kind: "shift_start"; at: string; shift: DayShift }
  | { kind: "shift_end"; at: string; shift: DayShift }
  | { kind: "visit"; at: string; visit: DayVisit }
  | { kind: "stop"; at: string; stop: DayStop }
  | { kind: "gap"; at: string; gap: DayGap };

const KIND_ORDER: Record<TimelineEntry["kind"], number> = { shift_start: 0, visit: 1, stop: 2, gap: 3, shift_end: 4 };

/** The day in time order: shift start → visits, stops and gaps → shift end. */
export function buildTimeline(day: Pick<TrackingDay, "shifts" | "visits" | "stops" | "gaps">): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const shift of day.shifts ?? []) {
    entries.push({ kind: "shift_start", at: shift.start_at, shift });
    if (!shift.open) entries.push({ kind: "shift_end", at: shift.end_at, shift });
  }
  for (const visit of day.visits ?? []) entries.push({ kind: "visit", at: visit.start_at, visit });
  for (const stop of day.stops ?? []) entries.push({ kind: "stop", at: stop.start_at, stop });
  for (const gap of day.gaps ?? []) entries.push({ kind: "gap", at: gap.start_at, gap });
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** The six figures at the top of the day page. */
export interface DayFigures {
  shift_seconds: number;
  visit_count: number;
  visit_seconds: number;
  idle_stop_seconds: number;
  gap_seconds: number;
  distance_m: number | string;
  ping_count: number;
}

/** What the day page renders (api.tracking_day → page). */
export interface DayView {
  /** The purge summarized this day: stored figures only, labelled as such (audit 3, M7). */
  summaryOnly: boolean;
  /** Past retention with no stored summary: no point was kept for this day. */
  purgedWithoutSummary: boolean;
  figures: DayFigures;
  flags: (typeof DAY_FLAGS)[number][];
  timeline: TimelineEntry[];
  points: DayPoint[];
  /** The list stops at the server's limit; `figures.ping_count` counts every point. */
  pointsTruncated: boolean;
}

const asNumber = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Chooses between the live day and the stored summary. Once the retention purge has
 * summarized a day, recomputing it from the remaining shifts would report the whole shift
 * as one gap, so the stored figures and flags are shown instead, with no stops, gaps or
 * points (the server already does this; the page follows `summary_only`, or falls back to
 * "purged and summarized" for an older server).
 */
export function dayView(
  day: Pick<
    TrackingDay,
    | "shifts" | "visits" | "stops" | "gaps" | "points" | "flags" | "raw_purged" | "stored_summary" | "summary_only" | "points_truncated"
    | "shift_seconds" | "visit_count" | "visit_seconds" | "idle_stop_seconds" | "gap_seconds" | "distance_m" | "ping_count"
  >,
): DayView {
  const summary = day.stored_summary ?? null;
  const summaryOnly = day.summary_only ?? (day.raw_purged && summary !== null);
  if (summaryOnly && summary) {
    const flags = Array.isArray(summary.flags) ? (summary.flags as unknown[]).filter((f): f is string => typeof f === "string") : day.flags;
    return {
      summaryOnly: true,
      purgedWithoutSummary: false,
      figures: {
        shift_seconds: asNumber(summary.shift_seconds, day.shift_seconds),
        visit_count: asNumber(summary.visit_count, day.visit_count),
        visit_seconds: asNumber(summary.visit_seconds, day.visit_seconds),
        idle_stop_seconds: asNumber(summary.idle_stop_seconds, day.idle_stop_seconds),
        gap_seconds: asNumber(summary.gap_seconds, day.gap_seconds),
        distance_m: asNumber(summary.distance_m, Number(day.distance_m)),
        ping_count: asNumber(summary.ping_count, day.ping_count),
      },
      flags: dayFlags(flags),
      timeline: buildTimeline({ shifts: day.shifts, visits: day.visits, stops: [], gaps: [] }),
      points: [],
      pointsTruncated: false,
    };
  }
  return {
    summaryOnly: false,
    purgedWithoutSummary: day.raw_purged && summary === null,
    figures: {
      shift_seconds: day.shift_seconds,
      visit_count: day.visit_count,
      visit_seconds: day.visit_seconds,
      idle_stop_seconds: day.idle_stop_seconds,
      gap_seconds: day.gap_seconds,
      distance_m: day.distance_m,
      ping_count: day.ping_count,
    },
    flags: dayFlags(day.flags),
    timeline: buildTimeline(day),
    points: day.points ?? [],
    pointsTruncated: day.points_truncated === true || (day.points ?? []).length < day.ping_count,
  };
}

export function noticeBody(notice: TrackingNotice, locale: string): string {
  return locale === "ar" ? notice.body_ar : notice.body_en;
}

/** The notice text is plain paragraphs separated by blank lines. */
export function noticeParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Days (the Cairo calendar day, never the UTC one)
// ---------------------------------------------------------------------------

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A valid "YYYY-MM-DD" or null. */
export function parseDay(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string" || !DAY.test(v)) return null;
  return zonedLocalToInstant(v) ? v : null;
}

export function cairoToday(now: Date = new Date()): string {
  return cairoDate(now);
}

/** The Cairo day `delta` days from `day` (noon arithmetic, safe across DST changes). */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const noon = Date.UTC(y, m - 1, d, 12) + delta * 86_400_000;
  return new Date(noon).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The device side: shift state, sampling, batching
// ---------------------------------------------------------------------------

/** What this device remembers about the rep's open shift (localStorage, per user). */
export interface LocalShift {
  /** The device ref of api.start_shift (also its queue item id). */
  ref: string;
  /** Window start (device time of the start, or the server's window_start once confirmed). */
  startedAt: string;
  /** No point is collected after this (the server closes the shift). */
  maxEndAt: string;
  /** The server has the shift (the start was sent, or the status shows it). */
  confirmed: boolean;
  /** Device ms when it was confirmed; a status read started before that is stale. */
  confirmedAtMs: number | null;
  /** Server shift id, when known. */
  serverId: string | null;
  /** The server says it is past its maximum length. */
  overdue: boolean;
}

export interface EndedShift {
  ref: string;
  atMs: number;
}

/**
 * Merges what the server says (api.my_tracking_status) into the device's view:
 * - the server has an open shift → follow it, unless this device already ended it
 *   (the end is still waiting to sync);
 * - the server has none and the device's shift was confirmed → it ended elsewhere or
 *   was auto-closed: forget it, unless the read started before the confirmation;
 * - an unconfirmed (offline-queued) start is kept until its maximum length.
 */
export function reconcileShift(
  local: LocalShift | null,
  server: OpenShift | null,
  opts: { fetchedAtMs: number; nowMs: number; lastEnded: EndedShift | null },
): LocalShift | null {
  if (server) {
    if (opts.lastEnded?.ref === server.client_ref) return local?.ref === server.client_ref ? null : local;
    const same = local?.ref === server.client_ref;
    return {
      ref: server.client_ref,
      startedAt: server.window_start,
      maxEndAt: server.max_end_at,
      confirmed: true,
      confirmedAtMs: same && local?.confirmedAtMs != null ? local.confirmedAtMs : opts.fetchedAtMs,
      serverId: server.id,
      overdue: server.overdue,
    };
  }
  if (!local) return null;
  if (local.confirmed) return (local.confirmedAtMs ?? 0) > opts.fetchedAtMs ? local : null;
  return opts.nowMs < Date.parse(local.maxEndAt) ? local : null;
}

/** Points are collected only while a shift is open and under its maximum length. */
export function isCollecting(shift: LocalShift | null, nowMs: number): boolean {
  return shift !== null && !shift.overdue && nowMs < Date.parse(shift.maxEndAt);
}

/** Seconds on shift so far (capped at the maximum length). */
export function elapsedSeconds(shift: Pick<LocalShift, "startedAt" | "maxEndAt">, nowMs: number): number {
  const end = Math.min(nowMs, Date.parse(shift.maxEndAt));
  return Math.max(0, Math.floor((end - Date.parse(shift.startedAt)) / 1000));
}

/** Keep a position when none was kept yet or the sampling interval has passed (small slack for timer drift). */
export function shouldSample(lastSampleMs: number | null, nowMs: number, intervalMs: number, slackMs = 10_000): boolean {
  return lastSampleMs === null || nowMs - lastSampleMs >= Math.max(0, intervalMs - slackMs);
}

export const BATCH = { size: 3, maxAgeMs: 10 * 60_000 } as const;

/** Move buffered points into the upload queue: enough of them, or the oldest has waited long enough. */
export function shouldFlush(buffer: readonly PingInput[], nowMs: number, opts: { size: number; maxAgeMs: number } = BATCH): boolean {
  if (buffer.length === 0) return false;
  if (buffer.length >= opts.size) return true;
  return nowMs - Date.parse(buffer[0]!.captured_at) >= opts.maxAgeMs;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
  return out;
}

/** numeric(9,6) / numeric(8,1) on the server: round on the device so a replay sends identical values. */
export function toPing(input: { id: string; lat: number; lng: number; accuracy: number | null; timestampMs: number }): PingInput {
  return {
    id: input.id,
    lat: Math.round(input.lat * 1e6) / 1e6,
    lng: Math.round(input.lng * 1e6) / 1e6,
    accuracy_m: input.accuracy === null || !Number.isFinite(input.accuracy) ? null : Math.min(Math.round(input.accuracy * 10) / 10, 9_999_999.9),
    captured_at: new Date(input.timestampMs).toISOString(),
    source: "pwa",
  };
}

// ---------------------------------------------------------------------------
// Offline queue: send now or save on the device (same policy as the field module)
// ---------------------------------------------------------------------------

/**
 * Tracking commands the offline queue may replay; all idempotent on a key the
 * device fixes before the first send:
 * - start: p_client_ref (the item id); end: its own p_client_ref (the item id);
 * - points: every point id (a replay answers `duplicates` / `replayed: true`).
 * Items of one shift share the group `tracking:<start ref>`, so they apply in order.
 */
export const TRACKING_QUEUED_COMMANDS = {
  startShift: "tracking.start_shift",
  endShift: "tracking.end_shift",
  recordPings: "tracking.record_pings",
} as const;
export type TrackingQueuedCommand = (typeof TRACKING_QUEUED_COMMANDS)[keyof typeof TRACKING_QUEUED_COMMANDS];

export const shiftGroup = (ref: string) => `tracking:${ref}`;

export interface TrackingCommand {
  command: TrackingQueuedCommand;
  id: string;
  args: JsonObject;
  groupKey: string | null;
  summary?: string | null;
}

export interface TrackingQueue {
  list(): Promise<QueueItem[]>;
  enqueue(input: EnqueueInput): Promise<QueueItem>;
}

export type TrackingSubmit<T> =
  | { kind: "sent"; data: T }
  | { kind: "queued"; item: QueueItem }
  | { kind: "error"; code: string; messageKey: TranslatedCode; requestId?: string };

/**
 * Online: send now; a failure that is safe to repeat (no answer, rolled back) is
 * saved for the queue. Offline, or behind an unresolved earlier item of the same
 * shift: saved. A business error (notice, open shift, permission) is returned and
 * never queued. No usable queue: direct send only.
 */
export async function submitTrackingCommand<T>(
  cmd: TrackingCommand,
  deps: { online: boolean; queue: TrackingQueue | null; send: () => Promise<DeviceResult<T>> },
): Promise<TrackingSubmit<T>> {
  let queue = deps.queue;
  let items: QueueItem[] = [];
  if (queue) {
    try {
      items = await queue.list();
    } catch {
      queue = null;
    }
  }
  const unavailable = (): TrackingSubmit<T> => ({ kind: "error", code: "UNAVAILABLE", messageKey: "UNAVAILABLE" });
  const save = async (): Promise<TrackingSubmit<T>> => {
    if (!queue) return unavailable();
    try {
      return { kind: "queued", item: await queue.enqueue({ command: cmd.command, id: cmd.id, args: cmd.args, groupKey: cmd.groupKey, summary: cmd.summary ?? null }) };
    } catch {
      return unavailable();
    }
  };

  const existing = items.find((i) => i.id === cmd.id);
  if (existing) return existing.status === "done" ? { kind: "sent", data: existing.result as T } : { kind: "queued", item: existing };
  if (cmd.groupKey && items.some((i) => i.groupKey === cmd.groupKey && i.status !== "done")) return save();
  if (!deps.online && queue) return save();

  let result: DeviceResult<T>;
  try {
    result = await deps.send();
  } catch {
    return save();
  }
  if (result.ok) return { kind: "sent", data: result.data };
  if (result.retryable) return save();
  return { kind: "error", code: result.code, messageKey: result.messageKey, requestId: result.requestId };
}

/** A tracking action's answer → what a queue sender returns (UNAVAILABLE = outcome unknown → ambiguous). */
export function trackingToSendResult(result: DeviceResult<unknown>): SendResult {
  if (result.ok) return { ok: true, data: (result.data ?? null) as Json };
  const unknownOutcome = result.code === "UNAVAILABLE";
  return {
    ok: false,
    error: {
      code: result.code,
      messageKey: result.messageKey,
      retryable: result.retryable && !unknownOutcome,
      ambiguous: unknownOutcome,
      ...(result.requestId ? { requestId: result.requestId } : {}),
    },
  };
}
