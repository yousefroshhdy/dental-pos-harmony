import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type Grant, type UserContext } from "@/lib/authz/can";
import { parseOverdueScan } from "@/modules/finance/cron";
import {
  allocationLimit,
  cairoToday,
  canCreditInvoice,
  canManageCollection,
  checkAllocations,
  checkCreditLines,
  collectionActions,
  collectionStatusTone,
  daysBetween,
  documentHref,
  FINANCE_ERROR_CODES,
  financeErrorCode,
  fifoPreview,
  invoiceStatusTone,
  isInvoiceOpen,
  normalizeDigits,
  parseAmount,
  parseBucket,
  parseCollectionFilter,
  parseInvoiceFilter,
  parseIsoDate,
  parsePaymentFilter,
  parseUuid,
  paymentActions,
  paymentStatusTone,
  statementPeriod,
  toCents,
  toNumber,
  withQuery,
  type OpenInvoice,
} from "@/modules/finance/logic";
import { financeNav } from "@/modules/finance/nav";
import {
  COLLECTION_ACTIONS,
  COLLECTION_STATUSES,
  INVOICE_STATUSES,
  LEDGER_ENTRY_TYPES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  RECORDABLE_METHODS,
  type StatementRow,
} from "@/modules/finance/types";

// ---------------------------------------------------------------------------
// The UI's enums must match the database CHECK constraints and commands
// ---------------------------------------------------------------------------
const MIGRATIONS = join(__dirname, "../../supabase/migrations");
const allSql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");
const financeSql = readFileSync(join(MIGRATIONS, "20261028000800_finance.sql"), "utf8");
const commandsSql = readFileSync(join(MIGRATIONS, "20261031000100_finance_ar_commands.sql"), "utf8");

function checkValues(table: string, column: string): string[] {
  const block = financeSql.slice(financeSql.indexOf(`create table finance.${table}`));
  const re = new RegExp(`\\b${column}\\s+text[\\s\\S]*?check \\(${column} in \\(([^)]*)\\)\\)`);
  const m = re.exec(block);
  if (!m?.[1]) throw new Error(`no CHECK for ${table}.${column}`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1] as string);
}

