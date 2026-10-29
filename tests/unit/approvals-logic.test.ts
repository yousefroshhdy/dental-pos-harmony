import { describe, expect, it } from "vitest";
import {
  badgeCount,
  errorKeyFor,
  groupByWorkflow,
  headlineFact,
  isOverdue,
  localizedName,
  notificationKind,
  requestFacts,
  requestTitle,
  safeInternalHref,
  statusTone,
  subjectLink,
  toNumber,
  unreadIds,
  verdictKey,
  visitStatusKey,
  waitingFor,
  workflowLabelKey,
} from "@/modules/approvals/logic";
import type { ApprovalRequestRow } from "@/modules/approvals/types";

/** A synthetic api.v_approval_requests row (no real data). */
function requestRow(overrides: Partial<ApprovalRequestRow> = {}): ApprovalRequestRow {
  return {
    request_id: "a0000000-0000-0000-0000-000000000001",
    workflow_code: "sales.order.discount",
    workflow_name: "Order discount above limit",
    entity_type: "sales.order",
    entity_id: "b0000000-0000-0000-0000-000000000001",
    payload: {},
    status: "pending",
    current_stage: 1,
    stage_count: 1,
    stage_approver_type: "permission",
    stage_permission: "wf.decide.order_discount",
    stage_required_approvals: 1,
    stage_approvals: 0,
    stage_started_at: "2026-10-29T08:00:00Z",
    created_at: "2026-10-29T08:00:00Z",
    decided_at: null,
    requested_by: "c0000000-0000-0000-0000-000000000001",
    requester_name_en: "Test Rep",
    requester_name_ar: "مندوب تجريبي",
    subject_employee_id: null,
    subject_name_en: null,
    subject_name_ar: null,
    is_mine: false,
    can_decide: true,
    my_verdict: "ok",
    decided_by_me: false,
    my_decision: null,
    my_decided_at: null,
    customer_no: null,
    customer_name: null,
    from_employee_name_en: null,
    from_employee_name_ar: null,
    to_employee_name_en: null,
    to_employee_name_ar: null,
    warehouse_code: null,
    warehouse_name: null,
    variant_sku: null,
    variant_name: null,
    ...overrides,
  };
}

const ID = "d0000000-0000-0000-0000-000000000009";

describe("workflows", () => {
  it("knows the seeded workflow codes and nothing else", () => {
    expect(workflowLabelKey("sales.order.discount")).toBe("orderDiscount");
    expect(workflowLabelKey("field.visit.exception")).toBe("visitException");
    expect(workflowLabelKey("made.up")).toBeNull();
    expect(workflowLabelKey(null)).toBeNull();
  });

  it("groups by workflow in a fixed order, unknown codes last, row order kept", () => {
    const rows = [
      { workflow_code: "zzz.custom", n: 1 },
      { workflow_code: "inventory.adjustment", n: 2 },
      { workflow_code: "sales.order.discount", n: 3 },
      { workflow_code: "inventory.adjustment", n: 4 },
      { workflow_code: "aaa.custom", n: 5 },
    ];
    const groups = groupByWorkflow(rows);
    expect(groups.map((g) => g.code)).toEqual(["sales.order.discount", "inventory.adjustment", "aaa.custom", "zzz.custom"]);
    expect(groups[1]?.rows.map((r) => r.n)).toEqual([2, 4]);
  });
});

describe("status, verdict and errors", () => {
  it("tones by status", () => {
    expect(statusTone("pending")).toBe("warning");
    expect(statusTone("approved")).toBe("success");
    expect(statusTone("rejected")).toBe("danger");
    expect(statusTone("cancelled")).toBe("neutral");
  });

  it("explains every blocked verdict and nothing when the user can decide", () => {
    expect(verdictKey("ok")).toBeNull();
    expect(verdictKey(null)).toBeNull();
    for (const v of ["own_request", "about_you", "limit", "already_decided", "not_approver", "closed"] as const) {
      expect(verdictKey(v)).toBe(v);
    }
  });

  it("maps decide_approval business codes, then generic keys, else UNKNOWN", () => {
    expect(errorKeyFor({ code: "SELF_APPROVAL", messageKey: "UNKNOWN" })).toBe("SELF_APPROVAL");
    expect(errorKeyFor({ code: "LIMIT_EXCEEDED", messageKey: "UNKNOWN" })).toBe("LIMIT_EXCEEDED");
    expect(errorKeyFor({ code: "ALREADY_DECIDED", messageKey: "UNKNOWN" })).toBe("ALREADY_DECIDED");
    expect(errorKeyFor({ code: "INVALID_STATE", messageKey: "INVALID_STATE" })).toBe("INVALID_STATE");
    expect(errorKeyFor({ code: "SOMETHING_NEW", messageKey: "UNAVAILABLE" })).toBe("UNAVAILABLE");
    expect(errorKeyFor({ code: "SOMETHING_NEW", messageKey: "DUPLICATE" })).toBe("UNKNOWN");
  });
});

