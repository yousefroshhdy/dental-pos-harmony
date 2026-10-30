/** Date display for returns: Cairo time, Latin digits (same as the EGP number format). */
export const CAIRO_DATE_TIME = {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Africa/Cairo",
  numberingSystem: "latn",
} as const;

export const CAIRO_DATE = { dateStyle: "medium", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/**
 * A calendar date column (YYYY-MM-DD, e.g. a lot's expiry) as a Date at noon UTC,
 * so formatting it in Africa/Cairo never shifts it to the previous or next day.
 */
export function dateOnly(value: string): Date {
  return new Date(`${value.slice(0, 10)}T12:00:00Z`);
}

export const QUANTITY = { maximumFractionDigits: 0, numberingSystem: "latn" } as const;
