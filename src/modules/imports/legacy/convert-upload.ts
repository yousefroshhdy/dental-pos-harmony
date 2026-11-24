import { createHash } from "node:crypto";
import { convertWorkbook, type ConvertOptions, type ConvertResult } from "./convert";
import { checkUploadMeta, checkZip, MAX_SHEET_ROWS, MAX_SHEETS, MAX_UNZIPPED_BYTES, REQUIRED_SHEETS, type UploadMeta, type UploadProblemCode } from "./upload";
import { readWorkbook, WorkbookLimitError } from "./workbook";
import { ZipLimitError } from "./zip";

/**
 * Uploaded bytes → converter result, entirely in memory (no disk, no storage, no database; the
 * reader repacks the package so exceljs never writes a temporary file).
 * Runs the upload checks first; the caller has already passed the database gate
 * (api.legacy_import_check: owner + admin.import.run + MFA).
 */
export type ConvertUploadResult =
  | { ok: true; result: ConvertResult; sha256: string }
  | { ok: false; problem: UploadProblemCode };

export async function convertUpload(bytes: Uint8Array, meta: UploadMeta, options: ConvertOptions): Promise<ConvertUploadResult> {
  const metaProblem = checkUploadMeta({ ...meta, size: Math.max(meta.size, bytes.byteLength) });
  if (metaProblem) return { ok: false, problem: metaProblem };
  const zipProblem = checkZip(bytes);
  if (zipProblem) return { ok: false, problem: zipProblem };

  let sheets;
  try {
    // +1: the header row.
    sheets = await readWorkbook(bytes, { maxRowsPerSheet: MAX_SHEET_ROWS + 1, maxSheets: MAX_SHEETS, maxUnzippedBytes: MAX_UNZIPPED_BYTES });
  } catch (error) {
    return { ok: false, problem: error instanceof WorkbookLimitError || error instanceof ZipLimitError ? error.code : "unreadable" };
  }
  if (REQUIRED_SHEETS.some((s) => !sheets[s])) return { ok: false, problem: "missing_sheets" };
  const result = convertWorkbook(sheets, options);
  return { ok: true, result, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Today in Cairo, YYYY-MM-DD (the converter flags lots that expired before it). */
export function cairoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
