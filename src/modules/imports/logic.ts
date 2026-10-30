import { can, type UserContext } from "@/lib/authz/can";
import { parseCsv, toCsv, type CsvError } from "./csv";
import { KIND_SPECS, type ImportKind } from "./kinds";
import type { BatchStatus, ImportRowView, RowStatus } from "./types";

/**
 * Pure helpers for the import screens: turning a parsed CSV into staging rows, reading
 * row errors, building the template and rejects files. Nothing here decides access or
 * validity — api.import_* re-checks permissions and validates every row in Postgres.
 */

/** Next.js Server Actions accept 1 MB bodies by default; keep the file safely below. */
export const MAX_FILE_BYTES = 900 * 1024;
/** Same limit as api.import_create_batch. */
export const MAX_ROWS = 5000;
/** Rows shown in the preview. */
export const PREVIEW_ROWS = 50;
/** Rejected rows shown on the page (all of them are in the downloadable errors file). */
export const REJECTS_SHOWN = 200;

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

/** The import commands need admin.import.run at scope "all" (owner by default). */
export const canRunImports = (ctx: UserContext) => can(ctx, "admin.import.run", "all");

/** And the permission of the command the kind posts through (UX only; the DB re-checks). */
export function canImportKind(ctx: UserContext, kind: ImportKind): boolean {
  const perm = KIND_SPECS[kind].permission;
  return canRunImports(ctx) && (perm === null || can(ctx, perm, "all"));
}

