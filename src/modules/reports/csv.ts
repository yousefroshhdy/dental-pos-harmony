/**
 * CSV encoding for exports (pure, no I/O).
 *
 * - UTF-8 with a byte-order mark, so Excel opens Arabic text correctly.
 * - CRLF line endings and RFC 4180 quoting.
 * - Formula-injection guard: a text cell that starts with `=`, `+`, `-`, `@`,
 *   tab or CR gets a leading `'`, so a spreadsheet shows it as text instead of
 *   running it (OWASP "CSV injection"). Numbers this module formats itself are
 *   not text and are left alone, so `-12.50` stays a number.
 */

export const BOM = "﻿";
export const CRLF = "\r\n";

/** A number formatted by this module; never formula-guarded. */
export class CsvNumber {
  private constructor(readonly text: string) {}

  private static readonly PATTERN = /^-?\d+(\.\d+)?$/;

  /** Null for anything that is not a finite number (or a plain decimal string). */
  static of(value: unknown, decimals: number | null): CsvNumber | null {
    if (value === null || value === undefined || value === "") return null;
    let n: number;
    if (typeof value === "number") n = value;
    else if (typeof value === "string" && CsvNumber.PATTERN.test(value.trim())) n = Number(value.trim());
    else return null;
    if (!Number.isFinite(n)) return null;
    if (decimals === null) return new CsvNumber(String(n));
    const fixed = n.toFixed(decimals);
    // "-0.00" → "0.00"
    return new CsvNumber(/^-0(\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed);
  }
}

export type CsvValue = string | number | boolean | CsvNumber | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** Prefixes `'` to text a spreadsheet would read as a formula. */
export function neutralizeFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** One RFC 4180 field. */
export function csvCell(value: CsvValue): string {
  let text: string;
  if (value === null || value === undefined) return "";
  if (value instanceof CsvNumber) text = value.text;
  else if (typeof value === "number") text = Number.isFinite(value) ? String(value) : "";
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else text = neutralizeFormula(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV record, CRLF-terminated. */
export function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvCell).join(",") + CRLF;
}

/** A whole document (BOM + header + rows), for tests and small exports. */
export function csvDocument(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  return BOM + csvRow(header) + rows.map(csvRow).join("");
}

// ---------------------------------------------------------------------------
// Value formatting (Africa/Cairo, plain numbers)
// ---------------------------------------------------------------------------

const CAIRO_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Cairo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function cairoParts(date: Date): Record<string, string> {
  return Object.fromEntries(CAIRO_PARTS.formatToParts(date).map((p) => [p.type, p.value]));
}

/**
 * An instant as Cairo wall-clock time, ISO 8601 `YYYY-MM-DD HH:mm:ss`
 * (space separator, which Excel and Sheets read as a date-time). Null for
 * anything that is not a valid timestamp.
 */
export function cairoDateTime(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const p = cairoParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date (`YYYY-MM-DD`) passed through unchanged; null otherwise. */
export function isoDate(value: unknown): string | null {
  return typeof value === "string" && ISO_DATE.test(value) ? value : null;
}

/** Today's business date in Cairo (like core.business_date()). */
export function cairoToday(now: Date = new Date()): string {
  const p = cairoParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Cairo UTC offset at an instant, in minutes (Egypt observes DST). */
function cairoOffsetMinutes(at: Date): number {
  const p = cairoParts(at);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

function ymd(day: string): [number, number, number] {
  const [y = NaN, m = NaN, d = NaN] = day.split("-").map(Number);
  return [y, m, d];
}

/** The instant a Cairo calendar day starts, as an ISO UTC string (for timestamp filters). */
export function cairoDayStartUtc(day: string): string {
  const [y, m, d] = ymd(day);
  const guess = Date.UTC(y, m - 1, d);
  let instant = guess - cairoOffsetMinutes(new Date(guess)) * 60_000;
  // Re-check once in case the offset changes between the guess and the result (DST night).
  instant = guess - cairoOffsetMinutes(new Date(instant)) * 60_000;
  return new Date(instant).toISOString();
}

/** The day after `day` (YYYY-MM-DD). */
export function nextDay(day: string): string {
  const [y, m, d] = ymd(day);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Money as a plain number with 2 decimals (no currency sign, no grouping). */
export const money = (value: unknown) => CsvNumber.of(value, 2);
/** Whole numbers (quantities, counts). */
export const integer = (value: unknown) => CsvNumber.of(value, 0);
/** Any other number, as the database sent it. */
export const decimal = (value: unknown) => CsvNumber.of(value, null);
