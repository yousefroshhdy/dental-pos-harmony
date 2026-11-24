/**
 * Upload checks for the old-system workbook (pure; unit-tested). The route handler runs them
 * before any byte reaches the spreadsheet parser:
 *
 *   1. name ends in .xlsx and the browser's type is the .xlsx type (or unknown/octet-stream);
 *   2. size ≤ MAX_WORKBOOK_BYTES (Vercel refuses function bodies above 4.5 MB anyway);
 *   3. the bytes are a zip (PK signature) whose central directory is sane: few entries, a bounded
 *      total uncompressed size and compression ratio (zip bombs), no macro or binary workbook parts;
 *   4. while parsing, at most MAX_SHEET_ROWS data rows per sheet (workbook.ts stops the read).
 *
 * Owner-only + MFA is decided by the database (api.legacy_import_check) before step 3.
 */

import { readZipDirectory } from "./zip-directory";

export { readZipDirectory };

export const MAX_WORKBOOK_BYTES = 4 * 1024 * 1024;
/** Request bodies carry the file plus a few small fields. */
export const MAX_REQUEST_BYTES = MAX_WORKBOOK_BYTES + 64 * 1024;
/** Data rows per sheet; the import batches take at most 5000 rows per kind. */
export const MAX_SHEET_ROWS = 5000;
export const MAX_SHEETS = 40;
export const MAX_ZIP_ENTRIES = 400;
export const MAX_UNZIPPED_BYTES = 64 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 150;

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ACCEPTED_MIME = new Set([XLSX_MIME, "application/octet-stream", ""]);

export type UploadProblemCode =
  | "no_file"
  | "not_xlsx"
  | "too_large"
  | "not_zip"
  | "zip_bomb"
  | "too_many_rows"
  | "too_many_sheets"
  | "unreadable"
  | "missing_sheets";

export interface UploadMeta {
  name: string;
  type: string;
  size: number;
}

/** Checks 1–2: name, declared type and size. */
export function checkUploadMeta(file: UploadMeta | null): UploadProblemCode | null {
  if (!file || file.size === 0) return "no_file";
  if (!/\.xlsx$/i.test(file.name.trim())) return "not_xlsx";
  if (!ACCEPTED_MIME.has(file.type.trim().toLowerCase())) return "not_xlsx";
  if (file.size > MAX_WORKBOOK_BYTES) return "too_large";
  return null;
}

/** Check 3: a sane .xlsx package. */
export function checkZip(bytes: Uint8Array): UploadProblemCode | null {
  const entries = readZipDirectory(bytes);
  if (!entries || entries.length === 0) return "not_zip";
  if (!entries.some((e) => e.name.replace(/^\//, "") === "xl/workbook.xml")) return "not_xlsx";
  if (entries.some((e) => /vbaProject\.bin$|\.xlsb$|workbook\.bin$/i.test(e.name))) return "not_xlsx";
  if (entries.length > MAX_ZIP_ENTRIES) return "zip_bomb";
  let unzipped = 0;
  for (const e of entries) {
    unzipped += e.uncompressedSize;
    if (e.compressedSize > 0 && e.uncompressedSize / e.compressedSize > MAX_COMPRESSION_RATIO && e.uncompressedSize > 1024 * 1024) {
      return "zip_bomb";
    }
  }
  return unzipped > MAX_UNZIPPED_BYTES ? "zip_bomb" : null;
}

/**
 * CSRF guard for the route handler (Server Actions get the same check from Next itself): the
 * browser's Origin must name this host. A missing Origin is refused; fetch() always sends it on POST.
 * `sec-fetch-site`, when sent, must not be cross-site.
 */
export function isSameOrigin(headers: { origin: string | null; host: string | null; forwardedHost: string | null; fetchSite: string | null }): boolean {
  if (!headers.origin) return false;
  if (headers.fetchSite && headers.fetchSite !== "same-origin") return false;
  let originHost: string;
  try {
    originHost = new URL(headers.origin).host.toLowerCase();
  } catch {
    return false;
  }
  const expected = (headers.forwardedHost ?? headers.host ?? "").split(",")[0]?.trim().toLowerCase();
  return !!expected && originHost === expected;
}

/** The sheets the converter needs. */
export const REQUIRED_SHEETS = ["Customers", "Items"] as const;
