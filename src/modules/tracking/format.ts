import { durationParts, kilometres } from "./logic";

/** Display formats: Cairo time, Latin digits (D-11). */
export const CAIRO_TIME = { timeStyle: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;
export const CAIRO_DATE_LONG = { dateStyle: "full", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;
export const CAIRO_DATE_TIME = { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/** A "YYYY-MM-DD" day as a Date at Cairo noon-ish, so it formats as that calendar day. */
export function dayAsDate(day: string): Date {
  return new Date(`${day}T10:00:00Z`);
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** "3 h 05 min" / "25 min" under the `tracking` namespace (`duration.hm`, `duration.m`). */
export function formatDuration(t: Translate, seconds: number | null | undefined): string {
  const { h, m } = durationParts(seconds);
  return h > 0 ? t("duration.hm", { h: String(h), m: String(m).padStart(2, "0") }) : t("duration.m", { m: String(m) });
}

/** "12.4 km" with Latin digits and one decimal. */
export function formatKm(t: Translate, metres: number | string | null | undefined): string {
  const km = kilometres(metres);
  return t("km", { value: km.toFixed(1) });
}
