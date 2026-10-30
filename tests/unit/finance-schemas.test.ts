import { describe, expect, it } from "vitest";
import {
  allocateSchema,
  collectionUpdateSchema,
  creditNoteSchema,
  formToObject,
  invalidFieldsOf,
  issueInvoiceSchema,
  recordPaymentSchema,
  reversePaymentSchema,
} from "@/modules/finance/schemas";

const CUSTOMER = "40000000-0000-0000-0000-000000000001";
const REF = "f7200000-0000-0000-0000-000000000001";
const KEY = "0d6f1a3e-9a7b-4c2d-8e1f-123456789abc";

describe("formToObject", () => {
  it("trims strings and drops empty values and files", () => {
    const form = new FormData();
    form.set("a", "  x ");
    form.set("b", "   ");
    form.set("c", new Blob(["file"]));
    expect(formToObject(form)).toEqual({ a: "x" });
  });
});

describe("recordPaymentSchema", () => {
  const base = { customer_id: CUSTOMER, amount: "2,000.50", method: "cash", client_ref: REF, locale: "ar" };

  it("parses the amount the person typed", () => {
    const r = recordPaymentSchema.safeParse(base);
    expect(r.success && r.data.amount).toBe(2000.5);
  });

  it("requires a client reference for offline-safe retries", () => {
    expect(recordPaymentSchema.safeParse({ ...base, client_ref: undefined }).success).toBe(false);
  });

  it("a cheque needs its number and due date; other methods have no due date", () => {
    const cheque = recordPaymentSchema.safeParse({ ...base, method: "cheque" });
    expect(cheque.success).toBe(false);
    if (!cheque.success) expect(invalidFieldsOf(cheque.error).sort()).toEqual(["cheque_due_date", "reference"]);
    expect(recordPaymentSchema.safeParse({ ...base, method: "cheque", reference: "CHQ-1", cheque_due_date: "2026-11-15" }).success).toBe(true);
    expect(recordPaymentSchema.safeParse({ ...base, cheque_due_date: "2026-11-15" }).success).toBe(false);
  });

  it("Paymob and unknown methods cannot be recorded by hand", () => {
    expect(recordPaymentSchema.safeParse({ ...base, method: "paymob_card" }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ ...base, method: "crypto" }).success).toBe(false);
  });

  it("rejects invalid amounts and timestamps", () => {
    expect(recordPaymentSchema.safeParse({ ...base, amount: "0" }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ ...base, amount: "1.234" }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ ...base, received_at: "yesterday" }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ ...base, received_at: "2026-10-30T08:00:00.000Z" }).success).toBe(true);
  });
});

describe("creditNoteSchema", () => {
  const base = { invoice_id: CUSTOMER, reason: "damaged on delivery", idempotency_key: KEY, locale: "en" };

  it("lines carry only an invoice line and a whole quantity", () => {
    const ok = creditNoteSchema.safeParse({ ...base, mode: "lines", lines: JSON.stringify([{ invoice_item_id: REF, quantity: 2 }]) });
    expect(ok.success).toBe(true);
    const withAmount = creditNoteSchema.safeParse({
      ...base,
      mode: "lines",
      lines: JSON.stringify([{ invoice_item_id: REF, quantity: 2, amount: 1 }]),
    });
    expect(withAmount.success).toBe(false);
    expect(creditNoteSchema.safeParse({ ...base, mode: "lines", lines: JSON.stringify([{ invoice_item_id: REF, quantity: 1.5 }]) }).success).toBe(false);
  });

  it("amount mode needs an amount; a reason is always required", () => {
    expect(creditNoteSchema.safeParse({ ...base, mode: "amount" }).success).toBe(false);
    expect(creditNoteSchema.safeParse({ ...base, mode: "amount", amount: "100" }).success).toBe(true);
    const noReason = creditNoteSchema.safeParse({ ...base, reason: "x", mode: "amount", amount: "100" });
    expect(noReason.success).toBe(false);
    if (!noReason.success) expect(invalidFieldsOf(noReason.error)).toContain("reason");
  });
});

describe("allocateSchema", () => {
  const base = { payment_id: REF, idempotency_key: KEY, locale: "ar" };
  it("FIFO sends no split", () => {
    expect(allocateSchema.safeParse({ ...base, mode: "fifo" }).success).toBe(true);
  });
  it("a manual split has invoice ids and 2-decimal amounts only", () => {
    expect(allocateSchema.safeParse({ ...base, mode: "manual" }).success).toBe(false);
    expect(allocateSchema.safeParse({ ...base, mode: "manual", allocations: JSON.stringify([{ invoice_id: CUSTOMER, amount: 1500.25 }]) }).success).toBe(true);
    expect(allocateSchema.safeParse({ ...base, mode: "manual", allocations: JSON.stringify([{ invoice_id: CUSTOMER, amount: 1.001 }]) }).success).toBe(false);
    expect(
      allocateSchema.safeParse({ ...base, mode: "manual", allocations: JSON.stringify([{ invoice_id: CUSTOMER, amount: 10, total: 10 }]) }).success,
    ).toBe(false);
    expect(allocateSchema.safeParse({ ...base, mode: "manual", allocations: "not json" }).success).toBe(false);
  });
});

describe("other finance forms", () => {
  it("issue invoice needs the order and an idempotency key", () => {
    expect(issueInvoiceSchema.safeParse({ order_id: CUSTOMER, idempotency_key: KEY, locale: "ar" }).success).toBe(true);
    expect(issueInvoiceSchema.safeParse({ order_id: CUSTOMER, idempotency_key: "short", locale: "ar" }).success).toBe(false);
  });

  it("reverse payment needs a reason; bounced is a checkbox", () => {
    const r = reversePaymentSchema.safeParse({ payment_id: REF, reason: "returned by bank", bounced: "on", locale: "en" });
    expect(r.success && r.data.bounced).toBe("on");
    expect(reversePaymentSchema.safeParse({ payment_id: REF, locale: "en" }).success).toBe(false);
  });

  it("a promise needs a date; escalate and close need a note", () => {
    const base = { task_id: REF, locale: "ar" };
    expect(collectionUpdateSchema.safeParse({ ...base, action: "promise" }).success).toBe(false);
    expect(collectionUpdateSchema.safeParse({ ...base, action: "promise", promised_date: "2026-11-02", promised_amount: "500" }).success).toBe(true);
    expect(collectionUpdateSchema.safeParse({ ...base, action: "close" }).success).toBe(false);
    expect(collectionUpdateSchema.safeParse({ ...base, action: "close", note: "settled by transfer" }).success).toBe(true);
    expect(collectionUpdateSchema.safeParse({ ...base, action: "archive" }).success).toBe(false);
  });
});
