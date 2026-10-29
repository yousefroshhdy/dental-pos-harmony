/** Date-time display: Cairo time, Latin digits (same as the EGP number format). */
export const CAIRO_DATE_TIME = {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Africa/Cairo",
  numberingSystem: "latn",
} as const;

export const CAIRO_DATE = { dateStyle: "medium", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

export const CAIRO_TIME = { timeStyle: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

export const METRES = { style: "unit", unit: "meter", maximumFractionDigits: 0, numberingSystem: "latn" } as const;

/** A `date` column ("YYYY-MM-DD") as a Date at Cairo noon, so it formats as the same calendar day. */
export function dateOnly(value: string): Date {
  return new Date(`${value}T10:00:00Z`);
}
