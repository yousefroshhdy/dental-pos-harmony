/** Date-time display for approvals and notifications: Cairo time, Latin digits (same as the EGP number format). */
export const CAIRO_DATE_TIME = {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Africa/Cairo",
  numberingSystem: "latn",
} as const;

/** Plain numbers (quantities, metres, percentages) with Latin digits. */
export const LATN_NUMBER = { numberingSystem: "latn", maximumFractionDigits: 2 } as const;