describe("waiting time", () => {
  const now = new Date("2026-10-29T12:00:00Z");
  it("uses the largest whole unit", () => {
    expect(waitingFor("2026-10-29T11:59:30Z", now)).toEqual({ unit: "minute", count: 0 });
    expect(waitingFor("2026-10-29T11:15:00Z", now)).toEqual({ unit: "minute", count: 45 });
    expect(waitingFor("2026-10-29T09:00:00Z", now)).toEqual({ unit: "hour", count: 3 });
    expect(waitingFor("2026-10-26T11:00:00Z", now)).toEqual({ unit: "day", count: 3 });
  });
  it("never goes negative on clock skew", () => {
    expect(waitingFor("2026-10-29T12:05:00Z", now)).toEqual({ unit: "minute", count: 0 });
  });
  it("flags requests older than 48 hours", () => {
    expect(isOverdue("2026-10-27T12:00:00Z", now)).toBe(true);
    expect(isOverdue("2026-10-27T12:00:01Z", now)).toBe(false);
  });
});

describe("subject links", () => {
  it("routes by entity type", () => {
    expect(subjectLink(requestRow({ entity_type: "sales.order", entity_id: ID }))).toEqual({ href: `/orders/${ID}`, labelKey: "openOrder" });
    expect(subjectLink(requestRow({ entity_type: "crm.customer", entity_id: ID }))?.href).toBe(`/customers/${ID}`);
    expect(subjectLink(requestRow({ entity_type: "field.visit", entity_id: ID }))?.href).toBe(`/visits/${ID}`);
  });
  it("links an adjustment to the stock it changes", () => {
    const row = requestRow({ entity_type: "inventory.adjustment", payload: { warehouse_id: ID, variant_id: ID } });
    expect(subjectLink(row)).toEqual({ href: `/inventory/stock?warehouse=${ID}&variant=${ID}`, labelKey: "openStock" });
    expect(subjectLink(requestRow({ entity_type: "inventory.adjustment", payload: {} }))?.href).toBe("/inventory/stock");
  });
  it("never puts a malformed id into a URL", () => {
    expect(subjectLink(requestRow({ entity_type: "sales.order", entity_id: "../admin" }))).toBeNull();
    const row = requestRow({ entity_type: "inventory.adjustment", payload: { warehouse_id: "x?y=1" } });
    expect(subjectLink(row)?.href).toBe("/inventory/stock");
  });
  it("falls back to an order or customer in the payload, else no link", () => {
    expect(subjectLink(requestRow({ entity_type: "sales.return", payload: { order_id: ID } }))?.href).toBe(`/orders/${ID}`);
    expect(subjectLink(requestRow({ entity_type: "finance.credit_note", payload: { customer_id: ID } }))?.href).toBe(`/customers/${ID}`);
    expect(subjectLink(requestRow({ entity_type: "perf.commission_period", payload: null }))).toBeNull();
  });
});

