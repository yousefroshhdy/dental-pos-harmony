import { can, type UserContext } from "@/lib/authz/can";
import type { TranslatedCode } from "@/lib/errors";
import type { EnqueueInput } from "@/lib/offline/queue";
import type { Json, JsonObject, QueueItem, SendResult } from "@/lib/offline/types";
import {
  EXCEPTION_ELIGIBLE,
  VERIFICATION_STATUSES,
  type CheckInResult,
  type DeviceResult,
  type TaskRow,
  type TodayItem,
  type VerificationStatus,
  type VisitRow,
  type VisitStatus,
} from "./types";

/**
 * Pure logic for the rep's day (Today, visits, tasks). UI gating here is
 * cosmetic: Postgres re-checks every command (docs/AUTHORIZATION.md §5).
 */

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export const CAIRO_TZ = "Africa/Cairo";

// ---------------------------------------------------------------------------
// Time: the business day is the Cairo calendar day (DB: v_my_today, docs/DATABASE.md §1)
// ---------------------------------------------------------------------------

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(instantMs: number, timeZone: string): WallClock {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(instantMs)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Offset of `timeZone` from UTC at an instant, in ms (Cairo: +2 h, +3 h in summer). */
function offsetMs(instantMs: number, timeZone: string): number {
  const w = wallClock(instantMs, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

/**
 * A wall-clock time in `timeZone` ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm", the
 * value of <input type="date|datetime-local">) → the instant it names.
 * Returns null for malformed input. A time skipped by a DST change resolves
 * to the instant after the gap.
 */
export function zonedLocalToInstant(local: string, timeZone: string = CAIRO_TZ): Date | null {
  const m = LOCAL_INPUT.exec(local.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4] ?? "0");
  const minute = Number(m[5] ?? "0");
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(asUtc);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) return null; // e.g. 31 Feb
  const first = offsetMs(asUtc, timeZone);
  let t = asUtc - first;
  const second = offsetMs(t, timeZone);
  if (second !== first) t = asUtc - second;
  return new Date(t);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The Cairo calendar date of an instant, "YYYY-MM-DD". */
export function cairoDate(instant: Date): string {
  const w = wallClock(instant.getTime(), CAIRO_TZ);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** An instant as a Cairo <input type="datetime-local"> value, "YYYY-MM-DDTHH:mm". */
export function toCairoLocalInput(instant: Date): string {
  const w = wallClock(instant.getTime(), CAIRO_TZ);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** [start, end) of the Cairo day containing `now`, as instants. */
export function cairoDayBounds(now: Date): { start: Date; end: Date } {
  const today = cairoDate(now);
  const start = zonedLocalToInstant(today) as Date;
  // Noon of the next calendar day is always on the next Cairo date, whatever the DST offset.
  const tomorrow = cairoDate(new Date(start.getTime() + 36 * 3600 * 1000));
  return { start, end: zonedLocalToInstant(tomorrow) as Date };
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

export function verificationTone(status: VerificationStatus): BadgeTone {
  switch (status) {
    case "verified":
    case "exception_approved":
      return "success";
    case "out_of_range":
    case "exception_rejected":
      return "danger";
    case "low_accuracy":
    case "no_customer_location":
    case "no_device_location":
      return "warning";
    case "exception_requested":
      return "info";
    default:
      return "neutral";
  }
}

export function visitStatusTone(status: VisitStatus): BadgeTone {
  switch (status) {
    case "completed":
      return "success";
    case "in_progress":
      return "info";
    case "missed":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

/** The verdict needs a manager-approved exception to count (api.request_visit_exception). */
export function needsException(status: VerificationStatus): boolean {
  return (EXCEPTION_ELIGIBLE as readonly string[]).includes(status);
}

/** Show "request exception" for this visit. The DB re-checks permission, scope and state. */
export function canRequestException(
  ctx: UserContext,
  visit: Pick<VisitRow, "employee_id" | "status" | "verification_status">,
): boolean {
  if (!needsException(visit.verification_status)) return false;
  if (visit.status !== "in_progress" && visit.status !== "completed") return false;
  if (!can(ctx, "field.visit_exception.request")) return false;
  // Own scope covers only the caller's visits; wider scopes are checked by the DB.
  return visit.employee_id === ctx.employee?.id || can(ctx, "field.visit_exception.request", "team");
}

/** Only the visiting representative can check out (api.visit_check_out). */
export function canCheckOut(ctx: UserContext, visit: Pick<VisitRow, "employee_id" | "status">): boolean {
  return visit.status === "in_progress" && can(ctx, "field.visit.create") && visit.employee_id === ctx.employee?.id;
}

/** numeric from PostgREST → whole metres, or null. */
export function toMetres(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

export interface TodayGroups {
  /** Visits still in progress (need a check-out), oldest first. */
  inProgress: TodayItem[];
  /** Visits planned for today, not yet started. */
  planned: TodayItem[];
  /** Open follow-up tasks due today or overdue, overdue first. */
  followUps: TodayItem[];
  /** Other open tasks due today or overdue, overdue first. */
  tasks: TodayItem[];
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function byDue(a: TodayItem, b: TodayItem): number {
  if (a.is_overdue !== b.is_overdue) return a.is_overdue ? -1 : 1;
  const pa = PRIORITY_RANK[a.priority ?? "normal"] ?? 2;
  const pb = PRIORITY_RANK[b.priority ?? "normal"] ?? 2;
  if (pa !== pb) return pa - pb;
  return (a.due_at ?? "").localeCompare(b.due_at ?? "");
}

export function groupToday(items: TodayItem[]): TodayGroups {
  const groups: TodayGroups = { inProgress: [], planned: [], followUps: [], tasks: [] };
  for (const item of items) {
    if (item.item_type === "visit") {
      if (item.status === "in_progress") groups.inProgress.push(item);
      else if (item.status === "planned") groups.planned.push(item);
    } else if (item.kind === "follow_up") groups.followUps.push(item);
    else groups.tasks.push(item);
  }
  groups.inProgress.sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? ""));
  groups.planned.sort((a, b) => (a.customer_name ?? a.title).localeCompare(b.customer_name ?? b.title));
  groups.followUps.sort(byDue);
  groups.tasks.sort(byDue);
  return groups;
}

/** /today needs either part of the rep's day. */
export function canSeeToday(ctx: UserContext): boolean {
  return can(ctx, "field.visit.create") || can(ctx, "work.task.read");
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const TASK_WHO = ["mine", "all"] as const;
export const TASK_DUE = ["any", "today", "overdue"] as const;
export const TASK_STATUS_FILTER = ["open", "done"] as const;

export interface TaskFilters {
  who: (typeof TASK_WHO)[number];
  due: (typeof TASK_DUE)[number];
  status: (typeof TASK_STATUS_FILTER)[number];
}

function pick<T extends readonly string[]>(allowed: T, value: unknown, fallback: T[number]): T[number] {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T[number]) : fallback;
}

/** Search params → task filters; unknown values fall back to the defaults (mine, any, open). */
export function parseTaskFilters(params: Record<string, string | string[] | undefined>): TaskFilters {
  const status = pick(TASK_STATUS_FILTER, params.status, "open");
  const due = pick(TASK_DUE, params.due, "any");
  // "Overdue" only exists for open tasks.
  return { who: pick(TASK_WHO, params.who, "mine"), due: status === "done" && due === "overdue" ? "any" : due, status };
}

/** Query string for a filter link, omitting defaults. */
export function taskFilterHref(filters: TaskFilters, change: Partial<TaskFilters>): string {
  const next = { ...filters, ...change };
  const qs = new URLSearchParams();
  if (next.who !== "mine") qs.set("who", next.who);
  if (next.due !== "any") qs.set("due", next.due);
  if (next.status !== "open") qs.set("status", next.status);
  const s = qs.toString();
  return s ? `/tasks?${s}` : "/tasks";
}

/** Only a wider-than-own read scope can see other people's tasks. */
export function canSeeOthersTasks(ctx: UserContext): boolean {
  return can(ctx, "work.task.read", "team");
}

export function canCompleteTask(ctx: UserContext, task: Pick<TaskRow, "status" | "assignee_employee_id">): boolean {
  if (task.status !== "open" || !can(ctx, "work.task.manage")) return false;
  return task.assignee_employee_id === ctx.employee?.id || can(ctx, "work.task.manage", "team");
}

export function taskTone(task: Pick<TaskRow, "status" | "is_overdue">): BadgeTone {
  if (task.status === "done") return "success";
  if (task.status === "cancelled") return "neutral";
  return task.is_overdue ? "danger" : "info";
}

export function priorityTone(priority: string | null): BadgeTone {
  return priority === "urgent" ? "danger" : priority === "high" ? "warning" : "neutral";
}

/** Command error codes with a field-specific message under `field.errors.*` (others use the shared `errors.*`). */
export const FIELD_ERROR_CODES = ["NO_EMPLOYEE_PROFILE", "WORKFLOW_MISSING"] as const;
export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

export function fieldErrorCode(code: string | undefined): FieldErrorCode | null {
  return (FIELD_ERROR_CODES as readonly string[]).includes(code ?? "") ? (code as FieldErrorCode) : null;
}

/** Strip characters with a meaning in PostgREST filters or LIKE patterns from a search term. */
export function sanitizeSearch(q: string): string {
  return q.replace(/[%_*,()\\:"'.]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Name in the viewer's locale, falling back to English. */
export function localizedName(locale: string, en: string | null | undefined, ar: string | null | undefined): string {
  if (locale === "ar" && ar) return ar;
  return en ?? ar ?? "";
}

// ---------------------------------------------------------------------------
// Offline: send now or save on the device (docs/ARCHITECTURE.md §6)
// ---------------------------------------------------------------------------

/**
 * Field commands the offline queue may replay. Each is idempotent on a key the
 * device fixes before the first attempt, so a replay answers `replayed: true`
 * and never applies twice:
 * - check-in: the visit id (a check_in location event exists → replay);
 * - check-out: the visit id (a check_out location event exists → replay);
 * - task completion: the task id (status done → replay).
 * The visit exception request is NOT queued (see device.ts). The ids double as
 * the labels under `offline.commands.*`.
 */
export const FIELD_QUEUED_COMMANDS = {
  checkIn: "field.visit_check_in",
  checkOut: "field.visit_check_out",
  completeTask: "work.complete_task",
} as const;
export type FieldQueuedCommand = (typeof FIELD_QUEUED_COMMANDS)[keyof typeof FIELD_QUEUED_COMMANDS];

/** 32-bit FNV-1a. */
function fnv1a(text: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A stable, name-based id in UUID format (RFC 9562 version 8, "custom"): the same
 * name always gives the same id, so saving the same command twice on this device
 * stores one queue item. Not a security token; it never leaves the device.
 */
export function nameBasedId(name: string): string {
  const hex = [0, 1, 2, 3].map((seed) => fnv1a(`${seed}|${name}`, seed).toString(16).padStart(8, "0")).join("");
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  const h = `${hex.slice(0, 12)}8${hex.slice(13, 16)}${variant}${hex.slice(17)}`;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * The queue item id of a field command. A check-in's item id IS its visit id
 * (the command's client ref). Check-out shares that visit id, so its item id is
 * derived from it; task completion derives one from the task id. The senders
 * always send the payload's own ids, never the item id.
 */
export function deviceQueueId(command: FieldQueuedCommand, key: string): string {
  return command === FIELD_QUEUED_COMMANDS.checkIn ? key : nameBasedId(`${command}:${key}`);
}

/** One field command as the device fixed it before the first attempt. */
export interface DeviceCommand {
  command: FieldQueuedCommand;
  /** Queue item id (see deviceQueueId). */
  id: string;
  /** The exact payload of the server action (ids, GPS fix and device time included). */
  args: JsonObject;
  /** Commands on one visit (check-in, then check-out) apply strictly in order. */
  groupKey: string | null;
  /** Synthetic, human summary for the sync screen (e.g. the clinic name). */
  summary?: string | null;
}

/** The part of the sync engine the decision needs (a SyncEngine satisfies it). */
export interface DeviceQueue {
  list(): Promise<QueueItem[]>;
  enqueue(input: EnqueueInput): Promise<QueueItem>;
}

export type QueueReason =
  /** The device is offline. */
  | "offline"
  /** The request failed in a way that is safe to repeat (connection lost, rolled back). */
  | "network"
  /** An earlier command on the same visit still waits in the queue. */
  | "ordered"
  /** This very command was already saved on this device. */
  | "already_saved";

export type SubmitOutcome<T> =
  | { kind: "sent"; data: T }
  | { kind: "queued"; item: QueueItem; reason: QueueReason }
  | { kind: "error"; code: string; messageKey: TranslatedCode; requestId?: string; retryable: boolean };

/**
 * Send a field command now, or save it on the device for the sync engine.
 *
 * - Already saved (same item id): never sent again from here; a synced one
 *   answers with its saved server result.
 * - An unresolved earlier command on the same visit: queued behind it (order).
 * - Offline: queued.
 * - Online: sent directly. A failure that is safe to repeat — the request threw
 *   (connection lost, outcome unknown) or the action says `retryable`
 *   (UNAVAILABLE, rolled back) — is queued: the command is idempotent on its
 *   key, so the replay applies at most once. A business error (validation,
 *   permission, state) goes back to the caller and is NEVER queued.
 * - No usable queue (no IndexedDB, server render): direct send only.
 */
export async function submitDeviceCommand<T>(
  cmd: DeviceCommand,
  deps: { online: boolean; queue: DeviceQueue | null; send: () => Promise<DeviceResult<T>> },
): Promise<SubmitOutcome<T>> {
  let queue = deps.queue;
  let items: QueueItem[] = [];
  if (queue) {
    try {
      items = await queue.list();
    } catch {
      queue = null; // offline storage is broken on this device: behave as online-only
    }
  }

  const unavailable = (): SubmitOutcome<T> => ({ kind: "error", code: "UNAVAILABLE", messageKey: "UNAVAILABLE", retryable: true });
  const save = async (reason: QueueReason): Promise<SubmitOutcome<T>> => {
    if (!queue) return unavailable();
    try {
      const item = await queue.enqueue({ command: cmd.command, id: cmd.id, args: cmd.args, groupKey: cmd.groupKey, summary: cmd.summary ?? null });
      return { kind: "queued", item, reason };
    } catch {
      return unavailable(); // could not store it: the caller keeps the payload for a manual retry
    }
  };

  const existing = items.find((i) => i.id === cmd.id);
  if (existing) {
    if (existing.status === "done") return { kind: "sent", data: existing.result as T };
    return { kind: "queued", item: existing, reason: "already_saved" };
  }
  if (cmd.groupKey && items.some((i) => i.groupKey === cmd.groupKey && i.status !== "done")) return save("ordered");
  if (!deps.online && queue) return save("offline");

  let result: DeviceResult<T>;
  try {
    result = await deps.send();
  } catch {
    // A server action rejects when the request got no answer (offline, connection dropped).
    return save("network");
  }
  if (result.ok) return { kind: "sent", data: result.data };
  if (result.retryable) return save("network");
  return { kind: "error", code: result.code, messageKey: result.messageKey, requestId: result.requestId, retryable: false };
}

/**
 * A field server action's answer → what a queue sender returns. UNAVAILABLE
 * means the outcome is unknown (the database connection was lost): `ambiguous`,
 * which the engine re-sends only because the field senders are idempotent.
 */
export function deviceToSendResult(result: DeviceResult<unknown>): SendResult {
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

/** A synced check-in item's stored server answer, if it has the shape of api.visit_check_in's result. */
export function asCheckInResult(value: Json | null | undefined): CheckInResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (typeof value.visit_id !== "string") return null;
  if (!(VERIFICATION_STATUSES as readonly unknown[]).includes(value.verification_status)) return null;
  return value as unknown as CheckInResult;
}

/** /visits/[id]?checkedOut=… after a check-out: selects the confirmation text. */
export function checkedOutParam(result: Json | null | undefined): "followUp" | "1" {
  const isObject = typeof result === "object" && result !== null && !Array.isArray(result);
  return isObject && typeof result.follow_up_task_id === "string" ? "followUp" : "1";
}

export type QueuedView = "none" | "waiting" | "synced" | "attention";

/** What a field screen shows for a saved command: waiting, synced, or needs a decision on the sync screen. */
export function queuedView(item: QueueItem | undefined | null): QueuedView {
  if (!item) return "none";
  if (item.status === "done") return "synced";
  if (item.status === "failed" || item.status === "conflict") return "attention";
  if (item.flag === "stale" && !item.staleAcknowledged) return "attention";
  return "waiting";
}
