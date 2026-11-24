import ExcelJS from "exceljs";

/**
 * A small, obviously synthetic workbook shaped like the owner's old-system export (same sheet
 * and column names; Arabic-style names, missing / invalid / shared phones, a credit balance, a
 * Bioner GS1 code, unknown and negative costs, a negative stock row, an item without a price).
 * No real data: every name, phone, code and amount here is made up.
 */
export const SYNTHETIC_TODAY = "2026-11-25";

const CUSTOMER_HEADER = [
  "account_no", "account_name", "account_type", "balance_debit_EGP", "balance_credit_EGP", "net_balance_EGP",
  "balance2_debit_EGP", "balance2_credit_EGP", "mobile", "address", "classification", "account_code", "discount_pct",
  "price_tier", "last_invoice_date", "last_invoice_total_EGP", "last_payment_date", "last_payment_value_EGP",
];
const ITEM_HEADER = [
  "item_no", "item_name", "manufacturer", "qty_on_hand", "sell_price_EGP", "wholesale_price_EGP", "avg_purchase_price_EGP",
  "last_purchase_price_EGP", "category", "color", "size", "unit", "barcode", "gtin", "lot", "expiry_date", "barcode_check",
];

type Cell = string | number | Date | null;

const customer = (no: number, name: string, type: string, debit: number, credit: number, mobile: string, address = ""): Cell[] => [
  no, name, type, debit, credit, debit - credit, 0, 0, mobile || null, address || null, null, null, 0, "الإفتراضى", null, 0, null, 0,
];
const item = (no: number, name: string, maker: string, qty: number, sell: number, avg: number, extra: Partial<Record<string, Cell>> = {}): Cell[] =>
  ITEM_HEADER.map((h) =>
    ({
      item_no: no, item_name: name, manufacturer: maker || null, qty_on_hand: qty, sell_price_EGP: sell, wholesale_price_EGP: 0,
      avg_purchase_price_EGP: avg, last_purchase_price_EGP: 0, ...extra,
    } as Record<string, Cell>)[h] ?? null,
  );

export const SYNTHETIC_CUSTOMERS: Cell[][] = [
  customer(1, "د/تجربة أول", "عميل", 1000, 0, "01000000001"),
  customer(2, "د/ تجربة ثان", "عميل", 0, 0, ""),
  customer(3, "مركز تجريبي", "عميل", 0, 300, "+201100000002", "1 شارع تجريبي"),
  customer(4, "Synthetic Lab", "أخرى", 500.5, 0, "12345"),
  customer(5, "د/تجربة خامس", "عميل", 0, 0, "01000000001"),
];

export const SYNTHETIC_ITEMS: Cell[][] = [
  item(3, "Synthetic Implant DM-3510", "BIONER", 10, 5000, 0, {
    size: "3510", barcode: "(01)00000000000017(11)250101(17)300630(10)", gtin: "00000000000017",
    expiry_date: new Date(Date.UTC(2030, 5, 30)), barcode_check: "GS1 parsed",
  }),
  item(21, "Synthetic Abutment DM-MB15", "BIONER", 5, 1400, 2000),
  item(100, "Synthetic Round 801 Blue-018", "RDT", 20, 160, 0, {
    category: "Burs", barcode: "12345678901234567890123456789012", barcode_check: "needs scanner check",
  }),
  item(200, "Synthetic Clamp DD251-26", "DERBY", 0, 400, 0),
  item(300, "SYNTHETIC MEMBRANE", "STEP", 3, 3000, -60.5),
  item(301, "Synthetic flat end taper 882-14-10", "", -6, 160, 0),
  item(302, "SYNTHETIC BAND", "CHINA", 0, 0, 0),
];

/** The synthetic workbook, built in memory. */
export function buildSyntheticWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const checks = wb.addWorksheet("Checks");
  checks.addRow(["Check", "In this workbook (formula)", "Source report total", "Source", "Difference"]);
  checks.addRow(["Customers: count", { formula: "COUNTA(Customers!A:A)-1", result: 5 }, 5, "synthetic", null]);
  checks.addRow(["Customers: total debit balance", { formula: "SUM(Customers!D:D)", result: 1500.5 }, 1500.5, "synthetic", null]);
  checks.addRow(["Customers: total credit balance", { formula: "SUM(Customers!E:E)", result: 300 }, 300, "synthetic", null]);
  checks.addRow(["Items: total quantity on hand", { formula: "SUM(Items!D:D)", result: 32 }, 32, "synthetic", null]);
  checks.addRow(["Sales: net total", { formula: "SUM(Sales_Invoices!J:J)", result: 1234.5 }, 1234.5, "synthetic", null]);
  checks.addRow([]);
  checks.addRow(["Notes"]);
  const customers = wb.addWorksheet("Customers");
  customers.addRow(CUSTOMER_HEADER);
  for (const r of SYNTHETIC_CUSTOMERS) customers.addRow(r);
  const items = wb.addWorksheet("Items");
  items.addRow(ITEM_HEADER);
  for (const r of SYNTHETIC_ITEMS) items.addRow(r);
  wb.addWorksheet("Sales_Invoices").addRow(["invoice_no", "net_total_EGP"]);
  return wb;
}

/** Writes the synthetic workbook to `path`. */
export async function writeSyntheticWorkbook(path: string): Promise<void> {
  await buildSyntheticWorkbook().xlsx.writeFile(path);
}

/** The synthetic workbook as .xlsx bytes, as the browser uploads it. */
export async function syntheticWorkbookBytes(wb: ExcelJS.Workbook = buildSyntheticWorkbook()): Promise<Uint8Array> {
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
