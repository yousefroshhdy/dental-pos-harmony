"use server";

import { revalidatePath } from "next/cache";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { formToObject } from "../schemas";
import { commitStepSchema, sessionActionSchema, stepActionSchema, type StepActionResult, type StepActionState } from "./schemas";

/**
 * Step buttons of /admin/setup/legacy-import. Each calls exactly one EXISTING import command on
 * the step's batch (api.import_validate = dry run, api.import_commit = commit, in one transaction)
 * or api.legacy_import_abandon. The database checks owner/admin.import.run/MFA and refuses a step
 * whose earlier steps are not committed (LEGACY_ORDER), whichever screen calls.
 */
function refresh() {
  revalidatePath("/[locale]/admin/setup/legacy-import", "page");
  revalidatePath("/[locale]/imports", "layout");
}

const failed = (error: AppError): StepActionResult => ({ ok: false, code: error.code, messageKey: error.messageKey, requestId: error.requestId });

export async function dryRunStep(_prev: StepActionState, form: FormData): Promise<StepActionResult> {
  const parsed = stepActionSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, code: "VALIDATION", messageKey: "VALIDATION" };
  const result = await callCommand<{ status: string }>("import_validate", { p_batch_id: parsed.data.batch_id });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, status: result.data.status };
}

export async function commitStep(_prev: StepActionState, form: FormData): Promise<StepActionResult> {
  const parsed = commitStepSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, code: "CONFIRM_REQUIRED", messageKey: "VALIDATION" };
  const result = await callCommand<{ status: string }>("import_commit", { p_batch_id: parsed.data.batch_id });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, status: result.data.status };
}

export async function abandonSession(_prev: StepActionState, form: FormData): Promise<StepActionResult> {
  const parsed = sessionActionSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, code: "CONFIRM_REQUIRED", messageKey: "VALIDATION" };
  const result = await callCommand<{ status: string }>("legacy_import_abandon", { p_session_id: parsed.data.session_id });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, status: result.data.status };
}
