"use server";

import { revalidatePath } from "next/cache";
import { publicEnv } from "@/env";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { callCommand } from "@/lib/command";
import type { AppError, TranslatedCode } from "@/lib/errors";
import { log } from "@/lib/log";
import { geocodeAddress } from "@/lib/maps/geocode";
import { getRequestId } from "@/lib/request-id";
import { createServiceClient } from "@/lib/supabase/admin";
import { canInvite, failedResult } from "./logic";
import { listRoles } from "./queries";
import { createEmployeeSchema, formToObject } from "./schemas";
import { LEGACY_BRANDS, LEGACY_CATEGORIES, signInLinkUrl, type LinkMode } from "./setup";
import { baseLocationSchema, createWarehouseSchema, issueLoginSchema } from "./setup-schemas";
import type { ActionResult, ActionState } from "./types";

/**
 * Owner setup screen mutations (/admin/setup). Each validates FormData and calls the existing
 * api.* commands as the signed-in user; the database re-checks every permission and scope.
 * Only translatable keys, ids and (for the owner) a one-time link go back to the browser.
 */

function refreshSetup() {
  revalidatePath("/[locale]/admin/setup", "page");
  revalidatePath("/[locale]/admin/security", "page");
}

function failed(error: AppError): ActionResult {
  // DUPLICATE_CODE (api.create_warehouse) has no generic translation; it is a duplicate.
  if (error.code === "DUPLICATE_CODE") return { ok: false, messageKey: "DUPLICATE", requestId: error.requestId };
  return failedResult(error);
}

// ---------------------------------------------------------------------------
// Main and quarantine warehouses
// ---------------------------------------------------------------------------
async function createWarehouse(form: FormData, kind: "main" | "quarantine"): Promise<ActionResult> {
  const parsed = createWarehouseSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, messageKey: "VALIDATION" };
  const { warehouse_id, code, name } = parsed.data;
  const result = await callCommand("create_warehouse", { p_warehouse_id: warehouse_id, p_code: code, p_name: name, p_kind: kind });
  if (!result.ok) return failed(result.error);
  refreshSetup();
  return { ok: true };
}

export async function createMainWarehouse(_prev: ActionState, form: FormData): Promise<ActionResult> {
  return createWarehouse(form, "main");
}

/** Where returned goods are received (never sellable); same command, kind `quarantine`. */
export async function createQuarantineWarehouse(_prev: ActionState, form: FormData): Promise<ActionResult> {
  return createWarehouse(form, "quarantine");
}

