import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { notificationKind, requestFacts, subjectLink, VISIT_STATUSES, WORKFLOW_LABEL_KEYS } from "@/modules/approvals/logic";
import { approvalsNav } from "@/modules/approvals/nav";
import { APPROVAL_ERROR_KEYS, type ApprovalRequestRow } from "@/modules/approvals/types";

/** Every key the approvals code builds dynamically must exist in both locales. */

const load = (locale: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "approvals.json"), "utf8")) as Record<string, unknown>;

function has(tree: Record<string, unknown>, path: string): boolean {
  let node: unknown = tree;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" && node.length > 0;
}

const ID = "d0000000-0000-0000-0000-000000000009";
const FULL_PAYLOAD = {
  order_no: "SO-1",
  total: 1,
  amount: 1,
  discount_exceeded: true,
  credit_exceeded: true,
  max_manual_discount_pct: 1,
  limit_pct: 1,
  credit_limit: 1,
  balance: 1,
  exposure: 1,
  credit_excess: 1,
  from_status: "approved",
  reason: "r",
  quantity: 1,
  requester_limit: 1,
  already_adjusted_today: 1,
  original_status: "out_of_range",
  distance_m: 1,
  accuracy_m: 1,
  order_id: ID,
  customer_id: ID,
  warehouse_id: ID,
};

function fullRow(workflow_code: string, entity_type: string): ApprovalRequestRow {
  return {
    request_id: ID,
    workflow_code,
    workflow_name: "n",
    entity_type,
    entity_id: ID,
    payload: FULL_PAYLOAD,
    status: "pending",
    current_stage: 1,
    stage_count: 1,
    stage_approver_type: null,
    stage_permission: null,
    stage_required_approvals: 1,
    stage_approvals: 0,
    stage_started_at: "2026-10-29T08:00:00Z",
    created_at: "2026-10-29T08:00:00Z",
    decided_at: null,
    requested_by: ID,
    requester_name_en: "a",
    requester_name_ar: null,
    subject_employee_id: null,
    subject_name_en: null,
    subject_name_ar: null,
    is_mine: false,
    can_decide: false,
    my_verdict: null,
    decided_by_me: false,
    my_decision: null,
    my_decided_at: null,
    customer_no: "C-1",
    customer_name: "c",
    from_employee_name_en: "f",
    from_employee_name_ar: null,
    to_employee_name_en: "t",
    to_employee_name_ar: null,
    warehouse_code: "W",
    warehouse_name: "w",
    variant_sku: "S",
    variant_name: "s",
  };
}

const ENTITY: Record<string, string> = {
  "sales.order.discount": "sales.order",
  "sales.order.cancel": "sales.order",
  "inventory.adjustment": "inventory.adjustment",
  "crm.customer.reassign": "crm.customer",
  "field.visit.exception": "field.visit",
};

const NOTIFICATION_SAMPLES = [
  { type: "approval.requested", data: {} },
  { type: "approval.decided", data: { decision: "approved" } },
  { type: "approval.decided", data: { decision: "rejected" } },
  { type: "order.approved", data: {} },
  { type: "order.rejected", data: {} },
  { type: "order.cancelled", data: {} },
  { type: "visit.exception_decided", data: { approved: true } },
  { type: "visit.exception_decided", data: { approved: false } },
  { type: "customer.assigned", data: {} },
  { type: "customer.unassigned", data: {} },
  { type: "task.assigned", data: {} },
];

describe.each(["ar", "en"])("approvals messages (%s)", (locale) => {
  const messages = load(locale);

  it("has nav labels", () => {
    for (const item of approvalsNav) expect(has({ approvals: messages }, item.labelKey), item.labelKey).toBe(true);
  });

  it("has every workflow, status, decision, verdict and error", () => {
    for (const key of Object.values(WORKFLOW_LABEL_KEYS)) expect(has(messages, `workflows.${key}`), key).toBe(true);
    for (const s of ["pending", "approved", "rejected", "cancelled", "expired"]) expect(has(messages, `status.${s}`), s).toBe(true);
    for (const s of ["approved", "rejected", "cancelled", "expired"]) expect(has(messages, `detail.closed.${s}`), s).toBe(true);
    for (const d of ["approved", "rejected"]) {
      expect(has(messages, `decision.${d}`)).toBe(true);
      expect(has(messages, `card.myDecision.${d}`)).toBe(true);
      expect(has(messages, `detail.youDecided.${d}`)).toBe(true);
    }
    for (const v of ["own_request", "about_you", "limit", "already_decided", "not_approver", "closed"]) expect(has(messages, `verdict.${v}`), v).toBe(true);
    for (const e of APPROVAL_ERROR_KEYS) expect(has(messages, `errors.${e}`), e).toBe(true);
    for (const u of ["minute", "hour", "day"]) expect(has(messages, `card.waiting.${u}`), u).toBe(true);
    for (const tab of ["decide", "mine", "decided"]) {
      expect(has(messages, `inbox.tabs.${tab}`)).toBe(true);
      expect(has(messages, `inbox.empty.${tab}`)).toBe(true);
    }
  });

  it("has every fact label, visit status and subject link label the logic can produce", () => {
    for (const code of [...Object.keys(ENTITY), "x.unknown"]) {
      const row = fullRow(code, ENTITY[code] ?? "x.unknown");
      for (const fact of requestFacts(row, locale)) expect(has(messages, `facts.${fact.key}`), `${code}: ${fact.key}`).toBe(true);
      const link = subjectLink(row);
      if (link) expect(has(messages, `subject.${link.labelKey}`), link.labelKey).toBe(true);
    }
    for (const s of VISIT_STATUSES) expect(has(messages, `visitStatus.${s}`), s).toBe(true);
  });

  it("has every notification template", () => {
    for (const sample of NOTIFICATION_SAMPLES) {
      const kind = notificationKind(sample);
      expect(kind, sample.type).not.toBeNull();
      expect(has(messages, `notifications.types.${kind}`), String(kind)).toBe(true);
    }
  });
});
