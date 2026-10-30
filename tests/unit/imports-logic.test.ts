import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type UserContext } from "@/lib/authz/can";
import { parseCsv } from "@/modules/imports/csv";
import { IMPORT_KINDS, isImportKind, KIND_SPECS } from "@/modules/imports/kinds";
import {
  batchActions,
  buildRows,
  canImportKind,
  canRunImports,
  failureCode,
  MAX_ROWS,
  normalizeHeader,
  parseRowError,
  previewColumns,
  rejectsCsv,
  rejectsFileName,
  resultEntries,
  rowErrorKey,
  sheetRow,
  templateCsv,
  templateFileName,
} from "@/modules/imports/logic";

const ctx = (permissions: UserContext["permissions"], is_owner = false): UserContext => ({
  ...ANONYMOUS_CONTEXT,
  user_id: "00000000-0000-0000-0000-0000000000a1",
  active: true,
  status: "active",
  is_owner,
  permissions,
});

describe("buildRows", () => {
  it("maps each record to the header columns, empty cells to null, values trimmed", () => {
    const r = buildRows("opening_ar", "﻿Customer No, Amount ,customer_phone\r\nCUS-2026-000001, 1500.00 ,\r\n,-20,01000000001\r\n");
    expect(r).toEqual({
      ok: true,
      headers: ["customer_no", "amount", "customer_phone"],
      rows: [
        { customer_no: "CUS-2026-000001", amount: "1500.00", customer_phone: null },
        { customer_no: null, amount: "-20", customer_phone: "01000000001" },
      ],
    });
  });

  it("skips blank records and trailing empty header columns", () => {
    const r = buildRows("opening_ar", "customer_no,amount,,\n\n,,,\nC1,5,,\n");
    expect(r.ok && r.rows).toEqual([{ customer_no: "C1", amount: "5" }]);
  });

  it("explains file problems before anything reaches the database", () => {
    expect(buildRows("opening_ar", 'amount\n"5')).toEqual({ ok: false, error: { code: "csv", csv: { code: "unterminated_quote", line: 2 } } });
    expect(buildRows("opening_ar", "amount\n")).toEqual({ ok: false, error: { code: "empty" } });
    expect(buildRows("opening_ar", "amount,amount\n1,2")).toEqual({ ok: false, error: { code: "duplicate_header", column: "amount" } });
    expect(buildRows("opening_ar", "amount,salary\n1,2")).toEqual({ ok: false, error: { code: "unknown_columns", columns: ["salary"] } });
    expect(buildRows("opening_stock", "sku,quantity\nA,1")).toEqual({ ok: false, error: { code: "missing_columns", columns: ["warehouse_code"] } });
    expect(buildRows("opening_ar", "amount\n1\n2,3")).toEqual({ ok: false, error: { code: "extra_cells", line: 3 } });
  });

  it("refuses more rows than one batch may hold", () => {
    const text = "amount\n" + "1\n".repeat(MAX_ROWS + 1);
    expect(buildRows("opening_ar", text)).toEqual({ ok: false, error: { code: "too_many_rows", count: MAX_ROWS + 1 } });
    expect(buildRows("opening_ar", "amount\n" + "1\n".repeat(MAX_ROWS)).ok).toBe(true);
  });

  it("parses every kind's own template", () => {
    for (const kind of IMPORT_KINDS) {
      const r = buildRows(kind, templateCsv(kind));
      expect(r.ok, kind).toBe(true);
      if (r.ok) {
        expect(r.headers).toEqual([...KIND_SPECS[kind].columns]);
        expect(r.rows.length).toBe(KIND_SPECS[kind].examples.length);
      }
    }
  });
});

describe("normalizeHeader", () => {
  it("lower-cases, trims and turns spaces and dashes into underscores", () => {
    expect(normalizeHeader(" Phone Primary ")).toBe("phone_primary");
    expect(normalizeHeader("﻿SKU")).toBe("sku");
    expect(normalizeHeader("unit-price")).toBe("unit_price");
  });
});

describe("templates", () => {
  it("each example row has one value per column and only synthetic-looking data", () => {
    for (const kind of IMPORT_KINDS) {
      const spec = KIND_SPECS[kind];
      for (const row of spec.examples) expect(row.length, kind).toBe(spec.columns.length);
    }
    const all = IMPORT_KINDS.flatMap((k) => KIND_SPECS[k].examples.flat()).join(" ");
    // Phones are 0100000000x / +2011000000xx placeholders; emails use the reserved .test domain.
    for (const phone of all.match(/\+?\d{11,13}/g) ?? []) expect(phone).toMatch(/^(\+20|0)1[01]0{6,}\d{1,2}$/);
    for (const email of all.match(/\S+@\S+/g) ?? []) expect(email).toMatch(/\.test$/);
  });

  it("starts with a BOM, English headers, and has a stable file name", () => {
    const csv = templateCsv("customers");
    expect(csv.startsWith("﻿doctor_name,clinic_name,")).toBe(true);
    const parsed = parseCsv(csv);
    expect(parsed.ok && parsed.records[0]).toEqual([...KIND_SPECS.customers.columns]);
    expect(templateFileName("opening_stock")).toBe("honest-import-opening-stock-template.csv");
  });
});

