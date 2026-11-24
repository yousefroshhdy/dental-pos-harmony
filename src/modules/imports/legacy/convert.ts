import { toCsv } from "../csv";
import { KIND_SPECS, type ImportKind } from "../kinds";
import type { CellValue, SheetRows, Sheets } from "./workbook";

/**
 * Old accounting/POS workbook → Honest OS import CSVs (pure; no file system). Used by the
 * `pnpm legacy:convert` CLI (scripts/legacy/convert-workbook.ts) and by the browser import on
 * /admin/setup/legacy-import (./server.ts), which runs it in memory.
 *
 * Sheets read: Checks, Customers, Items. The history sheets (Sales_*, Returns_*, Receipts,
 * Payments_Out, Cash_Drawer) are not imported in this pass; their check totals are only reported.
 *
 * Rules (owner decisions, docs/DECISIONS.md Part C 2026-11-24/25):
 *  - Customers.net_balance_EGP → opening AR. net = debit − credit; positive = the customer owes
 *    HONEST, which is the import's sign convention. Credit balances go to a separate file so they
 *    can be confirmed before they are posted.
 *  - Customers without a (valid) phone are imported "phone missing"; governorate is the batch
 *    default the owner picks on the import screen (or --governorate).
 *  - Items: one product and one SKU per item (SKU = brand prefix + old item number), the BASE
 *    (DEFAULT) price list from sell_price_EGP, opening stock from qty_on_hand in the main warehouse.
 *  - Purchase cost unknown (0 or negative in the old system) → cost_unknown = yes, never 0.
 *  - Bioner GS1 codes give GTIN (stored as the barcode) and expiry; the lot AI is empty in the
 *    export, so lot-tracked items get the placeholder lot LEGACY-UNKNOWN until the first count.
 *    Barcodes that were only read from the PDF are NOT imported: they go to barcodes-to-verify.csv.
 */

export interface ConvertOptions {
  /** Warehouse code of the main warehouse (created on /admin/setup). */
  warehouseCode: string;
  /** Governorate code for every customer, or "" to pick it on the import screen. */
  governorateCode: string;
  priceListCode: string;
  priceListName: string;
  /** Business date, YYYY-MM-DD (expired lots are flagged against it). */
  today: string;
}

export const DEFAULT_OPTIONS: Omit<ConvertOptions, "today"> = {
  warehouseCode: "WH-MAIN",
  governorateCode: "",
  priceListCode: "DEFAULT",
  priceListName: "Base price list (old system)",
};

/** Placeholder lot for lot-tracked stock whose lot the old system did not record. */
export const UNKNOWN_LOT = "LEGACY-UNKNOWN";

export interface OutputFile {
  name: string;
  /** The import kind to upload it as on /imports; null = not an import file. */
  kind: ImportKind | null;
  rows: Record<string, string>[];
  csv: string;
}

export interface ReconLine {
  check: string;
  /** What the workbook's Checks sheet says (source report total), if it has the check. */
  expected: number | null;
  /** What the output files hold. */
  output: number;
  difference: number | null;
  status: "ok" | "diff" | "info";
  note: string;
}

/** An item the old system had below zero: left out of opening stock; the owner decides (zero / skip). */
export interface NegativeStockItem {
  itemNo: number;
  sku: string;
  name: string;
  /** The old system's quantity on hand (below zero). */
  quantity: number;
}

