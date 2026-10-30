"use server";

import { revalidatePath } from "next/cache";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { commissionErrorCode, monthStart } from "./logic";
import { adjustmentSchema, formToObject, invalidFieldsOf, periodActionSchema } from "./schemas";
import type { CommissionActionResult, CommissionActionState } from "./types";

/**
 * Commission mutations. Each action validates FormData, calls exactly one api.*
 * command as the signed-in user and refreshes the commission pages. The forms
 * carry only a month, an employee, a requested adjustment amount and a reason;
 * Postgres decides permission, scope and period state and computes every
 * commission from the payments, invoices and plan rates.
 */

function refresh() {
  revalidatePath("/[locale]/commissions", "layout");
}

const failed = (error: AppError): CommissionActionResult => ({
  ok: false,
  errorCode: commissionErrorCode(error),
  requestId: error.requestId,
});

/** Recalculate an open month now (the cron does the same every night). */
export async function recalculatePeriod(_prev: CommissionActionState, form: FormData): Promise<CommissionActionResult> {
  const parsed = periodActionSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const result = await callCommand("calculate_commission_period", { p_period: monthStart(parsed.data.period) });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: "recalculated" };
}

/** Freeze the oldest open month after it ended (final calculation, then closed). */
export async function closePeriod(_prev: CommissionActionState, form: FormData): Promise<CommissionActionResult> {
  const parsed = periodActionSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const result = await callCommand("close_commission_period", { p_period: monthStart(parsed.data.period) });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: "closed" };
}

/** Request a bonus, clawback or correction; it is posted once the workflow approves it. */
export async function requestAdjustment(_prev: CommissionActionState, form: FormData): Promise<CommissionActionResult> {
  const parsed = adjustmentSchema.safeParse(formToObject(form));
  if (!parsed.success) {
    const fields = invalidFieldsOf(parsed.error);
    return { ok: false, errorCode: fields.includes("reason") ? "REASON_REQUIRED" : "VALIDATION" };
  }
  const v = parsed.data;
  const result = await callCommand<{ status?: string }>("adjust_commission", {
    p_employee_id: v.employee_id,
    p_period: monthStart(v.period),
    p_amount: v.amount,
    p_reason: v.reason,
    p_kind: v.kind,
    p_idempotency_key: v.idempotency_key,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: result.data?.status === "posted" ? "posted" : "pending" };
}
