import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import type {
  DefinitionRow,
  DelegationRow,
  EscalationRow,
  PermissionOption,
  PersonRow,
  RoleOption,
  RuleRow,
  StageRow,
} from "./types";

/**
 * Workflow reads. All go through the user's session against api.v_* views
 * (security_invoker), so RLS decides what comes back.
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "workflow.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "workflow.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

const DEFINITION_COLUMNS = "id, code, name, entity_type, is_active, version, rule_count";
const RULE_COLUMNS = "rule_id, definition_id, workflow_code, priority, condition, auto_approve, is_catch_all, stage_count";
const STAGE_COLUMNS =
  "stage_id, rule_id, stage_no, approver_type, approver_permission, approver_role_id, approver_role_code, approver_role_name_en, approver_role_name_ar, approver_user_id, approver_user_name_en, approver_user_name_ar, required_approvals, escalate_after_minutes, escalate_to_user_id, escalate_to_name_en, escalate_to_name_ar";
const DELEGATION_COLUMNS =
  "id, from_user_id, from_name_en, from_name_ar, to_user_id, to_name_en, to_name_ar, definition_id, workflow_code, workflow_name, valid_from, valid_to, created_at, created_by, reason, revoked_at, revoked_by, revoke_reason, status, is_from_me, is_to_me";
const ESCALATION_COLUMNS =
  "request_id, workflow_code, workflow_name, entity_type, entity_id, status, current_stage, stage_no, created_at, level, first_escalated_at, last_escalated_at, i_am_target, is_open, can_decide";

export async function listDefinitions(): Promise<Result<DefinitionRow[]>> {
  const db = await createClient();
  return run("v_workflow_definitions", db.from("v_workflow_definitions").select(DEFINITION_COLUMNS).order("code"), []);
}

export async function getDefinition(id: string): Promise<Result<DefinitionRow | null>> {
  const db = await createClient();
  return run("v_workflow_definitions", db.from("v_workflow_definitions").select(DEFINITION_COLUMNS).eq("id", id).maybeSingle(), null);
}

export async function listRules(definitionId: string): Promise<Result<RuleRow[]>> {
  const db = await createClient();
  return run(
    "v_workflow_rules",
    db.from("v_workflow_rules").select(RULE_COLUMNS).eq("definition_id", definitionId).order("priority"),
    [],
  );
}

export async function listStages(ruleIds: string[]): Promise<Result<StageRow[]>> {
  if (ruleIds.length === 0) return ok([]);
  const db = await createClient();
  return run(
    "v_workflow_stages",
    db.from("v_workflow_stages").select(STAGE_COLUMNS).in("rule_id", ruleIds).order("stage_no"),
    [],
  );
}

/** Permissions a stage may name (wf.decide.*). */
export async function listDecidePermissions(): Promise<Result<PermissionOption[]>> {
  const db = await createClient();
  return run("v_permissions", db.from("v_permissions").select("code, description").like("code", "wf.decide.%").order("code"), []);
}

export async function listRoles(): Promise<Result<RoleOption[]>> {
  const db = await createClient();
  return run("v_roles", db.from("v_roles").select("id, code, name_en, name_ar, is_active").eq("is_active", true).order("code"), []);
}

/** Colleagues for approver / fallback / delegate pickers (empty unless the caller may use them). */
export async function listPeople(): Promise<Result<PersonRow[]>> {
  const db = await createClient();
  return run(
    "v_workflow_people",
    db
      .from("v_workflow_people")
      .select("user_id, employee_id, employee_no, full_name_en, full_name_ar, job_title, in_delegation_scope")
      .order("employee_no"),
    [],
  );
}

export async function listDelegations(limit = 300): Promise<Result<DelegationRow[]>> {
  const db = await createClient();
  return run(
    "v_delegations",
    db.from("v_delegations").select(DELEGATION_COLUMNS).order("valid_from", { ascending: false }).limit(limit),
    [],
  );
}

export async function listEscalations(limit = 200): Promise<Result<EscalationRow[]>> {
  const db = await createClient();
  return run(
    "v_approval_escalations",
    db.from("v_approval_escalations").select(ESCALATION_COLUMNS).order("last_escalated_at", { ascending: false }).limit(limit),
    [],
  );
}
