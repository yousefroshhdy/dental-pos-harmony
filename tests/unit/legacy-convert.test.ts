import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cellDate,
  cellNumber,
  cellText,
  convertWorkbook,
  DEFAULT_OPTIONS,
  formatReport,
  inferBrand,
  inferCategory,
  normalizeMobile,
  parseGs1,
  skuFor,
  UNKNOWN_LOT,
  type ConvertResult,
} from "../../scripts/legacy/convert";
import { assertSafeOutput, parseArgs } from "../../scripts/legacy/convert-workbook";
import { readWorkbook, type Sheets } from "../../scripts/legacy/workbook";
import { parseCsv } from "@/modules/imports/csv";
import { KIND_SPECS } from "@/modules/imports/kinds";
import { buildRows } from "@/modules/imports/logic";
import { SYNTHETIC_TODAY, writeSyntheticWorkbook } from "./legacy-synthetic";

// Synthetic data only (owner decision A): the workbook is generated here, never the owner's file.
let dir = "";
let sheets: Sheets = {};
let result: ConvertResult;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "honest-legacy-test-"));
  const path = join(dir, "synthetic.xlsx");
  await writeSyntheticWorkbook(path);
  sheets = await readWorkbook(path);
  result = convertWorkbook(sheets, { ...DEFAULT_OPTIONS, today: SYNTHETIC_TODAY });
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const fileOf = (name: string) => {
  const f = result.files.find((x) => x.name === name);
  if (!f) throw new Error(`no ${name}`);
  return f;
};

describe("cell and field helpers", () => {
  it("unwraps formulas, rich text and dates", () => {
    expect(cellText({ formula: "A1", result: 58 })).toBe("58");
    expect(cellText({ richText: [{ text: "د/" }, { text: "تجربة" }] })).toBe("د/تجربة");
    expect(cellText("  two   spaces ")).toBe("two spaces");
    expect(cellNumber("١٬٢٣٤".replace("٬", ""))).toBe(1234);
    expect(cellNumber({ formula: "SUM(A:A)", result: 12.5 })).toBe(12.5);
    expect(cellNumber("")).toBeNull();
    expect(cellDate(new Date(Date.UTC(2030, 5, 9)))).toBe("2030-06-09");
    expect(cellDate("2030-01-02")).toBe("2030-01-02");
  });

  it("normalizes Egyptian mobiles and refuses anything else", () => {
    expect(normalizeMobile("01000000001")).toBe("+201000000001");
    expect(normalizeMobile("+20 100 000 0001")).toBe("+201000000001");
    expect(normalizeMobile("00201000000001")).toBe("+201000000001");
    expect(normalizeMobile("٠١٠٠٠٠٠٠٠٠١")).toBe("+201000000001");
    expect(normalizeMobile("12345")).toBeNull();
    expect(normalizeMobile("0225550000")).toBeNull(); // a landline is not a mobile
  });

  it("parses GS1 element strings (GTIN, expiry, lot)", () => {
    expect(parseGs1("(01)00000000000017(11)250101(17)300630(10)")).toEqual({ gtin: "00000000000017", expiry: "2030-06-30" });
    expect(parseGs1("(01)00000000000017(17)300200(10)SYN-L1")).toEqual({ gtin: "00000000000017", expiry: "2030-02-28", lot: "SYN-L1" });
    expect(parseGs1("12345678901234567890")).toBeNull();
  });

  it("infers brand, category and SKU from the old item", () => {
    expect(inferBrand("BIONER", "x", "")).toBe("BIONER");
    expect(inferBrand("CHINA", "SYNTHETIC BAND", "")).toBe("GENERIC");
    expect(inferBrand("", "Synthetic tissue plier DDD375-1", "")).toBe("DERBY");
    expect(inferBrand("", "SYNTHETIC FLAT END TAPER 882-14-10", "")).toBe("RDT");
    expect(inferBrand("", "850L-18-11.5", "RDT")).toBe("RDT");
    expect(inferCategory("BIONER", "Synthetic Implant DM-3510")).toBe("IMPLANT");
    expect(inferCategory("BIONER", "Synthetic Healing Abutment DM-PC15")).toBe("IMPLANT_PARTS");
    expect(inferCategory("BIONER", "Synthetic Surgical Kit")).toBe("IMPLANT_PARTS");
    expect(inferCategory("STEP", "SYNTHETIC MEMBRANE")).toBe("MEMBRANE");
    expect(inferCategory("STEP", "SYNTHETIC BONE GRAFT 1CC")).toBe("GRAFT");
    expect(inferCategory("DERBY", "x")).toBe("INSTRUMENT");
    expect(skuFor("BIONER", 3)).toBe("BIO-0003");
  });
});

