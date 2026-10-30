"use server";

import { revalidatePath } from "next/cache";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { buildCondition, cairoLocalToIso, clauseRowsFromForm, errorKeyFor, hoursToMinutes } from "./logic";
import {
  delegationSchema,
  formToObject,
  formValues,
  invalidFieldsOf,
  removeStageSchema,
  revokeDelegationSchema,
  ruleSchema,
  setStageSchema,
  stageFieldsSchema,
  type StageFields,
} from "./schemas";
import type { ActionResult, ActionState } from "./types";

/**
 * Workflow mutations. Each action validates FormData and calls exactly one
 * api.* command as the signed-in user (callCommand). Authorization is NOT
 * decided here: hidden ids are untrusted, and the database re-checks the
 * permission, anti-escalation rules, condition grammar and delegation scope.
 */

const failed = (error: AppError): ActionResult => ({ ok: false, messageKey: errorKeyFor(error), requestId: error.requestId });

function invalid(fields: string[]): ActionResult {
  return { ok: false, messageKey: fields.includes("reason") ? "REASON_REQUIRED" : "VALIDATION" };
}

function refreshRules() {
  revalidatePath("/[locale]/workflow/rules", "page");
  revalidatePath("/[locale]/workflow/rules/[definitionId]", "page");
}

function refreshDelegations() {
  revalidatePath("/[locale]/workflow/delegations", "page");
  revalidatePath("/[locale]/approvals", "page");
}

function stageArgs(stage: StageFields) {
  return {
    approver_type: stage.approver_type,
    approver_permission: stage.approver_type === "permission" ? (stage.approver_permission ?? null) : null,
    approver_role_id: stage.approver_type === "role" ? (stage.approver_role_id ?? null) : null,
    approver_user_id: stage.approver_type === "user" ? (stage.approver_user_id ?? null) : null,
    required_approvals: stage.required_approvals,
    escalate_after_minutes: hoursToMinutes(stage.escalate_after_hours),
    escalate_to_user_id: stage.escalate_to_user_id ?? null,
  };
}

/** Create a rule (with its first stage) or edit an existing rule's priority, condition and auto-approve. */
export async function saveRule(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const raw = formToObject(form);
  const parsed = ruleSchema.safeParse(raw);
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error));
  const built = buildCondition(clauseRowsFromForm(raw));
  if (!built.ok) return { ok: false, messageKey: "INVALID_CONDITION" };

  const { definition_code, rule_id, priority, auto_approve, reason } = parsed.data;
  let stages: ReturnType<typeof stageArgs>[] | null = null;
  if (!rule_id && !auto_approve) {
    const stage = stageFieldsSchema.safeParse(raw);
    if (!stage.success) return invalid(invalidFieldsOf(stage.error));
    stages = [stageArgs(stage.data)];
  }

  const result = await callCommand("upsert_workflow_rule", {
    p_definition_code: definition_code,
    p_priority: priority,
    p_condition: built.condition,
    p_auto_approve: auto_approve === "on",
    p_rule_id: rule_id ?? null,
    p_stages: stages,
    p_reason: reason,
  });
  if (!result.ok) return failed(result.error);
  refreshRules();
  return { ok: true };
}

export async function setStage(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const raw = formToObject(form);
  const parsed = setStageSchema.safeParse(raw);
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error));
  const stage = stageFieldsSchema.safeParse(raw);
  if (!stage.success) return invalid(invalidFieldsOf(stage.error));
  const args = stageArgs(stage.data);
  const result = await callCommand("set_workflow_stage", {
    p_rule_id: parsed.data.rule_id,
    p_stage_no: parsed.data.stage_no,
    p_approver_type: args.approver_type,
    p_approver_permission: args.approver_permission,
    p_approver_role_id: args.approver_role_id,
    p_approver_user_id: args.approver_user_id,
    p_required_approvals: args.required_approvals,
    p_escalate_after_minutes: args.escalate_after_minutes,
    p_escalate_to_user_id: args.escalate_to_user_id,
    p_remove: false,
    p_reason: parsed.data.reason,
  });
  if (!result.ok) return failed(result.error);
  refreshRules();
  return { ok: true };
}

export async function removeStage(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = removeStageSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error));
  const result = await callCommand("set_workflow_stage", {
    p_rule_id: parsed.data.rule_id,
    p_stage_no: parsed.data.stage_no,
    p_remove: true,
    p_reason: parsed.data.reason,
  });
  if (!result.ok) return failed(result.error);
  refreshRules();
  return { ok: true };
}

/** Out-of-office delegation. Times are typed in Cairo time; the server clamps a past start to now. */
export async function createDelegation(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const raw = formToObject(form);
  const parsed = delegationSchema.safeParse({ ...raw, workflow_codes: formValues(form, "workflow_codes") });
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error));
  const { to_employee_id, from_employee_id, valid_from, valid_to, workflow_codes, reason, client_ref } = parsed.data;
  const from = valid_from ? cairoLocalToIso(valid_from) : null;
  const to = cairoLocalToIso(valid_to);
  if ((valid_from && !from) || !to) return { ok: false, messageKey: "VALIDATION" };

  const result = await callCommand("create_delegation", {
    p_to_employee_id: to_employee_id,
    p_valid_from: from ?? new Date().toISOString(),
    p_valid_to: to,
    p_workflow_codes: workflow_codes.length > 0 ? workflow_codes : null,
    p_from_employee_id: from_employee_id ?? null,
    p_reason: reason ?? null,
    p_client_ref: client_ref,
  });
  if (!result.ok) return failed(result.error);
  refreshDelegations();
  return { ok: true };
}

export async function revokeDelegation(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = revokeDelegationSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error));
  const result = await callCommand("revoke_delegation", {
    p_delegation_id: parsed.data.delegation_id,
    p_reason: parsed.data.reason ?? null,
  });
  if (!result.ok) return failed(result.error);
  refreshDelegations();
  return { ok: true };
}