/** "Phone Primary " / "PHONE-PRIMARY" → "phone_primary". */
export function normalizeHeader(header: string): string {
  return header
    .replace(/^﻿/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export type StagedRow = Record<string, string | null>;

export type BuildError =
  | { code: "csv"; csv: CsvError }
  | { code: "empty" }
  | { code: "too_many_rows"; count: number }
  | { code: "duplicate_header"; column: string }
  | { code: "unknown_columns"; columns: string[] }
  | { code: "missing_columns"; columns: string[] }
  | { code: "extra_cells"; line: number };

export type BuildResult = { ok: true; headers: string[]; rows: StagedRow[] } | { ok: false; error: BuildError };

/**
 * CSV text → staging rows for `kind`: header row first, one object per data record with
 * every header as a key (empty cells → null). Blank records are skipped. Values are kept
 * as text; the database normalises and validates them.
 */
export function buildRows(kind: ImportKind, text: string): BuildResult {
  const parsed = parseCsv(text);
  if (!parsed.ok) return { ok: false, error: { code: "csv", csv: parsed.error } };
  const records = parsed.records.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (records.length < 2) return { ok: false, error: { code: "empty" } };

  const headers = (records[0] ?? []).map(normalizeHeader);
  // Trailing empty header cells (a spreadsheet's extra columns) are ignored.
  while (headers.length > 0 && headers[headers.length - 1] === "") headers.pop();
  const seen = new Set<string>();
  for (const h of headers) {
    if (seen.has(h)) return { ok: false, error: { code: "duplicate_header", column: h } };
    seen.add(h);
  }
  const spec = KIND_SPECS[kind];
  const unknown = headers.filter((h) => !spec.columns.includes(h));
  if (unknown.length > 0) return { ok: false, error: { code: "unknown_columns", columns: unknown } };
  const missing = spec.required.filter((c) => !headers.includes(c));
  if (missing.length > 0) return { ok: false, error: { code: "missing_columns", columns: missing } };

  const data = records.slice(1);
  if (data.length > MAX_ROWS) return { ok: false, error: { code: "too_many_rows", count: data.length } };

  const rows: StagedRow[] = [];
  for (let i = 0; i < data.length; i++) {
    const record = data[i] ?? [];
    if (record.slice(headers.length).some((cell) => cell.trim() !== "")) {
      return { ok: false, error: { code: "extra_cells", line: i + 2 } };
    }
    const row: StagedRow = {};
    headers.forEach((h, j) => {
      const value = (record[j] ?? "").trim();
      row[h] = value === "" ? null : value;
    });
    rows.push(row);
  }
  return { ok: true, headers, rows };
}

/** The downloadable template: English headers plus synthetic example rows. */
export function templateCsv(kind: ImportKind): string {
  const spec = KIND_SPECS[kind];
  return toCsv([spec.columns, ...spec.examples]);
}

export function templateFileName(kind: ImportKind): string {
  return `honest-import-${kind.replace(/_/g, "-")}-template.csv`;
}

export interface RowError {
  code: string;
  field: string;
}

/** 'invalid:phone_primary' → { code: 'invalid', field: 'phone_primary' }. */
export function parseRowError(error: string): RowError {
  const at = error.indexOf(":");
  return at < 0 ? { code: error, field: "" } : { code: error.slice(0, at), field: error.slice(at + 1) };
}

/** Error codes with a translation under imports.rowErrors.* (others fall back to "invalid"). */
export const ROW_ERROR_CODES = [
  "required",
  "invalid",
  "unknown",
  "inactive",
  "duplicate_in_file",
  "exists",
  "inconsistent",
  "negative",
  "expired",
  "mismatch",
  "discontinued",
  "overlap",
  "already_imported",
  "wrong_kind",
] as const;
export type RowErrorCode = (typeof ROW_ERROR_CODES)[number];

export function rowErrorKey(code: string): RowErrorCode {
  return (ROW_ERROR_CODES as readonly string[]).includes(code) ? (code as RowErrorCode) : "invalid";
}

/** Spreadsheet row number (the header is row 1). */
export const sheetRow = (rowNo: number) => rowNo + 1;

/**
 * The rejects file: spreadsheet row, the errors, then the row as uploaded — fix the cells
 * and upload the rows again as a new file (the extra columns must be removed first).
 */
export function rejectsCsv(kind: ImportKind, rows: readonly Pick<ImportRowView, "row_no" | "raw" | "errors">[]): string {
  const columns = KIND_SPECS[kind].columns;
  const present = columns.filter((c) => rows.some((r) => c in (r.raw ?? {})));
  const header = ["sheet_row", "errors", ...present];
  const body = rows.map((r) => [String(sheetRow(r.row_no)), r.errors.join("; "), ...present.map((c) => r.raw?.[c] ?? "")]);
  return toCsv([header, ...body]);
}

export function rejectsFileName(kind: ImportKind, batchId: string): string {
  return `honest-import-${kind.replace(/_/g, "-")}-rejects-${batchId.slice(0, 8)}.csv`;
}

export function batchStatusTone(status: BatchStatus): BadgeTone {
  switch (status) {
    case "committed":
      return "success";
    case "validated":
      return "info";
    case "failed":
      return "danger";
    case "uploaded":
      return "warning";
    case "discarded":
      return "neutral";
  }
}

export function rowStatusTone(status: RowStatus): BadgeTone {
  return status === "committed" ? "success" : status === "valid" ? "info" : status === "invalid" ? "danger" : "neutral";
}

/** Which buttons a batch offers. Committed and discarded batches are final. */
export function batchActions(status: BatchStatus): { validate: boolean; commit: boolean; discard: boolean } {
  return {
    validate: status === "uploaded" || status === "validated" || status === "failed",
    commit: status === "validated",
    discard: status !== "committed" && status !== "discarded",
  };
}

/** Columns to show in the preview: the kind's columns that the file actually has. */
export function previewColumns(kind: ImportKind, rows: readonly Pick<ImportRowView, "raw">[]): string[] {
  return KIND_SPECS[kind].columns.filter((c) => rows.some((r) => c in (r.raw ?? {})));
}

/** Short display of a commit result ({customers_created: 3} → [["customers_created", 3]]). */
export function resultEntries(result: Record<string, unknown> | null | undefined): [string, number][] {
  if (!result) return [];
  return Object.entries(result)
    .map(([k, v]) => [k, Number(v)] as [string, number])
    .filter(([, v]) => Number.isFinite(v));
}

/** "PERMISSION_DENIED: crm.customer.create …" → "PERMISSION_DENIED". */
export function failureCode(failure: string | null | undefined): string | null {
  if (!failure) return null;
  return /^([A-Z][A-Z0-9_]{2,}):/.exec(failure)?.[1] ?? null;
}
