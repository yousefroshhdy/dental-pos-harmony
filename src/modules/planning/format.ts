/** Display formats: Cairo time, Latin digits (D-11). */
export const DAY_SHORT = { weekday: "short", day: "numeric", month: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;
export const DAY_LONG = { dateStyle: "full", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;
export const DAY_MEDIUM = { dateStyle: "medium", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;
export const MONTH_LONG = { month: "long", year: "numeric", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/** A "YYYY-MM-DD" day as a Date at 10:00 UTC (noon in Cairo), so it formats as that calendar day. */
export function dayAsDate(day: string): Date {
  return new Date(`${day}T10:00:00Z`);
}
