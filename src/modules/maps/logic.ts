import type { MapTone } from "@/components/map/types";
import type { AppError } from "@/lib/errors";
import { toLatLng, type LatLng } from "@/lib/maps/geo";
import type { LifecycleStage } from "@/modules/crm/types";
import type { DayGap, DayStop, DayVisit, TrackingDay } from "@/modules/tracking/types";
import type { CustomerMapFilters } from "./schemas";
import {
  MAPS_ERROR_CODES,
  type CustomerMapRow,
  type LastVisitFilter,
  type MapsActionResult,
  type MapsErrorCode,
  type TeamLocationRow,
  type VisitFix,
} from "./types";

// ---------------------------------------------------------------------------
// Customers map
// ---------------------------------------------------------------------------

const STAGE_TONE: Record<LifecycleStage, MapTone> = {
  active: "success",
  prospect: "info",
  lead: "warning",
  dormant: "muted",
  lost: "muted",
  blocked: "muted",
};

/** Pin colour: overdue AR wins (red), else the lifecycle stage. */
export function customerTone(row: Pick<CustomerMapRow, "is_overdue" | "lifecycle_stage">): MapTone {
  return row.is_overdue ? "danger" : STAGE_TONE[row.lifecycle_stage] ?? "primary";
}

export type PinnedCustomer = CustomerMapRow & LatLng;

/** Rows with a usable pin, with numeric coordinates. */
export function pinnedCustomers(rows: readonly CustomerMapRow[]): PinnedCustomer[] {
  const out: PinnedCustomer[] = [];
  for (const row of rows) {
    const p = toLatLng(row.latitude, row.longitude);
    if (p) out.push({ ...row, ...p });
  }
  return out;
}

/** YYYY-MM-DD minus `days` (calendar arithmetic on the Cairo date string). */
export function minusDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * The last-visit filter as a PostgREST condition on last_visit_on:
 * "30" → not visited in the last 30 days (or never), "never" → never visited.
 */
export function lastVisitCondition(filter: LastVisitFilter | undefined, today: string): { kind: "never" } | { kind: "before"; day: string } | null {
  if (!filter) return null;
  if (filter === "never") return { kind: "never" };
  return { kind: "before", day: minusDays(today, Number(filter)) };
}

