"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callCommand } from "@/lib/command";
import { log } from "@/lib/log";
import { placesServerKey } from "@/lib/places/client";
import { getRequestId } from "@/lib/request-id";
import { createServiceClient } from "@/lib/supabase/admin";
import { runDiscoveryJob } from "./discovery";
import { toLeadsFailure } from "./logic";
import { listBaseLocations, listOpenLeadIds } from "./queries";
import {
  bulkReassignSchema,
  convertLeadSchema,
  formToObject,
  leadNotesSchema,
  leadPlanSchema,
  leadStatusSchema,
  radiusSchema,
  reassignLeadsSchema,
  runNowSchema,
} from "./schemas";
import type { LeadsActionResult, LeadsActionState } from "./types";

/**
 * Leads mutations, as the signed-in user through api.* commands. Hidden inputs are untrusted: the
 * database re-checks crm.lead.* permissions, the employee scope and every rule.
 */

function refresh() {
  revalidatePath("/[locale]/leads", "page");
  revalidatePath("/[locale]/leads/[id]", "page");
  revalidatePath("/[locale]/leads/team", "page");
}

const invalid: LeadsActionResult = { ok: false, messageKey: "VALIDATION" };

export async function setLeadStatus(_prev: LeadsActionState, form: FormData): Promise<LeadsActionResult> {
  const parsed = leadStatusSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid;
  const result = await callCommand("set_lead_status", { p_lead_id: parsed.data.lead_id, p_status: parsed.data.status });
  if (!result.ok) return toLeadsFailure(result.error);
  refresh();
  return { ok: true, message: "saved" };
}

export async function saveLeadNotes(_prev: LeadsActionState, form: FormData): Promise<LeadsActionResult> {
  const parsed = leadNotesSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid;
  const result = await callCommand("set_lead_notes", { p_lead_id: parsed.data.lead_id, p_notes: parsed.data.notes ?? null });
  if (!result.ok) return toLeadsFailure(result.error);
  refresh();
  return { ok: true, message: "saved" };
}

/** Add a lead to a day's plan (api.plan_lead_visit: the plan rules and daily cap), or remove it. */
export async function planLead(_prev: LeadsActionState, form: FormData): Promise<LeadsActionResult> {
  const parsed = leadPlanSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid;
  const { lead_id, date, plan } = parsed.data;
  const result =
    plan === "remove"
      ? await callCommand("unplan_lead_visit", { p_lead_id: lead_id })
      : await callCommand("plan_lead_visit", { p_lead_id: lead_id, p_date: date });
  if (!result.ok) return toLeadsFailure(result.error);
  refresh();
  return { ok: true, message: plan === "remove" ? "unplanned" : "planned" };
}

/**
 * First visit: the rep's own record of the clinic becomes a CRM prospect (api.convert_lead →
 * api.create_customer), then the rep checks in at it; the check-in fix is proposed as the
 * clinic pin (step-3 flow). The client ref makes a resubmitted form a replay.
 */
export async function convertLead(_prev: LeadsActionState, form: FormData): Promise<LeadsActionResult> {
  const parsed = convertLeadSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid;
  const p = parsed.data;
  const result = await callCommand<{ customer_id: string }>("convert_lead", {
    p_lead_id: p.lead_id,
    p_doctor_name: p.doctor_name ?? null,
    p_clinic_name: p.clinic_name ?? null,
    p_phone: p.phone ?? null,
    p_specialty_code: p.specialty_code ?? null,
    p_governorate_code: p.governorate_code,
    p_city: p.city ?? null,
    p_notes: p.notes ?? null,
    p_client_ref: p.client_ref,
  });
  if (!result.ok) return toLeadsFailure(result.error);
  refresh();
  const locale = form.get("ui_locale") === "en" ? "en" : "ar";
  redirect(`/${locale}/visits/new?customer=${encodeURIComponent(result.data.customer_id)}`);
}

