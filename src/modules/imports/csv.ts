/**
 * A small RFC 4180 CSV reader and writer (no dependency).
 *
 * Reading:
 *  - UTF-8 text; a leading byte-order mark (U+FEFF, as Excel writes it) is dropped.
 *  - Records end with CRLF, LF or a lone CR; the last record may omit it.
 *  - A field may be wrapped in double quotes; inside, "" is one quote and line breaks
 *    and commas are data. A quote inside an unquoted field, text after a closing quote,
 *    or a quote that never closes is an error (with the 1-based line where it happened).
 *  - Completely empty lines are skipped (spreadsheets often leave them at the end).
 *
 * Writing quotes a field only when it needs it (comma, quote, CR or LF, or edge spaces)
 * and ends every record with CRLF, as RFC 4180 says.
 */

export type CsvError = { code: "unterminated_quote" | "unexpected_quote"; line: number };
export type CsvParseResult = { ok: true; records: string[][] } | { ok: false; error: CsvError };

const BOM = "﻿";

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

export function parseCsv(input: string, delimiter = ","): CsvParseResult {
  const text = stripBom(input);
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false; // inside a quoted field
  let afterQuote = false; // a quoted field just closed; only a delimiter or line end may follow
  let fieldStarted = false; // the current record has content (so an empty line can be skipped)
  let line = 1;
  let quoteLine = 1;

  const endField = () => {
    record.push(field);
    field = "";
    afterQuote = false;
  };
  const endRecord = () => {
    endField();
    if (fieldStarted || record.length > 1) records.push(record);
    record = [];
    fieldStarted = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        field += ch;
      }
      continue;
    }
    if (ch === delimiter) {
      fieldStarted = true;
      endField();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
    } else if (afterQuote) {
      return { ok: false, error: { code: "unexpected_quote", line } };
    } else if (ch === '"') {
      if (field !== "") return { ok: false, error: { code: "unexpected_quote", line } };
      quoted = true;
      fieldStarted = true;
      quoteLine = line;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (quoted) return { ok: false, error: { code: "unterminated_quote", line: quoteLine } };
  if (fieldStarted || field !== "" || record.length > 0) endRecord();
  return { ok: true, records };
}

function quoteField(value: string, delimiter: string): string {
  if (value === "") return "";
  const needs = value.includes(delimiter) || /["\r\n]/.test(value) || value.trim() !== value;
  return needs ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Spreadsheet formula injection guard for files we hand out: a cell that would start a
 * formula gets a leading apostrophe. Plain numbers and phone numbers (+20…, -5) are kept,
 * so a rejects file can be fixed and uploaded again.
 */
export function neutralizeFormula(value: string): string {
  if (/^[=@\t\r]/.test(value)) return `'${value}`;
  if (/^[+-]/.test(value) && !/^[+-][\d\s().]*$/.test(value)) return `'${value}`;
  return value;
}

export function toCsv(records: readonly (readonly (string | number | null | undefined)[])[], options: { bom?: boolean; safe?: boolean } = {}): string {
  const { bom = true, safe = true } = options;
  const body = records
    .map((r) =>
      r
        .map((cell) => {
          const text = cell === null || cell === undefined ? "" : String(cell);
          return quoteField(safe ? neutralizeFormula(text) : text, ",");
        })
        .join(","),
    )
    .map((r) => `${r}\r\n`)
    .join("");
  return bom ? BOM + body : body;
}
