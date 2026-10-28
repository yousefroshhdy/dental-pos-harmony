"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { z } from "zod";
import { publicEnv } from "@/env";
import { getUserContext } from "@/lib/authz/context";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { log } from "@/lib/log";
import { getRequestId } from "@/lib/request-id";
import { createServiceClient } from "@/lib/supabase/admin";
import { canInvite } from "./logic";
import {
  createRoleSchema,
  formToObject,
  grantRoleSchema,
  invalidFieldsOf,
  inviteResumeSchema,
  inviteUserSchema,
  reactivateUserSchema,
  removeRolePermissionSchema,
  revokeRoleSchema,
  setRolePermissionSchema,
  suspendUserSchema,
  validationMessageKey,
} from "./schemas";
import type { ActionResult, ActionState, InviteState } from "./types";

/**
 * Admin console mutations. Each action validates FormData, calls exactly one
 * api.* command as the signed-in user (callCommand) and refreshes the pages
 * that show the result. Authorization is NOT decided here: hidden inputs are
 * untrusted and the database re-checks every permission, scope and ceiling.
 */

const PAGES = {
  users: "/[locale]/admin/users",
  user: "/[locale]/admin/users/[userId]",
  roles: "/[locale]/admin/roles",
  role: "/[locale]/admin/roles/[roleId]",
  security: "/[locale]/admin/security",
} as const;

function refresh(...pages: (keyof typeof PAGES)[]) {
  // Every admin command writes a security event, so the security page is always stale too.
  for (const page of new Set([...pages, "security" as const])) revalidatePath(PAGES[page], "page");
}

const failed = (error: AppError): ActionResult => ({ ok: false, messageKey: error.messageKey, requestId: error.requestId });

function invalid(error: z.ZodError): ActionResult {
  return { ok: false, messageKey: validationMessageKey(error) };
}