describe("convertWorkbook on a synthetic workbook", () => {
  it("reads the sheets by name", () => {
    expect(Object.keys(sheets)).toEqual(["Checks", "Customers", "Items", "Sales_Invoices"]);
  });

  it("writes the import files in import order, with the template headers", () => {
    expect(result.files.map((f) => [f.name, f.kind, f.rows.length])).toEqual([
      ["1-products.csv", "products", 7],
      ["2-base-prices.csv", "customer_prices", 6],
      ["3-opening-stock.csv", "opening_stock", 4],
      ["4-customers.csv", "customers", 5],
      ["5-opening-ar.csv", "opening_ar", 2],
      ["6-opening-ar-credits.csv", "opening_ar", 1],
      ["barcodes-to-verify.csv", null, 1],
    ]);
    for (const f of result.files) {
      if (!f.kind) continue;
      const parsed = parseCsv(f.csv);
      expect(parsed.ok && parsed.records[0]).toEqual([...KIND_SPECS[f.kind].columns]);
      expect(f.csv.startsWith("﻿"), f.name).toBe(true); // UTF-8 BOM for Excel
    }
  });

  it("the import screen accepts every file as is", () => {
    for (const f of result.files) {
      if (!f.kind) continue;
      const built = buildRows(f.kind, f.csv, f.kind === "customers" ? { governorate_code: "EG-DK" } : {});
      expect(built.ok, f.name).toBe(true);
    }
  });

  it("customers: phone optional, old account number kept, governorate left to the batch default", () => {
    const rows = fileOf("4-customers.csv").rows;
    expect(rows.map((r) => r.legacy_ref)).toEqual(["1", "2", "3", "4", "5"]);
    expect(rows.map((r) => r.phone_primary)).toEqual(["+201000000001", "", "+201100000002", "", ""]);
    expect(rows.every((r) => r.governorate_code === "")).toBe(true);
    expect(rows[0]?.doctor_name).toBe("د/تجربة أول"); // a doctor's name
    expect(rows[2]?.clinic_name).toBe("مركز تجريبي"); // a centre
    expect(rows[3]?.notes).toContain("not valid");
    expect(rows[4]?.notes).toContain("shared with another account");
    expect(result.warnings).toContain("customers without a valid phone (imported as phone missing): 3");
    expect(result.warnings).toContain("before 1-products.csv, add on /admin/setup: GENERIC, IMPLANT_PARTS, STEP (not seeded brands / category)");
  });

  it("opening AR: net = debit - credit, positive = owed to HONEST, credits held back in their own file", () => {
    expect(fileOf("5-opening-ar.csv").rows).toEqual([
      { customer_legacy_ref: "1", amount: "1000.00" },
      { customer_legacy_ref: "4", amount: "500.50" },
    ]);
    expect(fileOf("6-opening-ar-credits.csv").rows).toEqual([{ customer_legacy_ref: "3", amount: "-300.00" }]);
  });

  it("products: one per item, Bioner GTIN as barcode, unverified barcodes held back", () => {
    const rows = fileOf("1-products.csv").rows;
    expect(rows.map((r) => `${r.sku}:${r.brand_code}/${r.category_code}:${r.lot_tracked}/${r.expiry_tracked}`)).toEqual([
      "BIO-0003:BIONER/IMPLANT:yes/yes",
      "BIO-0021:BIONER/IMPLANT_PARTS:yes/no",
      "RDT-0100:RDT/BUR:no/no",
      "DRB-0200:DERBY/INSTRUMENT:no/no",
      "STP-0300:STEP/MEMBRANE:yes/no",
      "RDT-0301:RDT/BUR:no/no",
      "GEN-0302:GENERIC/INSTRUMENT:no/no",
    ]);
    expect(rows[0]?.barcode).toBe("00000000000017");
    expect(rows.filter((r) => r.barcode).length).toBe(1);
    expect(fileOf("barcodes-to-verify.csv").rows).toEqual([
      { item_no: "100", sku: "RDT-0100", barcode_as_read: "12345678901234567890123456789012", check: "needs scanner check" },
    ]);
  });

  it("base prices: DEFAULT list, no customer, items without a price left out", () => {
    const rows = fileOf("2-base-prices.csv").rows;
    expect(rows.every((r) => r.price_list_code === "DEFAULT" && !r.customer_no && !r.customer_phone && !r.customer_legacy_ref)).toBe(true);
    expect(rows.map((r) => `${r.sku}=${r.unit_price}`)).toEqual([
      "BIO-0003=5000.00", "BIO-0021=1400.00", "RDT-0100=160.00", "DRB-0200=400.00", "STP-0300=3000.00", "RDT-0301=160.00",
    ]);
  });

  it("opening stock: main warehouse, unknown cost never 0, placeholder lot, negatives left out", () => {
    const rows = fileOf("3-opening-stock.csv").rows;
    expect(rows).toEqual([
      { warehouse_code: "WH-MAIN", sku: "BIO-0003", lot_no: UNKNOWN_LOT, expiry_date: "2030-06-30", quantity: "10", unit_cost: "", cost_unknown: "yes" },
      { warehouse_code: "WH-MAIN", sku: "BIO-0021", lot_no: UNKNOWN_LOT, expiry_date: "", quantity: "5", unit_cost: "2000.00", cost_unknown: "" },
      { warehouse_code: "WH-MAIN", sku: "RDT-0100", lot_no: "", expiry_date: "", quantity: "20", unit_cost: "", cost_unknown: "yes" },
      { warehouse_code: "WH-MAIN", sku: "STP-0300", lot_no: UNKNOWN_LOT, expiry_date: "", quantity: "3", unit_cost: "", cost_unknown: "yes" },
    ]);
    expect(rows.some((r) => r.unit_cost === "0.00" || r.unit_cost === "0")).toBe(false);
  });

  it("reconciles against the Checks sheet and flags the difference", () => {
    const byCheck = Object.fromEntries(result.reconciliation.map((l) => [l.check, l]));
    expect(byCheck["Customers: count"]).toMatchObject({ expected: 5, output: 5, status: "ok" });
    expect(byCheck["Customers: total debit balance"]).toMatchObject({ expected: 1500.5, output: 1500.5, status: "ok" });
    expect(byCheck["Customers: total credit balance"]).toMatchObject({ expected: 300, output: 300, status: "ok" });
    expect(byCheck["Items: total quantity on hand"]).toMatchObject({ expected: 32, output: 38, difference: 6, status: "diff" });
    expect(byCheck["Items: total quantity on hand"]?.note).toContain("1 negative rows (-6) left out");
    expect(byCheck["Sales: net total"]).toMatchObject({ status: "info", difference: null });
    const report = formatReport(result);
    expect(report).toContain("DIFF  Items: total quantity on hand");
    // Aggregates only: no names or phones in the report.
    for (const secret of ["تجربة", "Synthetic Lab", "+20100", "0100000"]) expect(report).not.toContain(secret);
  });
});

