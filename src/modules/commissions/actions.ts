"use server";

import { revalidatePath } from "next/cache";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { commissionErrorCode, monthStart } from "./logic";
import {
  activatePlanSchema,
  adjustmentSchema,
  createPlanSchema,
  deactivatePlanSchema,
  formToObject,
  invalidFieldsOf,
  periodActionSchema,
  rateSchema,
} from "./schemas";
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

const failed = (error: AppError): CommissionActionResult => {
  const errorCode = commissionErrorCode(error);
  return { ok: false, errorCode, requestId: error.requestId, ...(errorCode === "MFA_REQUIRED" ? { mfaRequired: true } : {}) };
};

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

// ---------------------------------------------------------------------------
// Rate editor (owner only; perf.commission_plan.manage needs a verified second factor once
// MFA is enforced). An MFA_REQUIRED failure wrote nothing: the forms re-submit the same
// FormData after step-up (useStepUpAction).
// ---------------------------------------------------------------------------

/** A new draft plan (basis: collected cash). */
export async function createPlan(_prev: CommissionActionState, form: FormData): Promise<CommissionActionResult> {
  const parsed = createPlanSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const result = await callCommand<{ plan_id?: string }>("create_commission_plan", { p_code: parsed.data.code, p_name: parsed.data.name });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: "planCreated", planId: result.data?.plan_id };
}

/** Set or remove one rate from a day on (append-only; the database closes the previous one). */
export async function setRate(_prev: CommissionActionState, form: FormData): Promise<CommissionActionResult> {
  const parsed = rateSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const v = parsed.data;
  const result = await callCommand("set_commission_rate", {
    p_plan_id: v.plan_id,
    p_target: v.target,
    p_target_id: v.target_id ?? null,
    p_rate_pct: v.rate_pct,
    p_effective_from: v.effective_from,
    p_note: v.note ?? null,
    p_idempotency_key: v.idempotency_key,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: v.rate_pct === null ? "rateCleared" : "rateSet" };
}

/** Draft → active from a day; optionally assigns every sales rep to the plan from that day. */
export async function activatePlan(_prev: CommissionActionState, form: FormData): Promise<CommissionActionResult> {
  const parsed = activatePlanSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const result = await callCommand("activate_commission_plan", {
    p_plan_id: parsed.data.plan_id,
    p_effective_from: parsed.data.effective_from,
    p_assign_sales_reps: parsed.data.assign_sales_reps === "1",
  });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: "planActivated" };
}

/** Active → retired after a day (the plan keeps applying to the days it covered). */
export async function deactivatePlan(_prev: CommissionActionState, form: FormData): Promise<CommissionActionResult> {
  const parsed = deactivatePlanSchema.safeParse(formToObject(form));
  if (!parsed.success) {
    const fields = invalidFieldsOf(parsed.error);
    return { ok: false, errorCode: fields.includes("reason") ? "REASON_REQUIRED" : "VALIDATION" };
  }
  const result = await callCommand("deactivate_commission_plan", {
    p_plan_id: parsed.data.plan_id,
    p_effective_to: parsed.data.effective_to,
    p_reason: parsed.data.reason,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, message: "planDeactivated" };
}
