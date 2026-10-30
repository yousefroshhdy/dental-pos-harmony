"use server";

import { revalidatePath } from "next/cache";
import { callCommand } from "@/lib/command";
import { dashboardErrorCode } from "./logic";
import { formToObject, targetSchema } from "./schemas";
import type { TargetActionState } from "./types";

/**
 * Set a KPI target through api.set_kpi_target (perf.target.manage, scope checked in
 * Postgres). The form carries a server-generated target id, so a repeated submit is a
 * replay, not a second target.
 */
export async function setKpiTarget(_prev: TargetActionState, form: FormData): Promise<TargetActionState> {
  const parsed = targetSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const v = parsed.data;
  const result = await callCommand("set_kpi_target", {
    p_target_id: v.target_id,
    p_kpi_code: v.kpi_code,
    p_period_start: v.period_start,
    p_period_end: v.period_end,
    p_target_value: v.target_value,
    p_employee_id: v.subject === "employee" ? v.employee_id : null,
    p_role_id: v.subject === "role" ? v.role_id : null,
    p_territory_id: v.subject === "territory" ? v.territory_id : null,
  });
  if (!result.ok) return { ok: false, errorCode: dashboardErrorCode(result.error), requestId: result.error.requestId };
  revalidatePath("/[locale]/dashboard", "page");
  revalidatePath("/[locale]/dashboard/targets", "page");
  return { ok: true };
}