describe("suite 55 loads exactly this output", () => {
  // The DB suite embeds the converter output as it is staged by /imports; keep both in step.
  const suite = readFileSync(join(__dirname, "../../supabase/tests/database/55_phase_p_setup.test.sql"), "utf8");
  const blocks = new Map(
    [...suite.matchAll(/-- legacy-fixture:([\w.-]+)\n[^$]*\$j\$([\s\S]*?)\$j\$/g)].map((m) => [m[1] ?? "", JSON.parse(m[2] ?? "[]")]),
  );

  it("has a block for every import file", () => {
    expect([...blocks.keys()]).toEqual(result.files.filter((f) => f.kind).map((f) => f.name));
  });

  it("each block equals the converter file parsed by the upload step", () => {
    for (const f of result.files) {
      if (!f.kind) continue;
      const built = buildRows(f.kind, f.csv, f.kind === "customers" ? { governorate_code: "EG-DK" } : {});
      expect(built.ok && built.rows, f.name).toEqual(blocks.get(f.name));
    }
  });
});

describe("command line", () => {
  it("parses options and refuses unknown ones", () => {
    const args = parseArgs(["--in", "a.xlsx", "--out", "private/import", "--governorate", "eg-dk", "--today", "2026-11-25"]);
    expect(args).toMatchObject({ input: "a.xlsx", output: "private/import" });
    expect(args.options).toEqual({
      warehouseCode: "WH-MAIN", governorateCode: "EG-DK", priceListCode: "DEFAULT",
      priceListName: DEFAULT_OPTIONS.priceListName, today: "2026-11-25",
    });
    expect(() => parseArgs(["--in", "a.xlsx"])).toThrow(/Usage/);
    expect(() => parseArgs(["--in", "a", "--out", "b", "--salary", "1"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--in", "a", "--out", "b", "--governorate", "Dakahlia"])).toThrow(/EG-DK/);
  });

  it("writes real data inside the repository only under ./private/", () => {
    expect(() => assertSafeOutput("/repo/private/import", "/repo")).not.toThrow();
    expect(() => assertSafeOutput("/tmp/somewhere", "/repo")).not.toThrow();
    expect(() => assertSafeOutput("/repo/docs/import", "/repo")).toThrow(/private/);
    expect(() => assertSafeOutput("/repo", "/repo")).toThrow(/private/);
  });
});