// ---------------------------------------------------------------------------
// Brands and category the old system's items need (api.create_brand / api.create_category are
// idempotent by code, so pressing the button twice is harmless).
// ---------------------------------------------------------------------------
export async function addLegacyCatalog(): Promise<ActionResult> {
  for (const b of LEGACY_BRANDS) {
    const r = await callCommand("create_brand", { p_code: b.code, p_name: b.name });
    if (!r.ok) return failed(r.error);
  }
  for (const c of LEGACY_CATEGORIES) {
    const r = await callCommand("create_category", { p_code: c.code, p_name_en: c.nameEn, p_name_ar: c.nameAr, p_parent_code: c.parent });
    if (!r.ok) return failed(r.error);
  }
  refreshSetup();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// People (employee record; the login is a separate step below)
// ---------------------------------------------------------------------------
export async function addSetupPerson(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = createEmployeeSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, messageKey: "VALIDATION" };
  const input = parsed.data;
  const created = await callCommand<string>("create_employee", {
    p_employee_no: input.employee_no,
    p_full_name_en: input.full_name_en,
    p_job_title: input.job_title,
    p_full_name_ar: input.full_name_ar ?? null,
    p_phone: input.phone ?? null,
    p_email: input.email ?? null,
  });
  if (!created.ok) return failed(created.error);
  refreshSetup();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Base address → point (decision E). Geocoded on the server with GOOGLE_MAPS_SERVER_KEY, or typed.
// ---------------------------------------------------------------------------
export type GeocodeProblem = "not_configured" | "not_found" | "outside_egypt" | "error";

export type BaseLocationState =
  | null
  | { ok: true; source: "geocoded" | "manual" | null; formattedAddress?: string; approximate?: boolean }
  | { ok: false; geocode: GeocodeProblem }
  | { ok: false; messageKey: TranslatedCode; requestId?: string };

export async function saveBaseLocation(_prev: BaseLocationState, form: FormData): Promise<BaseLocationState> {
  const parsed = baseLocationSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, messageKey: "VALIDATION" };
  const v = parsed.data;
  // Cost guard: only someone who may set it can make us call the Geocoding API (UX check; the DB re-checks).
  const ctx = await getUserContext();
  if (!can(ctx, "core.employee.manage")) return { ok: false, messageKey: "PERMISSION_DENIED" };

  let lat: number | null = v.lat ?? null;
  let lng: number | null = v.lng ?? null;
  let source: "geocoded" | "manual" | null = lat === null ? null : "manual";
  let formattedAddress: string | undefined;
  let approximate: boolean | undefined;
  if (v.intent === "clear") {
    lat = null;
    lng = null;
    source = null;
  } else if (lat === null && v.address) {
    const geo = await geocodeAddress(v.address, { language: form.get("ui_locale") === "en" ? "en" : "ar" });
    if (geo.status !== "ok") return { ok: false, geocode: geo.status };
    lat = geo.lat;
    lng = geo.lng;
    source = "geocoded";
    formattedAddress = geo.formattedAddress;
    approximate = geo.approximate;
  }

  const result = await callCommand("set_employee_base_location", {
    p_employee_id: v.employee_id,
    p_address: v.intent === "clear" ? null : (v.address ?? null),
    p_lat: lat,
    p_lng: lng,
    p_source: source,
    p_lead_radius_km: v.lead_radius_km ?? null,
  });
  if (!result.ok) return { ok: false, messageKey: result.error.messageKey, requestId: result.error.requestId };
  refreshSetup();
  return { ok: true, source, formattedAddress, approximate };
}

// ---------------------------------------------------------------------------
// Login + role. SMTP is not configured, so e-mail invites do not arrive: the owner gets a
// one-time link to send privately instead. Order (each step re-checked in Postgres):
//   (a) UI check: owner with admin.user.create, before the service-role client is touched;
//   (b) api.authorize_sign_in_link as the owner (owner only, security event, the employee's e-mail);
//   (c) Auth admin generateLink (service role, server only): creates the login for an invite;
//   (d) api.register_user (new login) → (e) api.assign_employee_territory → (f) api.grant_role.
// A failure after (c) still returns the link, with the step that failed, so nothing is lost.
// ---------------------------------------------------------------------------
export type StepStatus = "done" | "skipped" | "failed";

export type LoginState =
  | null
  | {
      ok: true;
      link: string;
      mode: LinkMode;
      email: string;
      steps: { register: StepStatus; territory: StepStatus; role: StepStatus };
      failure?: { messageKey: TranslatedCode; requestId?: string };
    }
  | { ok: false; stage: "input" | "permission" | "authorize" | "link"; messageKey: TranslatedCode; requestId?: string };

