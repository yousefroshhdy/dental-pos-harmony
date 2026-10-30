import type { createFormatter } from "next-intl";
import { toNumber } from "./logic";
import type { DbNumber } from "./types";

type Formatter = ReturnType<typeof createFormatter>;

/** Latin digits everywhere (same as the EGP number format and the other modules). */
export const CAIRO_DATE = { dateStyle: "medium", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;
export const CAIRO_DATE_TIME = { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;
const MONTH = { month: "long", year: "numeric", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;
const PERCENT = { maximumFractionDigits: 2, minimumFractionDigits: 2, numberingSystem: "latn" } as const;

export function formatEgp(format: Formatter, value: DbNumber | null | undefined): string {
  const n = toNumber(value);
  return n === null ? "—" : format.number(n, "egp");
}

export function formatRate(format: Formatter, value: DbNumber | null | undefined): string {
  const n = toNumber(value);
  return n === null ? "—" : `${format.number(n, PERCENT)}%`;
}

/** "YYYY-MM" (or a YYYY-MM-DD in that month) as "June 2026" / "يونيو 2026". */
export function formatMonth(format: Formatter, key: string): string {
  return format.dateTime(new Date(`${key.slice(0, 7)}-15T12:00:00Z`), MONTH);
}

/** A calendar date (YYYY-MM-DD) shown in Cairo time without shifting the day. */
export function formatDay(format: Formatter, iso: string): string {
  return format.dateTime(new Date(`${iso.slice(0, 10)}T12:00:00Z`), CAIRO_DATE);
}