async function command(name: string, args: Record<string, unknown>, ...pages: (keyof typeof PAGES)[]): Promise<ActionResult> {
  const result = await callCommand(name, args);
  if (!result.ok) return failed(result.error);
  refresh(...pages);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function suspendUser(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = suspendUserSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return command("suspend_user", { p_user_id: parsed.data.user_id, p_reason: parsed.data.reason }, "users", "user");
}

export async function reactivateUser(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = reactivateUserSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return command("reactivate_user", { p_user_id: parsed.data.user_id, p_reason: parsed.data.reason }, "users", "user");
}

export async function grantRole(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = grantRoleSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const { user_id, role_id, territory_id, reason } = parsed.data;
  return command(
    "grant_role",
    { p_user_id: user_id, p_role_id: role_id, p_territory_id: territory_id ?? null, p_reason: reason },
    "users",
    "user",
  );
}

export async function revokeRole(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = revokeRoleSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return command("revoke_role", { p_user_role_id: parsed.data.user_role_id, p_reason: parsed.data.reason }, "users", "user");
}

/**
 * Invite flow (admin console v1). Order matters:
 *  (a) UI-level permission check BEFORE the service-role client is touched, so a
 *      user without the permissions can never trigger an Auth admin call;
 *  (b) api.create_employee as the admin (DB checks core.employee.manage);
 *  (c) Auth admin invite with the service-role client (server only);
 *  (d) api.register_user as the admin, so the DB re-checks admin.user.create.
 *
 * A failed (d) leaves an invited Auth user with no core.user_profiles row. That
 * is safe: without a profile authz.is_active_user() is false, so the login has
 * no access at all. The returned ids let the admin retry (d) from the same form.
 * Only ids and a stage/status ever go back to the browser — never service-role data.
 */
export async function inviteUser(_prev: InviteState, form: FormData): Promise<InviteState> {
  const raw = formToObject(form);
  const values = pickFormValues(raw);
  const parsed = inviteUserSchema.safeParse(raw);
  if (!parsed.success) {
    // Keep any resume ids so a typo during a retry doesn't lose the partial progress.
    const resumeIds = inviteResumeSchema.safeParse(raw);
    return {
      ok: false,
      stage: "input",
      messageKey: "VALIDATION",
      invalidFields: invalidFieldsOf(parsed.error),
      values,
      ...(resumeIds.success ? { employeeId: resumeIds.data.resume_employee_id, userId: resumeIds.data.resume_user_id } : {}),
    };
  }
  const input = parsed.data;
  const resume = { employeeId: input.resume_employee_id, userId: input.resume_user_id };

  // (a)
  const ctx = await getUserContext();
  if (!canInvite(ctx)) return { ok: false, stage: "permission", messageKey: "PERMISSION_DENIED", values };

  // (b)
  let employeeId = resume.employeeId;
  if (!employeeId) {
    const created = await callCommand<string>("create_employee", {
      p_employee_no: input.employee_no,
      p_full_name_en: input.full_name_en,
      p_full_name_ar: input.full_name_ar ?? null,
      p_job_title: input.job_title,
      p_email: input.email,
      p_phone: input.phone ?? null,
    });
    if (!created.ok) return { ok: false, stage: "employee", ...errorFields(created.error), values };
    employeeId = created.data;
  }

  // (c)
  let userId = resume.userId;
  if (!userId) {
    const requestId = await getRequestId();
    try {
      const { data, error } = await createServiceClient().auth.admin.inviteUserByEmail(input.email, {
        redirectTo: `${publicEnv().NEXT_PUBLIC_APP_URL}/${input.locale}/auth/confirm`,
      });
      if (error || !data.user) {
        log("warn", "admin.invite_failed", { requestId, reason: error?.code ?? error?.name ?? "no_user", status: error?.status });
        const messageKey = error?.code === "email_exists" || error?.status === 422 ? "DUPLICATE" : "UNAVAILABLE";
        return { ok: false, stage: "invite", messageKey, requestId, employeeId, values };
      }
      userId = data.user.id;
    } catch (cause) {
      // e.g. SUPABASE_SERVICE_ROLE_KEY missing (serverEnv() throws) or network failure.
      log("error", "admin.invite_failed", { requestId, detail: cause instanceof Error ? cause.message : String(cause) });
      return { ok: false, stage: "invite", messageKey: "UNAVAILABLE", requestId, employeeId, values };
    }
  }

  // (d)
  const linked = await callCommand("register_user", { p_user_id: userId, p_employee_id: employeeId, p_locale: input.locale });
  if (!linked.ok) return { ok: false, stage: "link", ...errorFields(linked.error), employeeId, userId, values };

  log("info", "admin.user_invited", { userId, employeeId });
  refresh("users");
  // Next step for the admin: grant the new user a role.
  redirect(`/${localeOf(form)}/admin/users/${userId}`);
}

function errorFields(error: AppError) {
  return { messageKey: error.messageKey, requestId: error.requestId };
}

const INVITE_FIELDS = ["employee_no", "full_name_en", "full_name_ar", "job_title", "email", "phone", "locale"] as const;

function pickFormValues(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of INVITE_FIELDS) if (raw[key] !== undefined) out[key] = raw[key];
  return out;
}

/** The admin's UI locale (not the invitee's preferred locale). */
function localeOf(form: FormData): "ar" | "en" {
  return form.get("ui_locale") === "en" ? "en" : "ar";
}

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------

export async function createRole(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = createRoleSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const { code, name_en, name_ar, description, locale } = parsed.data;
  const result = await callCommand<string>("create_role", {
    p_code: code,
    p_name_en: name_en,
    p_name_ar: name_ar ?? null,
    p_description: description ?? null,
  });
  if (!result.ok) return failed(result.error);
  refresh("roles");
  redirect(`/${locale}/admin/roles/${result.data}`);
}

export async function setRolePermission(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = setRolePermissionSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const { role_id, permission, scope, limit } = parsed.data;
  return command("set_role_permission", { p_role_id: role_id, p_permission: permission, p_scope: scope, p_limit: limit ?? null }, "roles", "role");
}

export async function removeRolePermission(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = removeRolePermissionSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return command("remove_role_permission", { p_role_id: parsed.data.role_id, p_permission: parsed.data.permission }, "roles", "role");
}
