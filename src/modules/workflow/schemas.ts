import { z } from "zod";
import { MAX_ESCALATE_MINUTES, MIN_ESCALATE_MINUTES, MINUTES_PER_HOUR } from "./logic";
import { APPROVER_TYPES } from "./types";

/**
 * Input validation for the workflow Server Actions. These only reject malformed
 * input early; permissions, anti-escalation, condition grammar, delegation
 * scope and windows are enforced again by the api.* commands in Postgres.
 */

/** FormData → plain object: strings trimmed, empty strings and files dropped. Repeated keys keep the last value. */
export function formToObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") out[key] = trimmed;
  }
  return out;
}

/** Every non-empty value of a repeated field (checkbox groups). */
export function formValues(form: FormData, key: string): string[] {
  return form
    .getAll(key)
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

// Accepts any 8-4-4-4-12 hex id (seeded fixtures are not always RFC-4122 v4).
const id = z.guid();
export const REASON_MIN = 3;
export const REASON_MAX = 500;
const reason = z.string().trim().min(REASON_MIN).max(REASON_MAX);
const optionalReason = z.string().trim().max(REASON_MAX).optional();
const workflowCode = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$/);
const intField = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/);

/** Approver fields shared by a new rule's first stage and api.set_workflow_stage. */
export const stageFieldsSchema = z
  .object({
    approver_type: z.enum(APPROVER_TYPES as [string, ...string[]]),
    approver_permission: z.string().regex(/^wf\.decide\.[a-z_]+$/).optional(),
    approver_role_id: id.optional(),
    approver_user_id: id.optional(),
    required_approvals: intField(1, 5).default(1),
    escalate_after_hours: z.coerce
      .number()
      .min(MIN_ESCALATE_MINUTES / MINUTES_PER_HOUR)
      .max(MAX_ESCALATE_MINUTES / MINUTES_PER_HOUR)
      .optional(),
    escalate_to_user_id: id.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.approver_type === "permission" && !v.approver_permission)
      ctx.addIssue({ code: "custom", path: ["approver_permission"], message: "a permission stage needs a permission" });
    if (v.approver_type === "role" && !v.approver_role_id)
      ctx.addIssue({ code: "custom", path: ["approver_role_id"], message: "a role stage needs a role" });
    if (v.approver_type === "user" && !v.approver_user_id)
      ctx.addIssue({ code: "custom", path: ["approver_user_id"], message: "a user stage needs a user" });
    if ((v.approver_type === "user" || v.approver_type === "requester_manager") && v.required_approvals !== 1)
      ctx.addIssue({ code: "custom", path: ["required_approvals"], message: "one person gives one approval" });
    if (v.escalate_to_user_id && v.escalate_after_hours === undefined)
      ctx.addIssue({ code: "custom", path: ["escalate_after_hours"], message: "a fallback needs an escalate-after time" });
  });
export type StageFields = z.infer<typeof stageFieldsSchema>;

export const ruleSchema = z.object({
  definition_code: workflowCode,
  definition_id: id,
  rule_id: id.optional(),
  priority: intField(1, 9999),
  auto_approve: z.literal("on").optional(),
  reason,
});

export const setStageSchema = z.object({
  definition_id: id,
  rule_id: id,
  stage_no: intField(1, 20),
  reason,
});

export const removeStageSchema = z.object({
  definition_id: id,
  rule_id: id,
  stage_no: intField(1, 20),
  reason,
});

export const delegationSchema = z.object({
  to_employee_id: id,
  from_employee_id: id.optional(),
  valid_from: localDateTime.optional(),
  valid_to: localDateTime,
  workflow_codes: z.array(workflowCode).max(20).default([]),
  reason: optionalReason,
  client_ref: id,
});

export const revokeDelegationSchema = z.object({ delegation_id: id, reason: optionalReason });

/** Field names that failed validation (first path segment). */
export function invalidFieldsOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
}