describe("enums mirror the database", () => {
  it("invoice, payment, method, ledger and collection statuses", () => {
    expect([...INVOICE_STATUSES].sort()).toEqual(checkValues("invoices", "status").sort());
    expect([...PAYMENT_STATUSES].sort()).toEqual(checkValues("payments", "status").sort());
    expect([...PAYMENT_METHODS].sort()).toEqual(checkValues("payments", "method").sort());
    expect([...LEDGER_ENTRY_TYPES].sort()).toEqual(checkValues("customer_ledger", "entry_type").sort());
    expect([...COLLECTION_STATUSES].sort()).toEqual(checkValues("collection_tasks", "status").sort());
  });

  it("the recordable methods are exactly those api.record_payment accepts", () => {
    const m = /p_method not in \(([^)]*)\)/.exec(commandsSql);
    expect([...RECORDABLE_METHODS].sort()).toEqual([...(m?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort());
  });

  it("collection actions match api.update_collection_task", () => {
    const m = /v_to := case p_action ([\s\S]*?) end;/.exec(commandsSql);
    expect([...(m?.[1] ?? "").matchAll(/when '([a-z_]+)'/g)].map((x) => x[1]).sort()).toEqual([...COLLECTION_ACTIONS].sort());
  });

  it("every error code a finance command raises has a translation key", () => {
    const raised = new Set([...commandsSql.matchAll(/raise exception '([A-Z_]+):/g)].map((x) => x[1] as string));
    for (const code of raised) expect(FINANCE_ERROR_CODES, code).toContain(code);
  });

  it("nav permissions exist in the permission catalogue", () => {
    for (const item of financeNav) {
      expect(item.permission).not.toBeNull();
      expect(allSql).toContain(`'${item.permission}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// Errors and numbers
// ---------------------------------------------------------------------------
describe("financeErrorCode", () => {
  it("keeps finance codes and falls back to the translated generic key", () => {
    expect(financeErrorCode({ code: "OVER_ALLOCATION", messageKey: "UNKNOWN" })).toBe("OVER_ALLOCATION");
    expect(financeErrorCode({ code: "SOMETHING_NEW", messageKey: "PERMISSION_DENIED" })).toBe("PERMISSION_DENIED");
    expect(financeErrorCode({ code: "SOMETHING_NEW", messageKey: "UNKNOWN" })).toBe("UNKNOWN");
  });
});

describe("money parsing", () => {
  it("accepts positive amounts with at most 2 decimals", () => {
    expect(parseAmount("1250")).toBe(1250);
    expect(parseAmount("1,250.50")).toBe(1250.5);
    expect(parseAmount(" 0.75 ")).toBe(0.75);
    expect(parseAmount("١٢٥٠٫٥")).toBe(1250.5);
  });

  it("rejects zero, negatives, too many decimals, junk and huge values", () => {
    for (const bad of ["0", "-5", "10.005", "1e3", "abc", "", "1000000000"]) expect(parseAmount(bad), bad).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });

  it("normalizes Arabic-Indic and Persian digits", () => {
    expect(normalizeDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(normalizeDigits("۰۹")).toBe("09");
  });

  it("converts PostgREST numerics safely", () => {
    expect(toNumber("3351.60")).toBe(3351.6);
    expect(toNumber(null)).toBe(0);
    expect(toNumber("x")).toBe(0);
    expect(toCents("0.1") + toCents("0.2")).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Filters and URL parsing
// ---------------------------------------------------------------------------
describe("filters", () => {
  it("fall back to safe defaults", () => {
    expect(parseInvoiceFilter(undefined)).toBe("open");
    expect(parseInvoiceFilter("overdue")).toBe("overdue");
    expect(parseInvoiceFilter(["paid", "x"])).toBe("paid");
    expect(parseInvoiceFilter("__proto__")).toBe("open");
    expect(parsePaymentFilter("nope", "pending")).toBe("pending");
    expect(parsePaymentFilter("closed")).toBe("closed");
    expect(parseCollectionFilter(undefined)).toBe("active");
    expect(parseBucket("d31_60")).toBe("d31_60");
    expect(parseBucket("d1000")).toBeNull();
  });

  it("parse ids and dates strictly", () => {
    expect(parseUuid("40000000-0000-0000-0000-00000000000A")).toBe("40000000-0000-0000-0000-00000000000a");
    expect(parseUuid("1; drop table")).toBeNull();
    expect(parseIsoDate("2026-02-28")).toBe("2026-02-28");
    expect(parseIsoDate("2026-02-30")).toBeNull();
    expect(parseIsoDate("28/02/2026")).toBeNull();
  });

  it("builds filter links with defined values only", () => {
    expect(withQuery("/finance/invoices", { status: null, customer: "c1", bucket: undefined })).toBe("/finance/invoices?customer=c1");
    expect(withQuery("/finance/invoices", {})).toBe("/finance/invoices");
  });

  it("knows today in Cairo, not UTC", () => {
    // 2026-10-30 23:30 UTC is already 31 October in Cairo (UTC+2, or +3 in summer time).
    expect(cairoToday(new Date("2026-10-30T23:30:00Z"))).toBe("2026-10-31");
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Actions offered
// ---------------------------------------------------------------------------
const ME = "20000000-0000-0000-0000-000000000004";
function ctx(perms: Record<string, Grant["scope"] | [Grant["scope"], number]>): UserContext {
  return {
    ...ANONYMOUS_CONTEXT,
    user_id: "00000000-0000-0000-0000-0000000000a4",
    active: true,
    status: "active",
    employee: { id: ME, employee_no: "E004", full_name_en: "Rep", full_name_ar: null, job_title: "Rep" },
    permissions: Object.fromEntries(
      Object.entries(perms).map(([k, v]) => [k, Array.isArray(v) ? { scope: v[0], limit: v[1] } : { scope: v, limit: null }]),
    ),
  };
}
const rep = ctx({ "finance.payment.record": "own", "finance.payment.read": "own", "finance.invoice.read": "own", "work.task.manage": "own" });
const finance = ctx({
  "finance.payment.confirm": "all",
  "finance.payment.allocate": "all",
  "finance.payment.reverse": "all",
  "finance.credit_note.issue": "all",
  "finance.collection.manage": "all",
});

describe("payment actions", () => {
  it("finance verifies pending payments; reps cannot", () => {
    expect(paymentActions(finance, { status: "pending_verification", unallocated: 0 })).toEqual({
      confirm: true,
      reject: true,
      allocate: false,
      reverse: false,
    });
    expect(paymentActions(rep, { status: "pending_verification", unallocated: 0 })).toEqual({
      confirm: false,
      reject: false,
      allocate: false,
      reverse: false,
    });
  });

  it("a confirmed payment can be allocated while something is unallocated, and reversed", () => {
    expect(paymentActions(finance, { status: "confirmed", unallocated: "500.00" })).toMatchObject({ allocate: true, reverse: true });
    expect(paymentActions(finance, { status: "confirmed", unallocated: "0.00" })).toMatchObject({ allocate: false, reverse: true });
    expect(paymentActions(finance, { status: "bounced", unallocated: 0 })).toMatchObject({ allocate: false, reverse: false });
  });

  it("reads the allocation limit", () => {
    expect(allocationLimit(finance)).toBeNull();
    expect(allocationLimit(ctx({ "finance.payment.allocate": ["all", 1000] }))).toBe(1000);
    expect(allocationLimit(rep)).toBeUndefined();
  });
});

describe("invoice and collection actions", () => {
  it("credit notes only on invoices with something open", () => {
    expect(canCreditInvoice(finance, { status: "partially_paid", open_amount: "10.00" })).toBe(true);
    expect(canCreditInvoice(finance, { status: "paid", open_amount: "0.00" })).toBe(false);
    expect(canCreditInvoice(rep, { status: "issued", open_amount: "10.00" })).toBe(false);
    expect(isInvoiceOpen({ status: "issued", open_amount: 5 })).toBe(true);
    expect(isInvoiceOpen({ status: "credited", open_amount: 0 })).toBe(false);
  });

  it("collection actions follow the task status", () => {
    expect(collectionActions("open")).not.toContain("reopen");
    expect(collectionActions("promised")).toContain("reopen");
    expect(collectionActions("closed")).toEqual([]);
    expect(collectionActions("collected")).toEqual([]);
  });

  it("the assignee rep or finance may update a collection task", () => {
    expect(canManageCollection(rep, { assignee_employee_id: ME })).toBe(true);
    expect(canManageCollection(rep, { assignee_employee_id: "20000000-0000-0000-0000-000000000005" })).toBe(false);
    expect(canManageCollection(finance, { assignee_employee_id: "20000000-0000-0000-0000-000000000005" })).toBe(true);
  });

  it("status tones", () => {
    expect(invoiceStatusTone("issued", true)).toBe("danger");
    expect(invoiceStatusTone("paid")).toBe("success");
    expect(paymentStatusTone("pending_verification")).toBe("warning");
    expect(paymentStatusTone("bounced")).toBe("danger");
    expect(collectionStatusTone("promised", true)).toBe("danger");
  });
});

// ---------------------------------------------------------------------------
// Allocation and credit previews
// ---------------------------------------------------------------------------
const OPEN: OpenInvoice[] = [
  { id: "a", invoice_no: "INV-2026-000001", due_date: "2026-11-29", issue_date: "2026-10-30", open_amount: "1851.60" },
  { id: "b1", invoice_no: "INV-2026-000002", due_date: "2026-10-30", issue_date: "2026-10-30", open_amount: "3335.36" },
  { id: "b2", invoice_no: "INV-2026-000003", due_date: "2026-10-30", issue_date: "2026-10-30", open_amount: "0.85" },
];

describe("FIFO preview", () => {
  it("fills the oldest due first, like api.allocate_payment (suite 27)", () => {
    expect(fifoPreview(OPEN, 4000)).toEqual([
      { invoice_id: "b1", amount: 3335.36 },
      { invoice_id: "b2", amount: 0.85 },
      { invoice_id: "a", amount: 663.79 },
    ]);
  });

  it("stops when the payment is used up", () => {
    expect(fifoPreview(OPEN, "100.00")).toEqual([{ invoice_id: "b1", amount: 100 }]);
    expect(fifoPreview(OPEN, 0)).toEqual([]);
  });
});

describe("checkAllocations", () => {
  it("accepts a valid split", () => {
    expect(checkAllocations({ a: "1500", b1: "", b2: "0.85" }, OPEN, 2000)).toEqual({
      ok: true,
      lines: [
        { invoice_id: "a", amount: 1500 },
        { invoice_id: "b2", amount: 0.85 },
      ],
      total: 1500.85,
    });
  });

  it("blocks over-allocation of an invoice or the payment, and the user's limit", () => {
    expect(checkAllocations({ a: "1851.61" }, OPEN, 5000)).toMatchObject({ ok: false, reason: "exceedsInvoice", invoiceId: "a" });
    expect(checkAllocations({ a: "1500", b1: "600" }, OPEN, 2000)).toMatchObject({ ok: false, reason: "exceedsPayment" });
    expect(checkAllocations({ a: "150" }, OPEN, 2000, 100)).toMatchObject({ ok: false, reason: "exceedsLimit" });
    expect(checkAllocations({ a: "-1" }, OPEN, 2000)).toMatchObject({ ok: false, reason: "invalidAmount" });
    expect(checkAllocations({ zz: "1" }, OPEN, 2000)).toMatchObject({ ok: false, reason: "unknownInvoice" });
    expect(checkAllocations({ a: " " }, OPEN, 2000)).toMatchObject({ ok: false, reason: "empty" });
  });
});

describe("checkCreditLines", () => {
  const lines = [
    { invoice_item_id: "i1", quantity: 3, credited_qty: 1 },
    { invoice_item_id: "i2", quantity: 1, credited_qty: 0 },
  ];
  it("sends whole quantities within what is still creditable", () => {
    expect(checkCreditLines({ i1: "2", i2: "" }, lines)).toEqual({ ok: true, lines: [{ invoice_item_id: "i1", quantity: 2 }] });
    expect(checkCreditLines({ i1: "٢" }, lines)).toEqual({ ok: true, lines: [{ invoice_item_id: "i1", quantity: 2 }] });
  });
  it("refuses more than creditable, fractions and empty input", () => {
    expect(checkCreditLines({ i1: "3" }, lines)).toMatchObject({ ok: false, reason: "exceedsQty" });
    expect(checkCreditLines({ i1: "1.5" }, lines)).toMatchObject({ ok: false, reason: "invalidQty" });
    expect(checkCreditLines({ i1: "0", i2: "" }, lines)).toMatchObject({ ok: false, reason: "empty" });
  });
});

// ---------------------------------------------------------------------------
// Statement period
// ---------------------------------------------------------------------------
function entry(id: number, date: string, amount: number, running: number): StatementRow {
  return {
    entry_id: id,
    customer_id: "c",
    customer_no: "C-0002",
    customer_name: "Synthetic",
    posted_at: `${date}T10:00:00Z`,
    posted_date: date,
    entry_type: amount > 0 ? "invoice" : "payment",
    source_table: amount > 0 ? "finance.invoices" : "finance.payments",
    source_id: "40000000-0000-0000-0000-000000000002",
    document_no: null,
    due_date: null,
    debit: amount > 0 ? amount : 0,
    credit: amount < 0 ? -amount : 0,
    amount,
    running_balance: running,
  };
}
const ROWS = [entry(1, "2026-09-01", 100, 100), entry(2, "2026-09-15", 200, 300), entry(3, "2026-10-02", -30, 270), entry(4, "2026-10-20", 50, 320)];

describe("statementPeriod", () => {
  it("whole ledger: opening 0, closing = last running balance", () => {
    expect(statementPeriod(ROWS, null, null)).toMatchObject({ opening: 0, closing: 320, debit: 350, credit: 30 });
  });

  it("a period carries the balance brought forward and its own totals", () => {
    const p = statementPeriod(ROWS, "2026-10-01", "2026-10-10");
    expect(p).toMatchObject({ opening: 300, closing: 270, debit: 0, credit: 30 });
    expect(p.rows.map((r) => r.entry_id)).toEqual([3]);
  });

  it("an empty period still shows the balance brought forward", () => {
    expect(statementPeriod(ROWS, "2026-10-21", null)).toMatchObject({ opening: 320, closing: 320, rows: [] });
  });

  it("when older rows were not loaded, the opening comes from the first row", () => {
    expect(statementPeriod(ROWS.slice(2), null, null)).toMatchObject({ opening: 300, closing: 320 });
  });

  it("links ledger rows to their documents", () => {
    expect(documentHref({ source_table: "finance.invoices", source_id: "40000000-0000-0000-0000-000000000002" })).toBe(
      "/finance/invoices/40000000-0000-0000-0000-000000000002",
    );
    expect(documentHref({ source_table: "finance.credit_notes", source_id: "40000000-0000-0000-0000-000000000002" })).toBeNull();
    expect(documentHref({ source_table: "finance.payments", source_id: "not-a-uuid" })).toBeNull();
  });
});

describe("overdue cron summary", () => {
  it("keeps counts only and tolerates malformed payloads", () => {
    expect(parseOverdueScan({ business_date: "2026-10-30", scanned: 7, created: 7, unassigned: 0 })).toEqual({
      business_date: "2026-10-30",
      scanned: 7,
      created: 7,
      unassigned: 0,
    });
    expect(parseOverdueScan(null)).toEqual({ business_date: null, scanned: 0, created: 0, unassigned: 0 });
    expect(parseOverdueScan({ created: "7", scanned: -1 })).toMatchObject({ created: 0, scanned: 0 });
  });
});
