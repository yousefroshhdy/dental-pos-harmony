import { readFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS, type ConvertResult } from "@/modules/imports/legacy/convert";
import { cairoToday, convertUpload } from "@/modules/imports/legacy/convert-upload";
import {
  allStepsDone,
  analysisOf,
  LEGACY_STEPS,
  missingDecisions,
  reconciliationRows,
  reconciliationTally,
  stageAll,
  stepGates,
  stepRows,
  summaryOf,
  type StepRow,
} from "@/modules/imports/legacy/flow";
import { legacyUploadSchema } from "@/modules/imports/legacy/schemas";
import {
  checkUploadMeta,
  checkZip,
  isSameOrigin,
  MAX_SHEET_ROWS,
  MAX_WORKBOOK_BYTES,
  readZipDirectory,
  XLSX_MIME,
} from "@/modules/imports/legacy/upload";
import { packStoredZip, unpackZip, workbookPartsFirst, ZipLimitError } from "@/modules/imports/legacy/zip";
import { deflateRawSync } from "node:zlib";
import { buildSyntheticWorkbook, SYNTHETIC_TODAY, syntheticWorkbookBytes } from "./legacy-synthetic";

// Synthetic data only (owner decision A): every workbook here is generated in memory.
const OPTIONS = { ...DEFAULT_OPTIONS, governorateCode: "EG-DK", today: SYNTHETIC_TODAY };
const META = { name: "synthetic.xlsx", type: XLSX_MIME, size: 1 };
let bytes: Uint8Array;
let result: ConvertResult;

beforeAll(async () => {
  bytes = await syntheticWorkbookBytes();
  const converted = await convertUpload(bytes, META, OPTIONS);
  if (!converted.ok) throw new Error(converted.problem);
  result = converted.result;
});

/** A stored (uncompressed) zip; `declared` overrides an entry's uncompressed size in the directory. */
function makeZip(entries: { name: string; data?: string; declared?: number; deflated?: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const u16 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = e.deflated ?? enc.encode(e.data ?? "x");
    const method = e.deflated ? 8 : 0;
    const offset = local.length;
    u32(local, 0x04034b50); u16(local, 20); u16(local, 0); u16(local, method); u16(local, 0); u16(local, 0);
    u32(local, 0); u32(local, data.length); u32(local, data.length); u16(local, name.length); u16(local, 0);
    local.push(...name, ...data);
    u32(central, 0x02014b50); u16(central, 20); u16(central, 20); u16(central, 0); u16(central, method); u16(central, 0); u16(central, 0);
    u32(central, 0); u32(central, data.length); u32(central, e.declared ?? data.length); u16(central, name.length);
    u16(central, 0); u16(central, 0); u16(central, 0); u16(central, 0); u32(central, 0); u32(central, offset);
    central.push(...name);
  }
  const eocd: number[] = [];
  u32(eocd, 0x06054b50); u16(eocd, 0); u16(eocd, 0); u16(eocd, entries.length); u16(eocd, entries.length);
  u32(eocd, central.length); u32(eocd, local.length); u16(eocd, 0);
  return new Uint8Array([...local, ...central, ...eocd]);
}

