/** Date-time display for CRM screens: Cairo time, Latin digits (same as the EGP number format). */
export const CAIRO_DATE_TIME = {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Africa/Cairo",
  numberingSystem: "latn",
} as const;

export const CAIRO_DATE = { dateStyle: "medium", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/** EGP amounts (mirrors the `egp` number format in src/i18n/request.ts). */
export const EGP = { style: "currency", currency: "EGP", numberingSystem: "latn" } as const;
