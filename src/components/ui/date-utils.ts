/**
 * Calendar-date helpers for the date picker. The app stores business dates as
 * `YYYY-MM-DD` on the Cairo calendar (CLAUDE.md: timestamps shown in Africa/Cairo);
 * the picker converts at the edge so a phone set to another time zone still picks
 * the Cairo date it shows. Digits are always Western (D-11).
 */
export const CAIRO_TZ = "Africa/Cairo";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` → its parts, or null if it is not a real calendar date. */
export function parseIsoDate(value: string | null | undefined): { year: number; month: number; day: number } | null {
  const m = value ? ISO_DATE.exec(value) : null;
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** The Cairo calendar date of an instant, as `YYYY-MM-DD`. */
export function cairoIsoDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CAIRO_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** A calendar date for display ("24 Nov 2026" / "24 نوفمبر 2026"), Western digits. */
export function formatIsoDate(value: string, locale: string, style: "medium" | "long" | "short" = "medium"): string {
  const parts = parseIsoDate(value);
  if (!parts) return value;
  // Noon UTC is the same calendar day in Cairo whatever the DST offset.
  const noon = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
  return new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: CAIRO_TZ, numberingSystem: "latn" }).format(noon);
}

/** True if `value` lies within [min, max] (ISO strings compare as dates). */
export function isoInRange(value: string, min?: string | null, max?: string | null): boolean {
  if (min && value < min) return false;
  if (max && value > max) return false;
  return true;
}
