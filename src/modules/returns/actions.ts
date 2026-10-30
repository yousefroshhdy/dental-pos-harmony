"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { returnErrorCode } from "./logic";
import { creditReturnSchema, formToObject, receiveReturnSchema, requestReturnSchema } from "./schemas";
import type { ReturnActionResult, ReturnActionState } from "./types";

/**
 * Returns mutations. Each action validates FormData, calls exactly one api.*
 * command as the signed-in user and refreshes the returns pages. Hidden inputs
 * only identify records and carry device-generated idempotency keys; Postgres
 * decides permission, scope, state and returnable quantities, and computes
 * every credit and VAT amount from the invoice.
 */

function refresh() {
  revalidatePath("/[locale]/returns", "layout");
  revalidatePath("/[locale]/orders", "layout");
  revalidatePath("/[locale]/finance", "layout");
}

const failed = (error: AppError): ReturnActionResult => ({ ok: false, errorCode: returnErrorCode(error), requestId: error.requestId });

/** Ask to take back delivered goods; it goes to approval (sales.return). Opens the new return. */
export async function requestReturn(_prev: ReturnActionState, form: FormData): Promise<ReturnActionResult> {
  const parsed = requestReturnSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const v = parsed.data;
  const result = await callCommand<{ return_id?: string }>("request_return", {
    p_order_id: v.order_id,
    // Exactly the keys the command accepts per line (requestLineSchema is strict).
    p_lines: v.lines.map((l) => ({ order_item_id: l.order_item_id, lot_id: l.lot_id, quantity: l.quantity, reason_code: l.reason_code })),
    p_notes: v.notes ?? null,
    p_client_ref: v.client_ref,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  if (result.data?.return_id) redirect(`/${v.locale}/returns/${result.data.return_id}?requested=1`);
  return { ok: true, message: "requested" };
}

/** Post the returned goods into a quarantine warehouse. */
export async function receiveReturn(_prev: ReturnActionState, form: FormData): Promise<ReturnActionResult> {
  const parsed = receiveReturnSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const v = parsed.data;
  const result = await callCommand("receive_return", {
    p_return_id: v.return_id,
    p_warehouse_id: v.warehouse_id,
    p_idempotency_key: v.idempotency_key,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: "received" };
}

/** Issue the credit note(s) of a received return at the invoiced prices. */
export async function creditReturn(_prev: ReturnActionState, form: FormData): Promise<ReturnActionResult> {
  const parsed = creditReturnSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const v = parsed.data;
  const result = await callCommand("credit_return", { p_return_id: v.return_id, p_idempotency_key: v.idempotency_key });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: "credited" };
}