describe("request facts", () => {
  it("order discount with credit: amounts, limits and both triggers", () => {
    const row = requestRow({
      customer_name: "Test Clinic",
      customer_no: "C-9999",
      payload: {
        order_no: "SO-2026-000001",
        total: 12500.5,
        discount_exceeded: true,
        credit_exceeded: true,
        max_manual_discount_pct: 12,
        limit_pct: 3,
        credit_limit: "10000.00",
        balance: 2000,
        exposure: 14500.5,
        credit_excess: 4500.5,
      },
    });
    const facts = requestFacts(row, "en");
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f]));
    expect(byKey.customer?.value).toBe("Test Clinic (C-9999)");
    expect(byKey.orderTotal).toEqual({ key: "orderTotal", kind: "money", value: 12500.5 });
    expect(byKey.requestedDiscount).toEqual({ key: "requestedDiscount", kind: "percent", value: 12 });
    expect(byKey.creditLimit?.value).toBe(10000);
    expect(facts.filter((f) => f.kind === "flag").map((f) => f.key)).toEqual(["discountExceeded", "creditExceeded"]);
    expect(headlineFact(facts)?.key).toBe("orderTotal");
    expect(requestTitle(row)).toBe("SO-2026-000001 — Test Clinic");
  });

  it("order discount without credit hides credit figures", () => {
    const facts = requestFacts(requestRow({ payload: { total: 100, credit_exceeded: false, credit_limit: 50 } }), "en");
    expect(facts.map((f) => f.key)).toEqual(["orderTotal"]);
  });

  it("inventory adjustment: signed quantity, limits, warehouse and SKU", () => {
    const row = requestRow({
      workflow_code: "inventory.adjustment",
      entity_type: "inventory.adjustment",
      warehouse_code: "WH-T",
      warehouse_name: "Test store",
      variant_sku: "SKU-T",
      payload: { quantity: -7, requester_limit: 5, already_adjusted_today: 0, reason: "  damaged  " },
    });
    const facts = requestFacts(row, "en");
    expect(facts).toContainEqual({ key: "quantity", kind: "signedUnits", value: -7 });
    expect(facts).toContainEqual({ key: "adjustedToday", kind: "units", value: 0 });
    expect(facts).toContainEqual({ key: "reason", kind: "text", value: "damaged" });
    expect(facts).toContainEqual({ key: "warehouse", kind: "text", value: "WH-T — Test store" });
    expect(requestTitle(row)).toBe("SKU-T @ WH-T");
    expect(headlineFact(facts)?.key).toBe("quantity");
  });

  it("customer reassignment uses names in the viewer's locale", () => {
    const row = requestRow({
      workflow_code: "crm.customer.reassign",
      entity_type: "crm.customer",
      customer_name: "Test Clinic",
      from_employee_name_en: "Rep One",
      from_employee_name_ar: "المندوب الأول",
      to_employee_name_en: "Rep Two",
      to_employee_name_ar: null,
      payload: { reason: "rebalancing" },
    });
    const ar = Object.fromEntries(requestFacts(row, "ar").map((f) => [f.key, f.value]));
    expect(ar.fromEmployee).toBe("المندوب الأول");
    expect(ar.toEmployee).toBe("Rep Two");
  });

  it("visit exception: status, distance, accuracy", () => {
    const row = requestRow({
      workflow_code: "field.visit.exception",
      entity_type: "field.visit",
      payload: { original_status: "out_of_range", distance_m: 2210.4, accuracy_m: 20, reason: "clinic moved" },
    });
    const facts = requestFacts(row, "en");
    expect(facts.map((f) => f.key)).toEqual(["visitStatus", "distance", "accuracy", "reason"]);
    expect(visitStatusKey("out_of_range")).toBe("out_of_range");
    expect(visitStatusKey("verified")).toBeNull();
  });

  it("unknown workflow: generic amount and reason; empty payload gives no facts", () => {
    const facts = requestFacts(requestRow({ workflow_code: "x.y", payload: { amount: "250", reason: "why" } }), "en");
    expect(facts.map((f) => f.key)).toEqual(["amount", "reason"]);
    expect(requestFacts(requestRow({ workflow_code: "x.y", payload: null }), "en")).toEqual([]);
    expect(requestTitle(requestRow({ workflow_code: "x.y" }))).toBeNull();
  });

  it("parses numbers defensively", () => {
    expect(toNumber("12.50")).toBe(12.5);
    expect(toNumber(3)).toBe(3);
    expect(toNumber("abc")).toBeNull();
    expect(toNumber("")).toBeNull();
    expect(toNumber(true)).toBeNull();
    expect(toNumber(null)).toBeNull();
  });

  it("localizes names with an English fallback", () => {
    expect(localizedName("ar", "Name", "اسم")).toBe("اسم");
    expect(localizedName("ar", "Name", null)).toBe("Name");
    expect(localizedName("en", null, "اسم")).toBe("اسم");
    expect(localizedName("en", null, null)).toBe("");
  });
});

describe("notifications", () => {
  it("accepts only same-origin paths and strips the locale prefix", () => {
    expect(safeInternalHref("/approvals/abc")).toBe("/approvals/abc");
    expect(safeInternalHref("/ar/orders/1")).toBe("/orders/1");
    expect(safeInternalHref("/en")).toBe("/");
    expect(safeInternalHref("/english-page")).toBe("/english-page");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "javascript:alert(1)", "/a b", "/a\u0007", "", null, undefined]) {
      expect(safeInternalHref(bad)).toBeNull();
    }
    expect(safeInternalHref(`/${"a".repeat(600)}`)).toBeNull();
  });

  it("recognises known types and decisions; unknown types use the stored title", () => {
    expect(notificationKind({ type: "approval.requested", data: {} })).toBe("approvalRequested");
    expect(notificationKind({ type: "approval.decided", data: { decision: "approved" } })).toBe("approvalApproved");
    expect(notificationKind({ type: "approval.decided", data: { decision: "rejected" } })).toBe("approvalRejected");
    expect(notificationKind({ type: "approval.decided", data: {} })).toBeNull();
    expect(notificationKind({ type: "visit.exception_decided", data: { approved: false } })).toBe("visitExceptionRejected");
    expect(notificationKind({ type: "order.cancelled", data: null })).toBe("orderCancelled");
    expect(notificationKind({ type: "something.else", data: {} })).toBeNull();
  });

  it("collects unread ids and formats the badge", () => {
    expect(unreadIds([{ id: "1", read_at: null }, { id: "2", read_at: "2026-10-29T10:00:00Z" }, { id: "3", read_at: null }])).toEqual(["1", "3"]);
    expect(badgeCount(0)).toBeNull();
    expect(badgeCount(-1)).toBeNull();
    expect(badgeCount(7)).toBe("7");
    expect(badgeCount(150)).toBe("99+");
  });
});
