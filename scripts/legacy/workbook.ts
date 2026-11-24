import ExcelJS from "exceljs";

/**
 * Reads every sheet of an .xlsx into plain rows (cell values as exceljs gives them).
 *
 * Uses the streaming reader: the owner's export stores absolute part paths
 * ("/xl/worksheets/sheet1.xml"), which make exceljs' normal reader crash on comments and lose
 * sheet names. Names are resolved here from the workbook model after the read, accepting both
 * absolute and relative targets.
 */
export type CellValue = unknown;
export type SheetRows = CellValue[][];
export type Sheets = Record<string, SheetRows>;

interface StreamSheet extends AsyncIterable<{ number: number; values: CellValue[] }> {
  id: number | string;
  name: string;
}
interface StreamModel {
  model?: { sheets?: { id: number; name: string; rId: string }[] };
  workbookRels?: { Id: string; Target: string }[];
}

export async function readWorkbook(path: string): Promise<Sheets> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, {
    worksheets: "emit",
    sharedStrings: "cache",
    styles: "cache",
    hyperlinks: "ignore",
    entries: "ignore",
  });
  // Keyed by the reader's id: the N of "sheetN.xml" whenever the name could not be resolved.
  const byFile = new Map<number, { name: string; rows: SheetRows }>();
  for await (const ws of reader as unknown as AsyncIterable<StreamSheet>) {
    const rows: SheetRows = [];
    for await (const row of ws) {
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
