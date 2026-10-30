import { describe, expect, it } from "vitest";
import {
  BOM,
  cairoDateTime,
  cairoDayStartUtc,
  cairoToday,
  CRLF,
  csvCell,
  csvDocument,
  CsvNumber,
  csvRow,
  decimal,
  integer,
  isoDate,
  money,
  neutralizeFormula,
  nextDay,
} from "@/modules/reports/csv";

describe("csvCell (RFC 4180)", () => {
  it("leaves plain text alone", () => {
    expect(csvCell("Clinic A")).toBe("Clinic A");
    expect(csvCell("")).toBe("");
  });

  it("quotes commas, quotes, CR and LF and doubles embedded quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("writes null and undefined as empty fields", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("writes numbers and booleans as they are", () => {
    expect(csvCell(42)).toBe("42");
    expect(csvCell(-3.5)).toBe("-3.5");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell(true)).toBe("true");
  });

  it("keeps Arabic text intact (quoted only when needed)", () => {
    expect(csvCell("عيادة تجريبية")).toBe("عيادة تجريبية");
    expect(csvCell("القاهرة، مصر")).toBe("القاهرة، مصر"); // Arabic comma U+060C is not a separator
    expect(csvCell("طبيب, اختبار")).toBe('"طبيب, اختبار"');
  });
});

describe("formula-injection guard", () => {
  it.each(["=1+1", "+201000000000", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd", '=HYPERLINK("http://example.invalid","x")'])("prefixes %j with an apostrophe", (text) => {
    expect(neutralizeFormula(text)).toBe(`'${text}`);
    expect(csvCell(text).replace(/^"/, "").startsWith("'")).toBe(true);
  });

  it("quotes a guarded cell that also needs quoting", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("\rx")).toBe(`"'\rx"`);
  });

  it("does not touch text that only contains those characters later", () => {
    expect(neutralizeFormula("a=b")).toBe("a=b");
    expect(neutralizeFormula("ORD-1")).toBe("ORD-1");
  });

  it("does not guard numbers this module formatted (negative money stays numeric)", () => {
    expect(csvCell(money(-12.5))).toBe("-12.50");
    expect(csvCell(money("-0.001"))).toBe("0.00");
    expect(csvCell(-7)).toBe("-7");
  });

  it("guards a numeric-looking string that did not come from the formatter", () => {
    expect(csvCell("-12.50")).toBe("'-12.50");
  });
});

describe("number formatting", () => {
  it("money: two decimals, no grouping or currency sign", () => {
    expect(money(1234.5)?.text).toBe("1234.50");
    expect(money("1234567.891")?.text).toBe("1234567.89");
    expect(money(0)?.text).toBe("0.00");
    expect(money("999999999999.99")?.text).toBe("999999999999.99");
  });

  it("rejects non-numbers", () => {
    expect(money("12 EGP")).toBeNull();
    expect(money("1e5")).toBeNull();
    expect(money(null)).toBeNull();
    expect(money("")).toBeNull();
    expect(money(Number.POSITIVE_INFINITY)).toBeNull();
    expect(integer({})).toBeNull();
  });

  it("integers and plain decimals", () => {
    expect(integer(3)?.text).toBe("3");
    expect(integer("12")?.text).toBe("12");
    expect(decimal(12.345)?.text).toBe("12.345");
    expect(CsvNumber.of("7", null)?.text).toBe("7");
  });
});

describe("rows and documents", () => {
  it("terminates each record with CRLF", () => {
    expect(csvRow(["a", "b,c", null, money(5)])).toBe('a,"b,c",,5.00\r\n');
    expect(CRLF).toBe("\r\n");
  });

  it("starts with a UTF-8 BOM that encodes to EF BB BF", () => {
    const doc = csvDocument(["العميل", "Total"], [["عيادة", money(10)]]);
    expect(doc.startsWith(BOM)).toBe(true);
    const bytes = new TextEncoder().encode(doc);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(doc).toBe("﻿العميل,Total\r\nعيادة,10.00\r\n");
  });
});

describe("Cairo dates", () => {
  it("formats instants as Cairo wall-clock ISO date-times", () => {
    // Winter (UTC+2) and summer (UTC+3, Egypt DST).
    expect(cairoDateTime("2026-01-15T10:00:00Z")).toBe("2026-01-15 12:00:00");
    expect(cairoDateTime("2026-07-15T10:00:00Z")).toBe("2026-07-15 13:00:00");
    expect(cairoDateTime("2026-10-30T22:30:00Z")).toBe("2026-10-31 00:30:00");
    expect(cairoDateTime("not a date")).toBeNull();
    expect(cairoDateTime(42)).toBeNull();
  });

  it("passes calendar dates through", () => {
    expect(isoDate("2026-10-30")).toBe("2026-10-30");
    expect(isoDate("30/10/2026")).toBeNull();
  });

  it("finds the UTC start of a Cairo day across DST", () => {
    expect(cairoDayStartUtc("2026-01-15")).toBe("2026-01-14T22:00:00.000Z");
    expect(cairoDayStartUtc("2026-07-15")).toBe("2026-07-14T21:00:00.000Z");
  });

  it("today and the next day", () => {
    expect(cairoToday(new Date("2026-10-30T22:30:00Z"))).toBe("2026-10-31");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
  });
});