describe("row errors", () => {
  it("splits code and field", () => {
    expect(parseRowError("invalid:phone_primary")).toEqual({ code: "invalid", field: "phone_primary" });
    expect(parseRowError("required:doctor_name/clinic_name")).toEqual({ code: "required", field: "doctor_name/clinic_name" });
    expect(parseRowError("odd")).toEqual({ code: "odd", field: "" });
  });

  it("falls back to 'invalid' for codes without a translation", () => {
    expect(rowErrorKey("duplicate_in_file")).toBe("duplicate_in_file");
    expect(rowErrorKey("something_new")).toBe("invalid");
  });

  it("spreadsheet rows count the header", () => {
    expect(sheetRow(1)).toBe(2);
  });
});

describe("rejectsCsv", () => {
  it("lists spreadsheet row, errors and the uploaded columns (only those present)", () => {
    const csv = rejectsCsv("opening_ar", [
      { row_no: 1, raw: { customer_no: "C-9", amount: "0" }, errors: ["unknown:customer_no", "invalid:amount"] },
      { row_no: 4, raw: { customer_no: null, amount: "=1+1" }, errors: ["required:customer"] },
    ]);
    const parsed = parseCsv(csv);
    expect(parsed.ok && parsed.records).toEqual([
      ["sheet_row", "errors", "customer_no", "amount"],
      ["2", "unknown:customer_no; invalid:amount", "C-9", "0"],
      ["5", "required:customer", "", "'=1+1"],
    ]);
    expect(rejectsFileName("opening_ar", "abcdef12-0000-0000-0000-000000000000")).toBe("honest-import-opening-ar-rejects-abcdef12.csv");
  });
});

describe("batch helpers", () => {
  it("offers only the steps the status allows", () => {
    expect(batchActions("uploaded")).toEqual({ validate: true, commit: false, discard: true });
    expect(batchActions("validated")).toEqual({ validate: true, commit: true, discard: true });
    expect(batchActions("failed")).toEqual({ validate: true, commit: false, discard: true });
    expect(batchActions("committed")).toEqual({ validate: false, commit: false, discard: false });
    expect(batchActions("discarded")).toEqual({ validate: false, commit: false, discard: false });
  });

  it("previews the kind's columns that the file has, in template order", () => {
    expect(previewColumns("opening_ar", [{ raw: { amount: "1", customer_phone: null } }])).toEqual(["customer_phone", "amount"]);
  });

  it("reads commit results and failure codes", () => {
    expect(resultEntries({ entries: 3, total_amount: "3700.00", note: "x" })).toEqual([
      ["entries", 3],
      ["total_amount", 3700],
    ]);
    expect(resultEntries(null)).toEqual([]);
    expect(failureCode("DUPLICATE_CUSTOMER: phone is already registered")).toBe("DUPLICATE_CUSTOMER");
    expect(failureCode("no code here")).toBeNull();
    expect(failureCode(null)).toBeNull();
  });

  it("recognises kinds", () => {
    expect(isImportKind("opening_stock")).toBe(true);
    expect(isImportKind("payroll")).toBe(false);
    expect(isImportKind(undefined)).toBe(false);
  });
});

describe("permissions (UX only)", () => {
  it("needs admin.import.run at scope all, plus the kind's own permission", () => {
    const owner = ctx({}, true);
    expect(canRunImports(owner)).toBe(true);
    for (const kind of IMPORT_KINDS) expect(canImportKind(owner, kind)).toBe(true);

    const importer = ctx({ "admin.import.run": { scope: "all", limit: null }, "crm.customer.create": { scope: "all", limit: null } });
    expect(canImportKind(importer, "customers")).toBe(true);
    expect(canImportKind(importer, "opening_ar")).toBe(true);
    expect(canImportKind(importer, "opening_stock")).toBe(false);

    const scoped = ctx({ "admin.import.run": { scope: "team", limit: null } });
    expect(canRunImports(scoped)).toBe(false);

    const rep = ctx({ "crm.customer.create": { scope: "own", limit: null } });
    expect(canRunImports(rep)).toBe(false);
    expect(canRunImports(ANONYMOUS_CONTEXT)).toBe(false);
  });
});