export interface ConvertResult {
  files: OutputFile[];
  reconciliation: ReconLine[];
  /** Items with negative stock, in workbook order (also counted in the warnings). */
  negativeStock: NegativeStockItem[];
  /** Counts and reasons only: never names, phones or per-customer amounts. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------
function unwrap(v: CellValue): CellValue {
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    if ("result" in o) return unwrap(o.result);
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((p) => p.text ?? "").join("");
    if ("text" in o) return o.text;
    if ("error" in o) return null;
  }
  return v;
}

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export function cellText(v: CellValue): string {
  const u = unwrap(v);
  if (u === null || u === undefined) return "";
  if (u instanceof Date) return isoDate(u);
  return String(u).replace(/\s+/g, " ").trim();
}

export function cellNumber(v: CellValue): number | null {
  const u = unwrap(v);
  if (typeof u === "number") return Number.isFinite(u) ? u : null;
  if (typeof u === "string") {
    const s = u.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d))).replace(/,/g, "").trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function cellDate(v: CellValue): string | null {
  const u = unwrap(v);
  if (u instanceof Date) return Number.isNaN(u.getTime()) ? null : isoDate(u);
  if (typeof u === "string" && /^\d{4}-\d{2}-\d{2}/.test(u.trim())) return u.trim().slice(0, 10);
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => round2(n).toFixed(2);

/** Header row → lower-case keys; data rows → records; blank rows skipped. */
export function records(rows: SheetRows | undefined): Record<string, CellValue>[] {
  if (!rows || rows.length === 0) return [];
  const header = (rows[0] ?? []).map((h) => cellText(h).toLowerCase());
  const out: Record<string, CellValue>[] = [];
  for (const row of rows.slice(1)) {
    if (!row.some((c) => cellText(c) !== "")) continue;
    const rec: Record<string, CellValue> = {};
    header.forEach((h, i) => {
      if (h) rec[h] = row[i];
    });
    out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing rules
// ---------------------------------------------------------------------------
/** Egyptian mobile → +201xxxxxxxxx, or null when it is not one. */
export function normalizeMobile(raw: string): string | null {
  let s = raw.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d))).replace(/[\s().-]/g, "");
  if (s === "") return null;
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (/^20\d{10}$/.test(s)) s = `+${s}`;
  else if (/^0\d{10}$/.test(s)) s = `+20${s.slice(1)}`;
  return /^\+201[0125]\d{8}$/.test(s) ? s : null;
}

export interface Gs1 {
  gtin?: string;
  expiry?: string;
  lot?: string;
  serial?: string;
}

/** "(01)08435650303935(11)250610(17)300609(10)LOT" → GTIN, expiry (YYMMDD, DD 00 = month end), lot. */
export function parseGs1(raw: string): Gs1 | null {
  if (!/^\(\d{2,4}\)/.test(raw)) return null;
  const out: Gs1 = {};
  for (const [, ai, value = ""] of raw.matchAll(/\((\d{2,4})\)([^()]*)/g)) {
    const v = value.trim();
    if (ai === "01" && /^\d{14}$/.test(v)) out.gtin = v;
    else if (ai === "17" && /^\d{6}$/.test(v)) {
      const y = 2000 + Number(v.slice(0, 2));
      const m = Number(v.slice(2, 4));
      let d = Number(v.slice(4, 6));
      if (m < 1 || m > 12) continue;
      if (d === 0) d = new Date(Date.UTC(y, m, 0)).getUTCDate();
      out.expiry = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    } else if (ai === "10" && v !== "") out.lot = v.slice(0, 64);
    else if (ai === "21" && v !== "") out.serial = v;
  }
  return out;
}

export type BrandCode = "BIONER" | "DERBY" | "RDT" | "STEP" | "GENERIC";
const SKU_PREFIX: Record<BrandCode, string> = { BIONER: "BIO", DERBY: "DRB", RDT: "RDT", STEP: "STP", GENERIC: "GEN" };
const LOT_TRACKED: ReadonlySet<BrandCode> = new Set(["BIONER", "STEP"]);
/** Codes the products file may use that migrations do not seed (added on /admin/setup). */
const NOT_SEEDED: ReadonlySet<string> = new Set(["STEP", "GENERIC", "IMPLANT_PARTS"]);

const BUR_NAME = /\b(bur|taper|taber|round|flat|torpedo|football|bud|needle|cylind|occlusal|pin|depth marker|8\d\d[a-z]?)\b|\b\d{3}[a-z]?-\d/i;

/** Manufacturer as given; items without one are told apart by their codes (DD… = Derby, bur shapes = RDT). */
export function inferBrand(manufacturer: string, name: string, category: string): BrandCode {
  const m = manufacturer.toUpperCase();
  if (m === "BIONER" || m === "DERBY" || m === "RDT" || m === "STEP") return m;
  if (m !== "") return "GENERIC";
  if (/\bD{2,3}\d|\bD{2,3}-?\d/i.test(name)) return "DERBY";
  if (category.toUpperCase() === "RDT" || BUR_NAME.test(name)) return "RDT";
  return "GENERIC";
}

export function inferCategory(brand: BrandCode, name: string): string {
  switch (brand) {
    case "BIONER":
      return /implant/i.test(name) && !/abutment|kit|screw|driver/i.test(name) ? "IMPLANT" : "IMPLANT_PARTS";
    case "RDT":
      return "BUR";
    case "STEP":
      return /membrane/i.test(name) ? "MEMBRANE" : "GRAFT";
    default:
      return "INSTRUMENT";
  }
}