export async function reassignLeads(_prev: LeadsActionState, form: FormData): Promise<LeadsActionResult> {
  const parsed = reassignLeadsSchema.safeParse(formToObject(form));
  if (!parsed.success) {
    return parsed.error.issues.some((i) => i.path[0] === "reason") ? { ok: false, messageKey: "REASON_REQUIRED" } : invalid;
  }
  const result = await callCommand<{ moved: number }>("reassign_leads", {
    p_lead_ids: parsed.data.lead_ids,
    p_employee_id: parsed.data.employee_id,
    p_reason: parsed.data.reason,
  });
  if (!result.ok) return toLeadsFailure(result.error);
  refresh();
  return { ok: true, message: "moved", count: Number(result.data.moved) || 0 };
}

/** Team page: move every open lead of one rep to another (in batches of up to 500). */
export async function reassignAllLeads(_prev: LeadsActionState, form: FormData): Promise<LeadsActionResult> {
  const parsed = bulkReassignSchema.safeParse(formToObject(form));
  if (!parsed.success) {
    return parsed.error.issues.some((i) => i.path[0] === "reason") ? { ok: false, messageKey: "REASON_REQUIRED" } : invalid;
  }
  const ids = await listOpenLeadIds(parsed.data.from_employee_id);
  if (!ids.ok) return toLeadsFailure(ids.error);
  if (ids.data.length === 0) return { ok: true, message: "moved", count: 0 };
  const result = await callCommand<{ moved: number }>("reassign_leads", {
    p_lead_ids: ids.data,
    p_employee_id: parsed.data.employee_id,
    p_reason: parsed.data.reason,
  });
  if (!result.ok) return toLeadsFailure(result.error);
  refresh();
  return { ok: true, message: "moved", count: Number(result.data.moved) || 0 };
}

/**
 * The owner's "Run now": the database queues the run (owner check), then this server runs it at
 * once with the service role, exactly as the daily cron would (the caps apply in the claim).
 */
export async function runDiscoveryNow(_prev: LeadsActionState, form: FormData): Promise<LeadsActionResult> {
  const parsed = runNowSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid;
  const queued = await callCommand<{ run_id: string }>("request_lead_discovery", { p_employee_id: parsed.data.employee_id });
  if (!queued.ok) return toLeadsFailure(queued.error);
  const key = placesServerKey();
  const requestId = await getRequestId();
  try {
    const service = createServiceClient();
    const outcome = await runDiscoveryJob({
      rpc: (fn, args) => service.rpc(fn, args),
      key,
      runId: queued.data.run_id,
      deadline: Date.now() + 45_000,
    });
    log("info", "leads.run_now", { requestId, status: outcome.status, requests: "requests" in outcome ? outcome.requests : 0 });
    refresh();
    if (outcome.status === "not_configured") return { ok: false, messageKey: "UNAVAILABLE", leadsCode: "NOT_CONFIGURED" };
    if (outcome.status === "refused") {
      return { ok: false, messageKey: "UNAVAILABLE", leadsCode: outcome.reason === "daily_cap" ? "CAP_REACHED" : "BUDGET_REACHED" };
    }
    if (outcome.status === "failed") return { ok: false, messageKey: "UNAVAILABLE", requestId };
    return { ok: true, message: "ran", count: "leadsNew" in outcome ? outcome.leadsNew : 0 };
  } catch (err) {
    log("error", "leads.run_now_failed", { requestId, error: err instanceof Error ? err.message.slice(0, 300) : "unknown" });
    return { ok: false, messageKey: "UNAVAILABLE", requestId };
  }
}

/** Owner: a rep's lead radius, through api.set_employee_base_location (the base point is kept). */
export async function setLeadRadius(_prev: LeadsActionState, form: FormData): Promise<LeadsActionResult> {
  const parsed = radiusSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid;
  const bases = await listBaseLocations();
  if (!bases.ok) return toLeadsFailure(bases.error);
  const base = bases.data.find((b) => b.employee_id === parsed.data.employee_id);
  if (!base || base.base_lat === null || base.base_lng === null) return { ok: false, messageKey: "INVALID_STATE", leadsCode: "NO_BASE_LOCATION" };
  const result = await callCommand("set_employee_base_location", {
    p_employee_id: base.employee_id,
    p_address: base.base_address,
    p_lat: Number(base.base_lat),
    p_lng: Number(base.base_lng),
    p_source: base.base_location_source ?? "manual",
    p_lead_radius_km: parsed.data.radius_km,
  });
  if (!result.ok) return toLeadsFailure(result.error);
  refresh();
  return { ok: true, message: "queued" };
}
