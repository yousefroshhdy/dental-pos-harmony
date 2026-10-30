import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COLLECTION_FILTERS, FINANCE_ERROR_CODES, INVOICE_FILTERS, PAYMENT_FILTERS } from "@/modules/finance/logic";
import { financeNav } from "@/modules/finance/nav";
import {
  AGING_BUCKETS,
  COLLECTION_ACTIONS,
  COLLECTION_STATUSES,
  INVOICE_STATUSES,
  LEDGER_ENTRY_TYPES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
} from "@/modules/finance/types";

type Tree = Record<string, unknown>;
const load = (locale: string) => JSON.parse(readFileSync(join(__dirname, `../../messages/${locale}/finance.json`), "utf8")) as Tree;
const at = (tree: Tree, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], tree);
const ETA_STATUSES = ["not_required", "pending", "submitted", "valid", "invalid", "rejected", "cancelled"];

describe.each(["ar", "en"])("finance messages (%s)", (locale) => {
  const messages = load(locale);

  it("translate every status, method, bucket, ledger type and error code", () => {
    for (const s of INVOICE_STATUSES) expect(at(messages, `invoiceStatus.${s}`), s).toEqual(expect.any(String));
    for (const s of PAYMENT_STATUSES) expect(at(messages, `paymentStatus.${s}`), s).toEqual(expect.any(String));
    for (const s of COLLECTION_STATUSES) expect(at(messages, `collectionStatus.${s}`), s).toEqual(expect.any(String));
    for (const m of PAYMENT_METHODS) expect(at(messages, `method.${m}`), m).toEqual(expect.any(String));
    for (const b of AGING_BUCKETS) expect(at(messages, `aging.buckets.${b}`), b).toEqual(expect.any(String));
    for (const e of LEDGER_ENTRY_TYPES) expect(at(messages, `ledgerType.${e}`), e).toEqual(expect.any(String));
    for (const e of ETA_STATUSES) expect(at(messages, `etaStatus.${e}`), e).toEqual(expect.any(String));
    for (const a of COLLECTION_ACTIONS) expect(at(messages, `collections.actions.${a}`), a).toEqual(expect.any(String));
    for (const c of FINANCE_ERROR_CODES) expect(at(messages, `errors.${c}`), c).toEqual(expect.any(String));
  });

  it("translate every filter, success message and nav entry", () => {
    for (const f of Object.keys(INVOICE_FILTERS)) expect(at(messages, `invoices.filters.${f}`), f).toEqual(expect.any(String));
    for (const f of Object.keys(PAYMENT_FILTERS)) expect(at(messages, `payments.filters.${f}`), f).toEqual(expect.any(String));
    for (const f of Object.keys(COLLECTION_FILTERS)) expect(at(messages, `collections.filters.${f}`), f).toEqual(expect.any(String));
    for (const k of ["issued", "pending", "confirmed", "recorded", "done"]) expect(at(messages, `messages.${k}`), k).toEqual(expect.any(String));
    for (const item of financeNav) expect(at(messages, item.labelKey.replace(/^finance\./, "")), item.labelKey).toEqual(expect.any(String));
  });

  it("client-side checks have messages", () => {
    for (const k of ["empty", "invalidQty", "exceedsQty", "invalidAmount"]) expect(at(messages, `credit.check.${k}`), k).toEqual(expect.any(String));
    for (const k of ["empty", "invalidAmount", "exceedsInvoice", "exceedsPayment", "exceedsLimit", "unknownInvoice"]) {
      expect(at(messages, `allocate.check.${k}`), k).toEqual(expect.any(String));
    }
  });

  it("UNKNOWN carries the request id placeholder", () => {
    expect(at(messages, "errors.UNKNOWN")).toContain("{requestId}");
  });
});

describe("finance nav", () => {
  it("each entry is permission-gated and lives in the finance namespace", () => {
    expect(financeNav.map((i) => [i.href, i.permission])).toEqual([
      ["/finance/invoices", "finance.invoice.read"],
      ["/finance/payments", "finance.payment.read"],
      ["/finance/payments/new", "finance.payment.record"],
      ["/finance/aging", "finance.page.aging"],
      ["/finance/collections", "finance.collection.manage"],
    ]);
    for (const item of financeNav) expect(item.labelKey.startsWith("finance.nav.")).toBe(true);
  });
});