describe("server-side conversion from an uploaded buffer", () => {
  it("converts the synthetic workbook in memory, with a SHA-256 fingerprint", async () => {
    const converted = await convertUpload(bytes, META, OPTIONS);
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(converted.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(converted.result.files.map((f) => [f.name, f.rows.length])).toEqual([
      ["1-products.csv", 7], ["2-base-prices.csv", 6], ["3-opening-stock.csv", 4], ["4-customers.csv", 5],
      ["5-opening-ar.csv", 2], ["6-opening-ar-credits.csv", 1], ["barcodes-to-verify.csv", 1],
    ]);
  });

  it("reads a workbook with inline strings and no shared-strings part (like the old system's export)", async () => {
    // exceljs always writes shared strings; turn every shared-string cell into an inline string.
    const written = unpackZip(await syntheticWorkbookBytes(), 64 * 1024 * 1024);
    const dec = new TextDecoder();
    const sst = dec.decode(written.find((p) => p.name === "xl/sharedStrings.xml")?.data);
    const strings = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => m[1] ?? "");
    const inline = packStoredZip(
      written
        .filter((p) => p.name !== "xl/sharedStrings.xml")
        .map((p) =>
          p.name.startsWith("xl/worksheets/sheet")
            ? { name: p.name, data: new TextEncoder().encode(dec.decode(p.data).replace(/<c r="([A-Z]+\d+)"([^>]*?) t="s"><v>(\d+)<\/v><\/c>/g, (_, ref: string, attrs: string, n: string) => `<c r="${ref}"${attrs} t="inlineStr"><is>${strings[Number(n)]}</is></c>`)) }
            : p,
        ),
    );
    expect(readZipDirectory(inline)?.some((e) => e.name === "xl/sharedStrings.xml")).toBe(false);
    const out = await convertUpload(inline, META, OPTIONS);
    expect(out.ok && out.result.files.map((f) => f.csv)).toEqual(result.files.map((f) => f.csv));
  });

  it("reports the negative-stock items it leaves out of opening stock", () => {
    expect(result.negativeStock).toEqual([{ itemNo: 301, sku: "RDT-0301", name: "Synthetic flat end taper 882-14-10", quantity: -6 }]);
    expect(result.files.find((f) => f.name === "3-opening-stock.csv")?.rows.some((r) => r.sku === "RDT-0301")).toBe(false);
  });

  it("refuses a workbook without the Customers and Items sheets", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Checks").addRow(["Check"]);
    const out = await convertUpload(await syntheticWorkbookBytes(wb), META, OPTIONS);
    expect(out).toEqual({ ok: false, problem: "missing_sheets" });
  });

  it("stops reading a sheet past the row cap", async () => {
    const wb = buildSyntheticWorkbook();
    const items = wb.getWorksheet("Items");
    for (let i = 0; i < MAX_SHEET_ROWS; i++) items?.addRow([10000 + i, `Synthetic filler ${i}`, "", 1, 1, 0, 0, 0]);
    const out = await convertUpload(await syntheticWorkbookBytes(wb), META, OPTIONS);
    expect(out).toEqual({ ok: false, problem: "too_many_rows" });
  });

  it("a package that only looks like a workbook is unreadable", async () => {
    const fake = makeZip([{ name: "[Content_Types].xml", data: "<nope" }, { name: "xl/workbook.xml", data: "<not-xml" }]);
    const out = await convertUpload(fake, META, OPTIONS);
    expect(out.ok).toBe(false);
  });

  it("today is the Cairo date", () => {
    expect(cairoToday(new Date("2026-11-24T22:30:00Z"))).toBe("2026-11-25"); // 00:30 in Cairo
  });
});

