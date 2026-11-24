import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { packStoredZip, unpackZip, workbookPartsFirst } from "./zip";

/**
 * Reads every sheet of an .xlsx into plain rows (cell values as exceljs gives them), from a file
 * path (the CLI) or from bytes held in memory (the browser import). Either way the read happens in
 * memory: the package is unpacked under a size budget and repacked with the workbook parts first
 * (./zip.ts), so exceljs never spills a worksheet to a temporary file.
 *
 * Uses the streaming reader: the owner's export stores absolute part paths
 * ("/xl/worksheets/sheet1.xml"), which make exceljs' normal reader crash on comments and lose
 * sheet names. Names are resolved here from the workbook model after the read, accepting both
 * absolute and relative targets.
 */
export type CellValue = unknown;
export type SheetRows = CellValue[][];
export type Sheets = Record<string, SheetRows>;

export interface ReadLimits {
  /** Total unpacked bytes allowed (zip bombs); the default suits the CLI. */
  maxUnzippedBytes?: number;
  /** Highest row number allowed on any sheet (header included); the read stops past it. */
  maxRowsPerSheet?: number;
  maxSheets?: number;
}

/** A workbook that is bigger than the limits allow (the read was stopped). */
export class WorkbookLimitError extends Error {
  constructor(
    readonly code: "too_many_rows" | "too_many_sheets" | "unreadable",
    readonly sheet?: string,
  ) {
    super(code);
    this.name = "WorkbookLimitError";
  }
}

const EMPTY_SST = new TextEncoder().encode(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>',
);

interface StreamSheet extends AsyncIterable<{ number: number; values: CellValue[] }> {
  id: number | string;
  name: string;
}
interface StreamModel {
  model?: { sheets?: { id: number; name: string; rId: string }[] };
  workbookRels?: { Id: string; Target: string }[];
}

export async function readWorkbook(input: string | Uint8Array, limits: ReadLimits = {}): Promise<Sheets> {
  const bytes = typeof input === "string" ? new Uint8Array(readFileSync(input)) : input;
  const parts = workbookPartsFirst(unpackZip(bytes, limits.maxUnzippedBytes ?? 512 * 1024 * 1024));
  // Without these the reader buffers sheets in temporary files (or cannot map them at all).
  if (!parts.some((p) => p.name === "xl/_rels/workbook.xml.rels")) throw new WorkbookLimitError("unreadable");
  if (!parts.some((p) => p.name === "xl/sharedStrings.xml")) {
    parts.splice(parts.findIndex((p) => p.name === "xl/_rels/workbook.xml.rels") + 1, 0, { name: "xl/sharedStrings.xml", data: EMPTY_SST });
  }
  const source = Readable.from([Buffer.from(packStoredZip(parts))]);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(source, {
    worksheets: "emit",
    sharedStrings: "cache",
    styles: "cache",
    hyperlinks: "ignore",
    entries: "ignore",
  });
  const maxRows = limits.maxRowsPerSheet ?? Number.POSITIVE_INFINITY;
  const maxSheets = limits.maxSheets ?? Number.POSITIVE_INFINITY;
  // Keyed by the reader's id: the N of "sheetN.xml" whenever the name could not be resolved.
  const byFile = new Map<number, { name: string; rows: SheetRows }>();
  for await (const ws of reader as unknown as AsyncIterable<StreamSheet>) {
    if (byFile.size >= maxSheets) throw new WorkbookLimitError("too_many_sheets");
    const rows: SheetRows = [];
    for await (const row of ws) {
      if (row.number > maxRows) throw new WorkbookLimitError("too_many_rows", ws.name);
      // exceljs rows are 1-based with a hole at index 0; keep the sheet's row numbers.
      rows[row.number - 1] = row.values.slice(1);
    }
    // The reader's id is the file number as a string ("1") when the name was not resolved.
    byFile.set(Number(ws.id), { name: ws.name, rows: Array.from(rows, (r) => r ?? []) });
  }

  // Map "sheetN.xml" to the workbook's sheet name.
  const meta = reader as unknown as StreamModel;
  const sheets = meta.model?.sheets ?? [];
  const rels = meta.workbookRels ?? [];
  const nameByFile = new Map<number, string>();
  for (const s of sheets) {
    const rel = rels.find((r) => r.Id === s.rId);
    const n = rel ? /sheet(\d+)\.xml$/.exec(rel.Target)?.[1] : undefined;
    if (n) nameByFile.set(Number(n), s.name);
  }

  const out: Sheets = {};
  for (const [fileNo, sheet] of byFile) {
    const resolved = /^Sheet\d+$/.test(sheet.name) ? (nameByFile.get(fileNo) ?? sheet.name) : sheet.name;
    out[resolved] = sheet.rows;
  }
  return out;
}