export async function issueLogin(_prev: LoginState, form: FormData): Promise<LoginState> {
  const parsed = issueLoginSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, stage: "input", messageKey: "VALIDATION" };
  const input = parsed.data;

  // (a)
  const ctx = await getUserContext();
  if (!ctx.is_owner || !canInvite(ctx)) return { ok: false, stage: "permission", messageKey: "OWNER_ONLY" };

  // (b)
  const authorized = await callCommand<{ employee_id: string; user_id: string | null; email: string; mode: LinkMode }>(
    "authorize_sign_in_link",
    { p_employee_id: input.employee_id },
  );
  if (!authorized.ok) {
    return { ok: false, stage: "authorize", messageKey: authorized.error.messageKey, requestId: authorized.error.requestId };
  }
  const { email } = authorized.data;
  let mode = authorized.data.mode;

  // (c)
  const requestId = await getRequestId();
  let userId: string;
  let hashedToken: string;
  try {
    const admin = createServiceClient().auth.admin;
    const redirectTo = `${publicEnv().NEXT_PUBLIC_APP_URL}/${input.locale}/auth/confirm`;
    let res = await admin.generateLink({ type: mode, email, options: { redirectTo } });
    if (res.error && mode === "invite" && (res.error.code === "email_exists" || res.error.status === 422)) {
      // The Auth user exists already (an earlier attempt stopped before step d): sign it in instead.
      mode = "magiclink";
      res = await admin.generateLink({ type: "magiclink", email, options: { redirectTo } });
    }
    const user = res.data?.user;
    const token = res.data?.properties?.hashed_token;
    if (res.error || !user || !token) {
      log("warn", "setup.link_failed", { requestId, reason: res.error?.code ?? res.error?.name ?? "no_link", status: res.error?.status });
      return { ok: false, stage: "link", messageKey: "UNAVAILABLE", requestId };
    }
    if (authorized.data.user_id && user.id !== authorized.data.user_id) {
      // The e-mail now belongs to another login than the one linked to this employee.
      log("warn", "setup.link_user_mismatch", { requestId });
      return { ok: false, stage: "link", messageKey: "CONFLICT", requestId };
    }
    userId = user.id;
    hashedToken = token;
  } catch (cause) {
    // e.g. SUPABASE_SERVICE_ROLE_KEY missing (serverEnv() throws) or a network failure.
    log("error", "setup.link_failed", { requestId, detail: cause instanceof Error ? cause.message : String(cause) });
    return { ok: false, stage: "link", messageKey: "UNAVAILABLE", requestId };
  }
  const link = signInLinkUrl(publicEnv().NEXT_PUBLIC_APP_URL, input.locale, hashedToken, mode);

  const steps: { register: StepStatus; territory: StepStatus; role: StepStatus } = { register: "skipped", territory: "skipped", role: "skipped" };
  let failure: { messageKey: TranslatedCode; requestId?: string } | undefined;
  const note = (error: AppError) => {
    failure ??= { messageKey: error.messageKey, requestId: error.requestId };
  };

  // (d)
  if (authorized.data.user_id === null) {
    const linked = await callCommand("register_user", { p_user_id: userId, p_employee_id: input.employee_id, p_locale: input.locale });
    steps.register = linked.ok ? "done" : "failed";
    if (!linked.ok) note(linked.error);
  }

  // (e) + (f) only for a registered login.
  if (steps.register !== "failed") {
    let roleCode: string | undefined;
    if (input.role_id) {
      const roles = await listRoles();
      roleCode = roles.ok ? roles.data.find((r) => r.id === input.role_id)?.code : undefined;
    }
    if (input.territory_id) {
      const assigned = await callCommand("assign_employee_territory", {
        p_employee_id: input.employee_id,
        p_territory_id: input.territory_id,
        p_assignment: roleCode === "area_manager" || roleCode === "sales_director" ? "manager" : "member",
      });
      steps.territory = assigned.ok ? "done" : "failed";
      if (!assigned.ok) note(assigned.error);
    }
    if (input.role_id) {
      const granted = await callCommand("grant_role", {
        p_user_id: userId,
        p_role_id: input.role_id,
        p_territory_id: input.territory_id ?? null,
        p_reason: "Owner setup screen",
      });
      steps.role = granted.ok ? "done" : "failed";
      if (!granted.ok) note(granted.error);
    }
  }

  log("info", "setup.login_link_issued", { requestId, mode, ...steps });
  refreshSetup();
  revalidatePath("/[locale]/admin/users", "page");
  return { ok: true, link, mode, email, steps, ...(failure ? { failure } : {}) };
}