/** Search params for a filter set (only the set ones), for links that keep the filters. */
export function filterQuery(filters: CustomerMapFilters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function activeFilterCount(filters: CustomerMapFilters): number {
  return Object.values(filters).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Team map
// ---------------------------------------------------------------------------

/** Whole minutes since the point (never negative). */
export function minutesSince(iso: string, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
}

/** Fresh ≤ 15 min (about three sampling intervals), stale ≤ 60 min, else old. */
export function freshness(minutes: number): "fresh" | "stale" | "old" {
  if (minutes <= 15) return "fresh";
  if (minutes <= 60) return "stale";
  return "old";
}

export function freshnessTone(minutes: number): MapTone {
  return { fresh: "success", stale: "warning", old: "danger" }[freshness(minutes)] as MapTone;
}

export type TeamPoint = TeamLocationRow & LatLng;

export function teamPoints(rows: readonly TeamLocationRow[]): TeamPoint[] {
  const out: TeamPoint[] = [];
  for (const row of rows) {
    const p = toLatLng(row.latitude, row.longitude);
    if (p) out.push({ ...row, ...p });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rep day map: route, numbered stops and visits, gaps
// ---------------------------------------------------------------------------

export type RouteMark =
  | { n: number; kind: "stop"; at: string; lat: number; lng: number; stop: DayStop }
  | { n: number; kind: "visit"; at: string; lat: number; lng: number; visit: DayVisit | null; fix: VisitFix };

export interface GapHop {
  from: LatLng;
  to: LatLng;
  gap: DayGap;
}

export interface DayRoute {
  /** Continuous pieces of the route (usable points only), split at shifts and gaps. */
  segments: LatLng[][];
  /** A gap inside a shift, drawn as a dashed straight hop between the points around it. */
  hops: GapHop[];
  /** Stops and visit check-ins, numbered together in time order (map labels = legend numbers). */
  marks: RouteMark[];
  /** Visits of the day with no check-in fix (listed, not drawn). */
  visitsWithoutFix: DayVisit[];
  start: LatLng | null;
  end: LatLng | null;
  /** Everything drawn, for fitting the view. */
  extent: LatLng[];
}

type DayInput = Pick<TrackingDay, "points" | "stops" | "gaps" | "visits" | "shifts">;

const ms = (iso: string) => Date.parse(iso);
const byTime = <T>(at: (x: T) => string) => (a: T, b: T) => ms(at(a)) - ms(at(b));

/** The route of one rep's day from api.tracking_day plus api.tracking_day_visit_fixes. */
export function buildDayRoute(day: DayInput, fixes: readonly VisitFix[]): DayRoute {
  const points = (day.points ?? []).filter((p) => p.usable).slice().sort(byTime((p) => p.captured_at));
  const gaps = day.gaps ?? [];
  const segments: LatLng[][] = [];
  const hops: GapHop[] = [];
  let current: LatLng[] = [];
  let prev: (typeof points)[number] | null = null;

  for (const p of points) {
    const here = toLatLng(p.lat, p.lng);
    if (!here) continue;
    if (prev) {
      const prevAt = ms(prev.captured_at);
      const at = ms(p.captured_at);
      const sameShift = prev.shift_id === p.shift_id;
      const gap = sameShift
        ? gaps.find((g) => g.shift_id === p.shift_id && ms(g.start_at) >= prevAt && ms(g.end_at) <= at)
        : undefined;
      if (!sameShift || gap) {
        if (current.length) segments.push(current);
        current = [];
        if (gap) hops.push({ from: toLatLng(prev.lat, prev.lng)!, to: here, gap });
      }
    }
    current.push(here);
    prev = p;
  }
  if (current.length) segments.push(current);

  const visits = new Map((day.visits ?? []).map((v) => [v.id, v]));
  const checkIns = fixes.filter((f) => f.event_type === "check_in");
  const fixed = new Set(checkIns.map((f) => f.visit_id));
  type Unnumbered = RouteMark extends infer M ? (M extends { n: number } ? Omit<M, "n"> : never) : never;
  const unnumbered: Unnumbered[] = [];
  for (const stop of day.stops ?? []) {
    const p = toLatLng(stop.lat, stop.lng);
    if (p) unnumbered.push({ kind: "stop", at: stop.start_at, ...p, stop });
  }
  for (const fix of checkIns) {
    const p = toLatLng(fix.latitude, fix.longitude);
    if (p) unnumbered.push({ kind: "visit", at: fix.captured_at, ...p, visit: visits.get(fix.visit_id) ?? null, fix });
  }
  unnumbered.sort(byTime((m) => m.at));
  const marks = unnumbered.map((m, i) => ({ ...m, n: i + 1 }) as RouteMark);

  const shifts = (day.shifts ?? []).slice().sort(byTime((s) => s.start_at));
  const firstShift = shifts[0];
  const lastShift = shifts[shifts.length - 1];
  const start = firstShift ? toLatLng(firstShift.start_lat, firstShift.start_lng) : null;
  const end = lastShift && !lastShift.open ? toLatLng(lastShift.end_lat, lastShift.end_lng) : null;

  const extent = [...segments.flat(), ...marks.map((m) => ({ lat: m.lat, lng: m.lng })), ...(start ? [start] : []), ...(end ? [end] : [])];
  return {
    segments,
    hops,
    marks,
    visitsWithoutFix: (day.visits ?? []).filter((v) => !fixed.has(v.id)),
    start,
    end,
    extent,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function isMapsErrorCode(code: string): code is MapsErrorCode {
  return (MAPS_ERROR_CODES as readonly string[]).includes(code);
}

export function toMapsFailure(error: AppError): MapsActionResult {
  return {
    ok: false,
    messageKey: error.messageKey,
    ...(isMapsErrorCode(error.code) ? { mapsCode: error.code } : {}),
    requestId: error.requestId,
  };
}