export function skuFor(brand: BrandCode, itemNo: number): string {
  return `${SKU_PREFIX[brand]}-${String(itemNo).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------
function file(name: string, kind: ImportKind | null, columns: readonly string[], rows: Record<string, string>[]): OutputFile {
  return { name, kind, rows, csv: toCsv([columns, ...rows.map((r) => columns.map((c) => r[c] ?? ""))]) };
}

function checksOf(rows: SheetRows | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of (rows ?? []).slice(1)) {
    const label = cellText(row[0]);
    const source = cellNumber(row[2]);
    if (label && source !== null) out.set(label.toLowerCase(), source);
  }
  return out;
}

function line(check: string, expected: number | null | undefined, output: number, note: string, info = false): ReconLine {
  const exp = expected ?? null;
  const difference = exp === null || info ? null : round2(output - exp);
  const status = info || exp === null ? "info" : Math.abs(difference ?? 0) < 0.005 ? "ok" : "diff";
  return { check, expected: exp, output: round2(output), difference, status, note };
}

export function convertWorkbook(sheets: Sheets, options: ConvertOptions): ConvertResult {
  const warnings: string[] = [];
  const checks = checksOf(sheets.Checks);
  const count = (label: string, n: number) => {
    if (n > 0) warnings.push(`${label}: ${n}`);
  };

  // -------------------------------------------------------------- customers
  const customers: Record<string, string>[] = [];
  const arDebit: Record<string, string>[] = [];
  const arCredit: Record<string, string>[] = [];
  const seenPhones = new Set<string>();
  const seenRefs = new Set<string>();
  let sheetDebit = 0;
  let sheetCredit = 0;
  let noPhone = 0;
  let badPhone = 0;
  let sharedPhone = 0;
  let noName = 0;
  let dupRef = 0;
  let zeroBalance = 0;
  let bothSides = 0;
  for (const c of records(sheets.Customers)) {
    const ref = cellText(c.account_no);
    const name = cellText(c.account_name).slice(0, 160);
    const debit = cellNumber(c.balance_debit_egp) ?? 0;
    const credit = cellNumber(c.balance_credit_egp) ?? 0;
    sheetDebit += debit;
    sheetCredit += credit;
    if (debit !== 0 && credit !== 0) bothSides += 1;
    if (!name || !ref) {
      noName += 1;
      continue;
    }
    if (seenRefs.has(ref)) {
      dupRef += 1;
      continue;
    }
    seenRefs.add(ref);

    const notes = [`Old system account ${ref}`];
    const type = cellText(c.account_type);
    if (type && type !== "عميل") notes.push(`old account type: ${type}`);
    const rawPhone = cellText(c.mobile);
    let phone = rawPhone ? normalizeMobile(rawPhone) : null;
    if (rawPhone && !phone) {
      badPhone += 1;
      notes.push(`old-system phone not valid: ${rawPhone}`);
    } else if (phone && seenPhones.has(phone)) {
      sharedPhone += 1;
      notes.push(`old-system phone shared with another account: ${phone}`);
      phone = null;
    }
    if (phone) seenPhones.add(phone);
    else noPhone += 1;

    const isDoctor = /^(د\s*[/.]|د\s|د$|dr\b)/i.test(name);
    customers.push({
      doctor_name: isDoctor ? name : "",
      clinic_name: isDoctor ? "" : name,
      kind: "clinic",
      phone_primary: phone ?? "",
      governorate_code: options.governorateCode,
      address_line: cellText(c.address).slice(0, 300),
      notes: notes.join("; "),
      legacy_ref: ref,
    });

    const net = round2(cellNumber(c.net_balance_egp) ?? debit - credit);
    if (net > 0) arDebit.push({ customer_legacy_ref: ref, amount: money(net) });
    else if (net < 0) arCredit.push({ customer_legacy_ref: ref, amount: money(net) });
    else zeroBalance += 1;
  }
  count("customers without a valid phone (imported as phone missing)", noPhone);
  count("customers whose old phone was not a valid Egyptian mobile (kept in notes)", badPhone);
  count("customers sharing a phone with an earlier account (kept in notes)", sharedPhone);
  count("customer rows skipped: no account number or name", noName);
  count("customer rows skipped: repeated account number", dupRef);
  count("customers with both a debit and a credit balance (net is imported)", bothSides);
  count("credit balances held back in 6-opening-ar-credits.csv (confirm before importing)", arCredit.length);
  if (!options.governorateCode) warnings.push("governorate: pick the batch default on the import screen (Mansoura = EG-DK Dakahlia)");

  // -------------------------------------------------------------- items
  const products: Record<string, string>[] = [];
  const prices: Record<string, string>[] = [];
  const stock: Record<string, string>[] = [];
  const toVerify: Record<string, string>[] = [];
  const negativeStock: NegativeStockItem[] = [];
  const seenBarcodes = new Set<string>();
  const seenSkus = new Set<string>();
  let sheetQty = 0;
  let negativeQty = 0;
  let negativeRows = 0;
  let zeroPrice = 0;
  let costKnown = 0;
  let costUnknown = 0;
  let unknownLots = 0;
  let expired = 0;
  let badItem = 0;
  let dupBarcode = 0;
  let fractionalQty = 0;
  const items = records(sheets.Items);
  for (const it of items) {
    const itemNo = cellNumber(it.item_no);
    const name = cellText(it.item_name).slice(0, 160);
    const qtyRaw = cellNumber(it.qty_on_hand) ?? 0;
    sheetQty += qtyRaw;
    if (itemNo === null || !Number.isInteger(itemNo) || itemNo < 0 || name.length < 2) {
      badItem += 1;
      continue;
    }
    const brand = inferBrand(cellText(it.manufacturer), name, cellText(it.category));
    const sku = skuFor(brand, itemNo);
    if (seenSkus.has(sku)) {
      badItem += 1;
      continue;
    }
    seenSkus.add(sku);

    const rawBarcode = cellText(it.barcode);
    const gs1 = rawBarcode ? parseGs1(rawBarcode) : null;
    const gtinCell = cellText(it.gtin);
    const gtin = /^\d{8,14}$/.test(gtinCell) ? gtinCell : gs1?.gtin;
    const expiry = cellDate(it.expiry_date) ?? gs1?.expiry ?? null;
    const lotCell = cellText(it.lot) || gs1?.lot || "";
    const lotTracked = LOT_TRACKED.has(brand);
    let barcode = "";
    if (gtin) {
      if (seenBarcodes.has(gtin)) dupBarcode += 1;
      else {
        barcode = gtin;
        seenBarcodes.add(gtin);
      }
    } else if (rawBarcode) {
      toVerify.push({ item_no: String(itemNo), sku, barcode_as_read: rawBarcode, check: cellText(it.barcode_check) });
    }

    products.push({
      product_code: sku,
      brand_code: brand,
      category_code: inferCategory(brand, name),
      product_name_en: name,
      lot_tracked: lotTracked ? "yes" : "no",
      expiry_tracked: expiry ? "yes" : "no",
      sku,
      variant_name_en: name,
      barcode,
      uom: "unit",
    });

    const sell = cellNumber(it.sell_price_egp) ?? 0;
    if (sell > 0) {
      prices.push({ price_list_code: options.priceListCode, price_list_name: options.priceListName, sku, unit_price: money(sell) });
    } else zeroPrice += 1;

    if (qtyRaw < 0) {
      negativeRows += 1;
      negativeQty += qtyRaw;
      negativeStock.push({ itemNo, sku, name, quantity: qtyRaw });
    } else if (qtyRaw > 0) {
      const qty = Math.trunc(qtyRaw);
      if (qty !== qtyRaw) fractionalQty += 1;
      const avg = cellNumber(it.avg_purchase_price_egp) ?? 0;
      const last = cellNumber(it.last_purchase_price_egp) ?? 0;
      const cost = avg > 0 ? avg : last > 0 ? last : null;
      if (cost === null) costUnknown += 1;
      else costKnown += 1;
      const lot = lotTracked ? lotCell || UNKNOWN_LOT : lotCell;
      if (lotTracked && !lotCell) unknownLots += 1;
      if (expiry && expiry < options.today) expired += 1;
      if (qty > 0) {
        stock.push({
          warehouse_code: options.warehouseCode,
          sku,
          lot_no: lot,
          expiry_date: expiry ?? "",
          quantity: String(qty),
          unit_cost: cost === null ? "" : money(cost),
          cost_unknown: cost === null ? "yes" : "",
        });
      }
    }
  }
  count("item rows skipped: no item number or name, or a repeated item", badItem);
  count("items with negative stock left out of opening stock (count them)", negativeRows);
  count("items with a fractional quantity (rounded down)", fractionalQty);
  count("items without a sell price (left out of the base price list)", zeroPrice);
  count(`stock lines without a lot number (lot ${UNKNOWN_LOT})`, unknownLots);
  count("stock lines whose lot has already expired (import them into a quarantine warehouse)", expired);
  count("GTINs repeated on another item (kept on the first)", dupBarcode);
  count("barcodes read from the PDF, not imported (check them with a scanner: barcodes-to-verify.csv)", toVerify.length);
  const needed = [...new Set(products.flatMap((p) => [p.brand_code ?? "", p.category_code ?? ""]))].filter((c) => NOT_SEEDED.has(c)).sort();
  if (needed.length > 0) warnings.push(`before 1-products.csv, add on /admin/setup: ${needed.join(", ")} (not seeded brands / category)`);

  // -------------------------------------------------------------- files (in import order)
  const sum = (rows: Record<string, string>[], key: string) => rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);
  const files: OutputFile[] = [
    file("1-products.csv", "products", KIND_SPECS.products.columns, products),
    file("2-base-prices.csv", "customer_prices", KIND_SPECS.customer_prices.columns, prices),
    file("3-opening-stock.csv", "opening_stock", KIND_SPECS.opening_stock.columns, stock),
    file("4-customers.csv", "customers", KIND_SPECS.customers.columns, customers),
    file("5-opening-ar.csv", "opening_ar", KIND_SPECS.opening_ar.columns, arDebit),
  ];
  if (arCredit.length > 0) files.push(file("6-opening-ar-credits.csv", "opening_ar", KIND_SPECS.opening_ar.columns, arCredit));
  files.push(file("barcodes-to-verify.csv", null, ["item_no", "sku", "barcode_as_read", "check"], toVerify));

  // -------------------------------------------------------------- reconciliation
  const units = sum(stock, "quantity");
  const debitOut = sum(arDebit, "amount");
  const creditOut = -sum(arCredit, "amount");
  const cut = (label: string) => checks.get(label.toLowerCase());
  const reconciliation: ReconLine[] = [
    line("Customers: count", cut("Customers: count"), customers.length, `4-customers.csv rows (${noPhone} without phone)`),
    line("Customers: total debit balance", cut("Customers: total debit balance"), debitOut,
      `5-opening-ar.csv total, ${arDebit.length} rows; workbook column total ${money(sheetDebit)}`),
    line("Customers: total credit balance", cut("Customers: total credit balance"), creditOut,
      `6-opening-ar-credits.csv total (as a positive number), ${arCredit.length} rows; workbook column total ${money(sheetCredit)}`),
    line("Customers: net opening AR", null, debitOut - creditOut, `${zeroBalance} customers with a zero balance get no opening entry`, true),
    line("Items: total quantity on hand", cut("Items: total quantity on hand"), units,
      negativeRows > 0
        ? `3-opening-stock.csv units, ${stock.length} lines; workbook column total ${sheetQty}; ${negativeRows} negative rows (${negativeQty}) left out, so the file is ${-negativeQty} above the workbook total`
        : `3-opening-stock.csv units, ${stock.length} lines; workbook column total ${sheetQty}`),
    line("Items: products", items.length, products.length, `1-products.csv rows vs Items rows`),
    line("Items: base prices", null, prices.length, `2-base-prices.csv rows; ${zeroPrice} items without a price`, true),
    line("Items: stock lines with unknown cost", null, costUnknown, `${costKnown} lines carry a cost from the old system`, true),
  ];
  for (const [label, value] of checks) {
    if (/^(sales|returns|receipts|payments)/.test(label)) {
      reconciliation.push(line(label.replace(/^\w/, (c) => c.toUpperCase()), value, 0, "history sheet: not imported in this pass (output stays 0)", true));
    }
  }

  return { files, reconciliation, negativeStock, warnings };
}

/** Plain-text report for the terminal and reconciliation.txt (aggregates only). */
export function formatReport(result: ConvertResult): string {
  const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
  const out: string[] = ["Reconciliation (workbook Checks vs. output files)", ""];
  for (const l of result.reconciliation) {
    const flag = l.status === "ok" ? "OK  " : l.status === "diff" ? "DIFF" : "INFO";
    out.push(`${flag}  ${l.check}: expected ${fmt(l.expected)} · output ${fmt(l.output)} · difference ${fmt(l.difference)}`);
    out.push(`      ${l.note}`);
  }
  out.push("", "Files (import in this order on /imports):");
  for (const f of result.files) out.push(`  ${f.name}  ${f.kind ? `[${f.kind}]` : "[not an import]"}  ${f.rows.length} rows`);
  if (result.warnings.length > 0) {
    out.push("", "Notes:");
    for (const w of result.warnings) out.push(`  - ${w}`);
  }
  return `${out.join("\n")}\n`;
}
