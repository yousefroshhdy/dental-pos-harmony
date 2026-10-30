"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { financeErrorCode } from "./logic";
import {
  allocateSchema,
  collectionUpdateSchema,
  creditNoteSchema,
  formToObject,
  invalidFieldsOf,
  issueInvoiceSchema,
  paymentReasonSchema,
  paymentRefSchema,
  recordPaymentSchema,
  reverseAllocationSchema,
  reversePaymentSchema,
} from "./schemas";
import type { FinanceActionResult, FinanceActionState } from "./types";

/**
 * Finance mutations. Each action validates FormData, calls exactly one api.*
 * command as the signed-in user and refreshes the finance pages. Hidden inputs
 * only identify records and carry device-generated idempotency keys; the
 * database decides permission, scope and status and computes every invoice,
 * VAT, credit and balance amount.
 */

function refresh() {
  revalidatePath("/[locale]/finance", "layout");
}

const failed = (error: AppError): FinanceActionResult => ({ ok: false, errorCode: financeErrorCode(error), requestId: error.requestId });
const invalid = (fields: string[] = []): FinanceActionResult => ({
  ok: false,
  errorCode: fields.includes("reason") || fields.includes("note") ? "REASON_REQUIRED" : "VALIDATION",
});

/** Issue the invoice for an order's fulfilled, not yet invoiced quantity, then open it. */
export async function issueInvoice(_prev: FinanceActionState, form: FormData): Promise<FinanceActionResult> {
  const parsed = issueInvoiceSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid();
  const { order_id, idempotency_key, locale } = parsed.data;
  const result = await callCommand<{ invoice_id?: string }>("issue_invoice", { p_order_id: order_id, p_idempotency_key: idempotency_key });
  if (!result.ok) return failed(result.error);
  refresh();
  if (result.data?.invoice_id) redirect(`/${locale}/finance/invoices/${result.data.invoice_id}?issued=1`);
  return { ok: true, message: "issued" };
}

/** Request a credit note (lines or a goodwill amount); it is issued once approved. */
export async function requestCreditNote(_prev: FinanceActionState, form: FormData): Promise<FinanceActionResult> {
  const parsed = creditNoteSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error));
  const v = parsed.data;
  const result = await callCommand<{ status?: string }>("issue_credit_note", {
    p_invoice_id: v.invoice_id,
    // Exactly the keys the command accepts per line (creditLineSchema is strict).
    p_lines: v.mode === "lines" ? (v.lines ?? []).map((l) => ({ invoice_item_id: l.invoice_item_id, quantity: l.quantity })) : null,
    p_amount: v.mode === "amount" ? v.amount : null,
    p_reason: v.reason,
    p_idempotency_key: v.idempotency_key,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: result.data?.status === "issued" ? "issued" : "pending" };
}

/** Record money received (reps in the field, or finance). The device generates client_ref once per attempt. */
export async function recordPayment(_prev: FinanceActionState, form: FormData): Promise<FinanceActionResult> {
  const parsed = recordPaymentSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error));
  const v = parsed.data;
  const result = await callCommand<{ payment_id?: string; status?: string }>("record_payment", {
    p_customer_id: v.customer_id,
    p_amount: v.amount,
    p_method: v.method,
    p_reference: v.reference ?? null,
    p_received_at: v.received_at ?? null,
    p_client_ref: v.client_ref,
    p_cheque_due_date: v.cheque_due_date ?? null,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  if (result.data?.payment_id) redirect(`/${v.locale}/finance/payments/${result.data.payment_id}?recorded=1`);
  return { ok: true, message: "recorded" };
}

export async function confirmPayment(_prev: FinanceActionState, form: FormData): Promise<FinanceActionResult> {
  const parsed = paymentRefSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid();
  const result = await callCommand("confirm_payment", { p_payment_id: parsed.data.payment_id });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: "confirmed" };
}

export async function rejectPayment(_prev: FinanceActionState, form: FormData): Promise<FinanceActionResult> {
  const parsed = paymentReasonSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error));
  const result = await callCommand("reject_payment", { p_payment_id: parsed.data.payment_id, p_reason: parsed.data.reason });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: "done" };
}

export async function reversePayment(_prev: FinanceActionState, form: FormData): Promise<FinanceActionResult> {
  const parsed = reversePaymentSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error));
  const result = await callCommand("reverse_payment", {
    p_payment_id: parsed.data.payment_id,
    p_reason: parsed.data.reason,
    p_bounced: parsed.data.bounced !== undefined,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: "done" };
}

/** Allocate a confirmed payment: manual split, or FIFO (oldest due first) when mode = fifo. */
export async function allocatePayment(_prev: FinanceActionState, form: FormData): Promise<FinanceActionResult> {
  const parsed = allocateSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid();
  const v = parsed.data;
  const result = await callCommand("allocate_payment", {
    p_payment_id: v.payment_id,
    p_allocations: v.mode === "fifo" ? null : (v.allocations ?? []).map((a) => ({ invoice_id: a.invoice_id, amount: a.amount })),
    p_idempotency_key: v.idempotency_key,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: "done" };
}

export async function reverseAllocation(_prev: FinanceActionState, form: FormData): Promise<FinanceActionResult> {
  const parsed = reverseAllocationSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error));
  const result = await callCommand("reverse_allocation", { p_allocation_id: parsed.data.allocation_id, p_reason: parsed.data.reason });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: "done" };
}

/** Promise-to-pay, reopen (broken promise), escalate, collected, close. */
export async function updateCollectionTask(_prev: FinanceActionState, form: FormData): Promise<FinanceActionResult> {
  const parsed = collectionUpdateSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error));
  const v = parsed.data;
  const result = await callCommand("update_collection_task", {
    p_task_id: v.task_id,
    p_action: v.action,
    p_promised_date: v.action === "promise" ? (v.promised_date ?? null) : null,
    p_promised_amount: v.action === "promise" ? (v.promised_amount ?? null) : null,
    p_note: v.note ?? null,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: "done" };
}