describe("upload validation", () => {
  it("checks name, type and size before reading anything", () => {
    expect(checkUploadMeta(null)).toBe("no_file");
    expect(checkUploadMeta({ name: "a.xlsx", type: XLSX_MIME, size: 0 })).toBe("no_file");
    expect(checkUploadMeta({ name: "a.csv", type: "text/csv", size: 10 })).toBe("not_xlsx");
    expect(checkUploadMeta({ name: "a.xlsx", type: "text/csv", size: 10 })).toBe("not_xlsx");
    expect(checkUploadMeta({ name: "a.xls", type: "application/vnd.ms-excel", size: 10 })).toBe("not_xlsx");
    expect(checkUploadMeta({ name: "a.xlsm", type: XLSX_MIME, size: 10 })).toBe("not_xlsx");
    expect(checkUploadMeta({ name: "A.XLSX", type: "application/octet-stream", size: 10 })).toBeNull();
    expect(checkUploadMeta({ name: "a.xlsx", type: "", size: 10 })).toBeNull();
    expect(checkUploadMeta({ name: "a.xlsx", type: XLSX_MIME, size: MAX_WORKBOOK_BYTES })).toBeNull();
    expect(checkUploadMeta({ name: "a.xlsx", type: XLSX_MIME, size: MAX_WORKBOOK_BYTES + 1 })).toBe("too_large");
  });

  it("reads the zip directory of a real workbook", () => {
    const entries = readZipDirectory(bytes);
    expect(entries?.some((e) => e.name === "xl/workbook.xml")).toBe(true);
    expect(checkZip(bytes)).toBeNull();
  });

  it("refuses bytes that are not a zip, or a zip that is not a workbook", () => {
    expect(checkZip(new TextEncoder().encode("account_no,account_name\n1,x\n"))).toBe("not_zip");
    expect(checkZip(makeZip([{ name: "word/document.xml" }]))).toBe("not_xlsx");
    expect(checkZip(makeZip([{ name: "xl/workbook.xml" }, { name: "xl/vbaProject.bin" }]))).toBe("not_xlsx");
  });

  it("refuses zip bombs: a huge declared size, a huge ratio, too many entries", () => {
    expect(checkZip(makeZip([{ name: "xl/workbook.xml" }, { name: "xl/worksheets/sheet1.xml", declared: 2 ** 31 }]))).toBe("zip_bomb");
    expect(checkZip(makeZip([{ name: "xl/workbook.xml" }, { name: "xl/sharedStrings.xml", data: "abcd", declared: 8 * 1024 * 1024 }]))).toBe("zip_bomb");
    expect(checkZip(makeZip([{ name: "xl/workbook.xml" }, ...Array.from({ length: 450 }, (_, i) => ({ name: `xl/media/${i}.png` }))]))).toBe("zip_bomb");
  });

  it("a bomb that lies about its size is stopped while inflating (real budget, not the declared size)", async () => {
    const bomb = deflateRawSync(new Uint8Array(80 * 1024 * 1024)); // 80 MB of zeros, declared as 100 bytes
    const zip = makeZip([{ name: "xl/workbook.xml" }, { name: "xl/_rels/workbook.xml.rels" }, { name: "xl/worksheets/sheet1.xml", deflated: bomb, declared: 100 }]);
    expect(checkZip(zip)).toBeNull(); // the directory looks harmless
    expect(() => unpackZip(zip, 64 * 1024 * 1024)).toThrow(ZipLimitError);
    expect(await convertUpload(zip, META, OPTIONS)).toEqual({ ok: false, problem: "zip_bomb" });
  });

  it("reads in memory: the package is repacked with the workbook parts before the sheets", () => {
    const parts = unpackZip(bytes, 64 * 1024 * 1024);
    const names = parts.map((p) => p.name);
    // exceljs writes the shared strings after the sheets, which makes its streaming reader spill
    // each sheet to a temporary file; the repacked order avoids that.
    expect(names.indexOf("xl/sharedStrings.xml")).toBeGreaterThan(names.findIndex((n) => n.startsWith("xl/worksheets/")));
    const ordered = workbookPartsFirst(parts).map((p) => p.name);
    expect(ordered.indexOf("xl/sharedStrings.xml")).toBeLessThan(ordered.findIndex((n) => n.startsWith("xl/worksheets/")));
    const repacked = unpackZip(packStoredZip(workbookPartsFirst(parts)), 64 * 1024 * 1024);
    expect(repacked.map((p) => [p.name, p.data.length])).toEqual(workbookPartsFirst(parts).map((p) => [p.name, p.data.length]));
  });

  it("runs the zip checks inside convertUpload too", async () => {
    expect(await convertUpload(new Uint8Array([1, 2, 3, 4]), META, OPTIONS)).toEqual({ ok: false, problem: "not_zip" });
    expect(await convertUpload(bytes, { ...META, name: "synthetic.csv" }, OPTIONS)).toEqual({ ok: false, problem: "not_xlsx" });
  });

  it("accepts only same-origin posts", () => {
    const h = { origin: "https://app.example.test", host: "app.example.test", forwardedHost: null, fetchSite: "same-origin" };
    expect(isSameOrigin(h)).toBe(true);
    expect(isSameOrigin({ ...h, origin: null })).toBe(false);
    expect(isSameOrigin({ ...h, origin: "https://evil.example.test" })).toBe(false);
    expect(isSameOrigin({ ...h, fetchSite: "cross-site" })).toBe(false);
    expect(isSameOrigin({ ...h, host: "internal:3000", forwardedHost: "app.example.test" })).toBe(true);
    expect(isSameOrigin({ ...h, origin: "not a url" })).toBe(false);
  });

  it("validates the form fields of each mode", () => {
    expect(legacyUploadSchema.safeParse({ mode: "analyze", governorate_code: "EG-DK", warehouse_code: "WH-MAIN" }).success).toBe(true);
    expect(legacyUploadSchema.safeParse({ mode: "analyze", governorate_code: "Dakahlia", warehouse_code: "WH-MAIN" }).success).toBe(false);
    const start = legacyUploadSchema.safeParse({
      mode: "start", governorate_code: "EG-DK", warehouse_code: "WH-MAIN", idempotency_key: crypto.randomUUID(),
      decisions: JSON.stringify({ "RDT-0301": "zero" }),
    });
    expect(start.success && start.data.mode === "start" && start.data.credits_mode).toBe("hold");
    expect(legacyUploadSchema.safeParse({ mode: "start", governorate_code: "EG-DK", warehouse_code: "WH-MAIN", idempotency_key: "k-12345678", decisions: '{"RDT-0301":"later"}' }).success).toBe(false);
    expect(legacyUploadSchema.safeParse({ mode: "start", governorate_code: "EG-DK", warehouse_code: "WH-MAIN", idempotency_key: "k-12345678", decisions: "{" }).success).toBe(false);
    expect(legacyUploadSchema.safeParse({ mode: "restage", session_id: crypto.randomUUID(), step: "6", idempotency_key: "k-12345678" }).success).toBe(false);
  });
});

