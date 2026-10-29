/** Date-time display for orders: Cairo time, Latin digits (same as the EGP number format). */
export const CAIRO_DATE_TIME = {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Africa/Cairo",
  numberingSystem: "latn",
} as const;

export const CAIRO_DATE = { dateStyle: "medium", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/** Percentages and quantities with Latin digits. */
export const PERCENT = { maximumFractionDigits: 2, numberingSystem: "latn" } as const;
export const QUANTITY = { maximumFractionDigits: 0, numberingSystem: "latn" } as const;
