import type { createFormatter } from "next-intl";
import { toNumber, valueFormat } from "./logic";
import type { DbNumber, KpiUnit } from "./types";

type Formatter = ReturnType<typeof createFormatter>;

/** Latin digits everywhere (same as the EGP number format and the other modules). */
const COUNT = { maximumFractionDigits: 0, numberingSystem: "latn" } as const;
const DECIMAL = { maximumFractionDigits: 1, numberingSystem: "latn" } as const;
const PERCENT = { style: "percent", maximumFractionDigits: 1, numberingSystem: "latn" } as const;

export const CAIRO_DATE = { dateStyle: "medium", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;
export const CAIRO_SHORT_DATE = { day: "numeric", month: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/** A KPI value in its unit; NULL (no data / no denominator) is an em dash. */
export function formatKpi(format: Formatter, unit: KpiUnit, value: DbNumber | undefined): string {
  const n = toNumber(value ?? null);
  if (n === null) return "—";
  switch (valueFormat(unit)) {
    case "egp":
      return format.number(n, "egp");
    case "pct":
      return format.number(n / 100, PERCENT);
    case "decimal":
      return format.number(n, DECIMAL);
    default:
      return format.number(n, COUNT);
  }
}

export function formatPercent(format: Formatter, pct: DbNumber | undefined): string {
  const n = toNumber(pct ?? null);
  return n === null ? "—" : format.number(n / 100, PERCENT);
}

/** A calendar date (YYYY-MM-DD) shown in Cairo time. */
export function formatDay(format: Formatter, iso: string, style: "medium" | "short" = "medium"): string {
  return format.dateTime(new Date(`${iso}T12:00:00Z`), style === "short" ? CAIRO_SHORT_DATE : CAIRO_DATE);
}