describe("reconciliation display", () => {
  it("maps each check to source / converted / match-mismatch", () => {
    const rows = reconciliationRows(result.reconciliation);
    const by = Object.fromEntries(rows.map((r) => [r.check, r]));
    expect(by["Customers: count"]).toMatchObject({ source: 5, converted: 5, difference: 0, verdict: "match" });
    expect(by["Customers: total debit balance"]).toMatchObject({ source: 1500.5, converted: 1500.5, verdict: "match" });
    expect(by["Items: total quantity on hand"]).toMatchObject({ source: 32, converted: 38, difference: 6, verdict: "mismatch" });
    expect(by["Customers: net opening AR"]).toMatchObject({ source: null, verdict: "info" });
    expect(by["Sales: net total"]).toMatchObject({ verdict: "info", difference: null });
    expect(reconciliationTally(rows)).toEqual({ match: 4, mismatch: 1, info: 4 });
  });

  it("the analysis and the stored summary carry aggregates only", () => {
    const analysis = analysisOf(result, "synthetic.xlsx", "a".repeat(64));
    expect(analysis.steps.map((s) => `${s.stepNo}:${s.kind}:${s.rows}`)).toEqual([
      "1:customers:5", "2:products:7", "3:customer_prices:6", "4:opening_stock:4", "5:opening_ar:2",
    ]);
    expect(analysis.credits).toEqual({ rows: 1, total: 300 });
    const summary = JSON.stringify(summaryOf(analysis, { governorateCode: "EG-DK", warehouseCode: "WH-MAIN" }));
    for (const secret of ["تجربة", "Synthetic Lab", "+20100", "RDT-0301"]) expect(summary).not.toContain(secret);
    expect(summary.length).toBeLessThan(32000);
  });
});

