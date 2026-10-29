/** Display formats for the inventory workspace: Cairo time, Latin digits (same as the EGP number format). */
export const CAIRO_DATE_TIME = {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Africa/Cairo",
  numberingSystem: "latn",
} as const;

/** A calendar date (expiry, YYYY-MM-DD) is shown as written, never shifted by a time zone. */
export const CALENDAR_DATE = { dateStyle: "medium", timeZone: "UTC", numberingSystem: "latn" } as const;

export const QTY = { numberingSystem: "latn", maximumFractionDigits: 0 } as const;
export const SIGNED_QTY = { ...QTY, signDisplay: "exceptZero" } as const;

/** YYYY-MM-DD → Date at UTC midnight, for CALENDAR_DATE. */
export function calendarDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}
