import { describe, expect, it } from "vitest";
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
} from "@/modules/workflow/schemas";

const ID = "d0000000-0000-0000-0000-000000000001";

describe("form helpers", () => {
  it("trims, drops empties, and reads repeated checkboxes", () => {
    const form = new FormData();
    form.append("reason", "  why  ");
    form.append("empty", "   ");
    form.append("workflow_codes", "sales.order.discount");
    form.append("workflow_codes", " ");
    form.append("workflow_codes", "finance.credit_note");
    expect(formToObject(form)).toEqual({ reason: "why", workflow_codes: "finance.credit_note" });
    expect(formValues(form, "workflow_codes")).toEqual(["sales.order.discount", "finance.credit_note"]);
  });
});

describe("stageFieldsSchema", () => {
  it("accepts each approver type with its field", () => {
    expect(stageFieldsSchema.safeParse({ approver_type: "permission", approver_permission: "wf.decide.order_discount" }).success).toBe(true);
    expect(stageFieldsSchema.safeParse({ approver_type: "role", approver_role_id: ID, required_approvals: "2" }).success).toBe(true);
    expect(stageFieldsSchema.safeParse({ approver_type: "user", approver_user_id: ID }).success).toBe(true);
    expect(stageFieldsSchema.safeParse({ approver_type: "requester_manager", escalate_after_hours: "4" }).success).toBe(true);
  });

  it("refuses missing or contradictory fields", () => {
    const missing = stageFieldsSchema.safeParse({ approver_type: "permission" });
    expect(missing.success).toBe(false);
    if (!missing.success) expect(invalidFieldsOf(missing.error)).toEqual(["approver_permission"]);
    expect(stageFieldsSchema.safeParse({ approver_type: "permission", approver_permission: "admin.user.read" }).success).toBe(false);
    expect(stageFieldsSchema.safeParse({ approver_type: "user", approver_user_id: ID, required_approvals: "2" }).success).toBe(false);
    expect(stageFieldsSchema.safeParse({ approver_type: "role", approver_role_id: ID, required_approvals: "6" }).success).toBe(false);
    expect(stageFieldsSchema.safeParse({ approver_type: "requester_manager", escalate_to_user_id: ID }).success).toBe(false);
    expect(stageFieldsSchema.safeParse({ approver_type: "requester_manager", escalate_after_hours: "0.1" }).success).toBe(false);
    expect(stageFieldsSchema.safeParse({ approver_type: "anyone" }).success).toBe(false);
  });
});

describe("rule and stage commands", () => {
  it("needs a reason and a valid priority", () => {
    const base = { definition_code: "sales.order.discount", definition_id: ID, priority: "50", reason: "policy" };
    expect(ruleSchema.safeParse(base).success).toBe(true);
    expect(ruleSchema.safeParse({ ...base, auto_approve: "on", rule_id: ID }).success).toBe(true);
    const noReason = ruleSchema.safeParse({ ...base, reason: "x" });
    expect(noReason.success).toBe(false);
    if (!noReason.success) expect(invalidFieldsOf(noReason.error)).toContain("reason");
    expect(ruleSchema.safeParse({ ...base, priority: "0" }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...base, definition_code: "DROP TABLE" }).success).toBe(false);
    expect(setStageSchema.safeParse({ definition_id: ID, rule_id: ID, stage_no: "2", reason: "add" }).success).toBe(true);
    expect(setStageSchema.safeParse({ definition_id: ID, rule_id: ID, stage_no: "21", reason: "add" }).success).toBe(false);
    expect(removeStageSchema.safeParse({ definition_id: ID, rule_id: ID, stage_no: "1" }).success).toBe(false);
  });
});

describe("delegation commands", () => {
  it("validates the delegation form", () => {
    const base = { to_employee_id: ID, valid_to: "2026-11-08T17:00", client_ref: ID };
    expect(delegationSchema.parse(base).workflow_codes).toEqual([]);
    expect(delegationSchema.safeParse({ ...base, valid_from: "2026-11-01T09:00", workflow_codes: ["finance.credit_note"] }).success).toBe(true);
    expect(delegationSchema.safeParse({ ...base, valid_to: "next week" }).success).toBe(false);
    expect(delegationSchema.safeParse({ ...base, client_ref: undefined }).success).toBe(false);
    expect(delegationSchema.safeParse({ ...base, workflow_codes: ["not a code"] }).success).toBe(false);
    expect(revokeDelegationSchema.safeParse({ delegation_id: ID }).success).toBe(true);
    expect(revokeDelegationSchema.safeParse({ delegation_id: "x" }).success).toBe(false);
  });
});