describe("owner decisions shape the staged rows", () => {
  const zero = { negative: { "RDT-0301": "zero" as const }, credits: "hold" as const };

  it("every negative item needs a decision", () => {
    expect(missingDecisions(result.negativeStock, {})).toEqual(["RDT-0301"]);
    expect(stageAll(result, { negative: {}, credits: "hold" })).toEqual({ ok: false, error: { code: "decisions_incomplete", skus: ["RDT-0301"] } });
  });

  it("fix to 0: imported with its price, no stock line", () => {
    const staged = stageAll(result, zero);
    if (!staged.ok) throw new Error("not staged");
    expect(staged.batches.products.some((r) => r.sku === "RDT-0301")).toBe(true);
    expect(staged.batches.customer_prices.some((r) => r.sku === "RDT-0301")).toBe(true);
    expect(staged.batches.opening_stock.some((r) => r.sku === "RDT-0301")).toBe(false);
  });

  it("skip: left out of products, prices and stock", () => {
    const staged = stageAll(result, { ...zero, negative: { "RDT-0301": "skip" } });
    if (!staged.ok) throw new Error("not staged");
    for (const kind of ["products", "customer_prices", "opening_stock"] as const) {
      expect(staged.batches[kind].some((r) => r.sku === "RDT-0301"), kind).toBe(false);
    }
    expect(staged.batches.products).toHaveLength(6);
  });

  it("credits are held by default and join the opening AR only on request", () => {
    expect(stepRows(result, "opening_ar", zero)).toEqual({ ok: true, rows: [
      { customer_no: null, customer_phone: null, amount: "1000.00", customer_legacy_ref: "1" },
      { customer_no: null, customer_phone: null, amount: "500.50", customer_legacy_ref: "4" },
    ] });
    const withCredits = stepRows(result, "opening_ar", { ...zero, credits: "import" });
    expect(withCredits.ok && withCredits.rows.map((r) => r.amount)).toEqual(["1000.00", "500.50", "-300.00"]);
  });

  it("suite 62 stages exactly what the server sends (fix to 0, credits held)", () => {
    const suite = readFileSync(join(__dirname, "../../supabase/tests/database/62_phase_p_legacy_import.test.sql"), "utf8");
    const blocks = Object.fromEntries([...suite.matchAll(/^\('(\w+)', \$j\$([\s\S]*?)\$j\$\)/gm)].map((m) => [m[1] ?? "", JSON.parse(m[2] ?? "[]")]));
    const staged = stageAll(result, zero);
    if (!staged.ok) throw new Error("not staged");
    expect(Object.keys(blocks)).toEqual(LEGACY_STEPS.map((s) => s.kind));
    for (const s of LEGACY_STEPS) expect(blocks[s.kind], s.kind).toEqual(staged.batches[s.kind]);
  });
});

describe("step gating", () => {
  const step = (n: number, status: StepRow["batch_status"], extra: Partial<StepRow> = {}): StepRow => ({
    step_no: n, kind: LEGACY_STEPS[n - 1]!.kind, batch_id: status ? `b${n}` : null, batch_status: status,
    row_count: 1, valid_count: null, error_count: null, committed_count: null, failure: null, failure_row_no: null,
    restaged_count: 0, result: null, ...extra,
  });
  const view = (gates: ReturnType<typeof stepGates>) =>
    gates.map((g) => `${g.state}${g.current ? "*" : ""}${g.canDryRun ? "D" : ""}${g.canCommit ? "C" : ""}${g.canRestage ? "R" : ""}`);

  it("only the first step opens at the start", () => {
    expect(view(stepGates([1, 2, 3, 4, 5].map((n) => step(n, "uploaded")), true))).toEqual(["staged*DR", "locked", "locked", "locked", "locked"]);
  });

  it("a clean dry run allows the commit; errors allow a new dry run or a corrected workbook", () => {
    expect(view(stepGates([step(1, "validated"), step(2, "uploaded")], true))[0]).toBe("checked*DCR");
    expect(view(stepGates([step(1, "failed"), step(2, "uploaded")], true))[0]).toBe("rejected*DR");
  });

  it("the next step opens only after the commit; steps without rows count as done", () => {
    const gates = stepGates([step(1, "committed"), step(2, null), step(3, "uploaded"), step(4, "uploaded"), step(5, null)], true);
    expect(view(gates)).toEqual(["committed", "empty", "staged*DR", "locked", "empty"]);
  });

  it("a discarded step can only be restaged", () => {
    expect(view(stepGates([step(1, "committed"), step(2, "discarded"), step(3, "uploaded")], true)).slice(1)).toEqual(["discarded*R", "locked"]);
  });

  it("a closed session offers nothing", () => {
    expect(view(stepGates([step(1, "validated"), step(2, "uploaded")], false))).toEqual(["checked", "locked"]);
  });

  it("knows when every step is done", () => {
    expect(allStepsDone([step(1, "committed"), step(2, "committed"), step(3, null), step(4, "committed"), step(5, "committed")])).toBe(true);
    expect(allStepsDone([step(1, "committed"), step(2, "validated"), step(3, null), step(4, null), step(5, null)])).toBe(false);
    expect(allStepsDone([step(1, "committed")])).toBe(false);
  });
});
