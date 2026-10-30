import { describe, expect, it } from "vitest";
import { neutralizeFormula, parseCsv, stripBom, toCsv } from "@/modules/imports/csv";

const records = (text: string) => {
  const r = parseCsv(text);
  if (!r.ok) throw new Error(`${r.error.code} at ${r.error.line}`);
  return r.records;
};

describe("parseCsv (RFC 4180)", () => {
  it("reads simple records with LF, CRLF and lone CR line ends", () => {
    expect(records("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(records("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(records("a,b\r1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("accepts a last record without a line end", () => {
    expect(records("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("drops a UTF-8 byte-order mark (Excel's CSV UTF-8)", () => {
    expect(records("﻿phone_primary,city\n01000000001,القاهرة")).toEqual([["phone_primary", "city"], ["01000000001", "القاهرة"]]);
    expect(stripBom("﻿x")).toBe("x");
    expect(stripBom("x")).toBe("x");
  });

  it("keeps empty fields, including trailing ones", () => {
    expect(records("a,,c,\n,,,")).toEqual([["a", "", "c", ""], ["", "", "", ""]]);
  });

  it("reads quoted fields with commas, doubled quotes and line breaks", () => {
    expect(records('name,notes\n"Clinic, Nasr City","He said ""hi"""\n')).toEqual([
      ["name", "notes"],
      ["Clinic, Nasr City", 'He said "hi"'],
    ]);
    expect(records('a\n"line 1\r\nline 2"\n')).toEqual([["a"], ["line 1\r\nline 2"]]);
    expect(records('"",x')).toEqual([["", "x"]]);
  });

  it("skips completely empty lines", () => {
    expect(records("a\n\n1\n\r\n\n2\n\n")).toEqual([["a"], ["1"], ["2"]]);
  });

  it("returns no records for empty input", () => {
    expect(records("")).toEqual([]);
    expect(records("﻿")).toEqual([]);
  });

  it("reports an unterminated quote at the line where it starts", () => {
    expect(parseCsv('a\n1\n"open,\nmore')).toEqual({ ok: false, error: { code: "unterminated_quote", line: 3 } });
  });

  it("refuses a quote inside an unquoted field or text after a closing quote", () => {
    expect(parseCsv('a\nab"c')).toEqual({ ok: false, error: { code: "unexpected_quote", line: 2 } });
    expect(parseCsv('a\n"ab"c')).toEqual({ ok: false, error: { code: "unexpected_quote", line: 2 } });
  });

  it("counts lines inside quoted fields for later errors", () => {
    expect(parseCsv('a\n"x\ny"\nb"')).toEqual({ ok: false, error: { code: "unexpected_quote", line: 4 } });
  });

  it("supports another delimiter", () => {
    expect(parseCsv("a;b\n1;2", ";")).toEqual({ ok: true, records: [["a", "b"], ["1", "2"]] });
  });
});

describe("toCsv", () => {
  it("quotes only when needed and ends records with CRLF", () => {
    expect(toCsv([["a", "b,c", 'q"', "x\ny", " pad", null, 5]], { bom: false })).toBe('a,"b,c","q""","x\ny"," pad",,5\r\n');
  });

  it("starts with a BOM by default so spreadsheets read Arabic as UTF-8", () => {
    expect(toCsv([["عيادة"]]).startsWith("﻿")).toBe(true);
  });

  it("round-trips through parseCsv", () => {
    const data = [
      ["sheet_row", "errors", "notes"],
      ["2", "invalid:phone_primary; exists:sku", 'multi\r\nline, "quoted"'],
    ];
    expect(records(toCsv(data))).toEqual(data);
  });

  it("neutralises spreadsheet formulas but keeps numbers and phones", () => {
    expect(neutralizeFormula("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(neutralizeFormula("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(neutralizeFormula("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(neutralizeFormula("-2+3")).toBe("'-2+3");
    expect(neutralizeFormula("+201001234567")).toBe("+201001234567");
    expect(neutralizeFormula("-250.00")).toBe("-250.00");
    expect(neutralizeFormula("+20 (100) 123")).toBe("+20 (100) 123");
    expect(neutralizeFormula("Clinic")).toBe("Clinic");
    expect(toCsv([["=1+1"]], { bom: false })).toBe("'=1+1\r\n");
    expect(toCsv([["=1+1"]], { bom: false, safe: false })).toBe("=1+1\r\n");
  });
});
