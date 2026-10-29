import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type Scope, type UserContext } from "@/lib/authz/can";
import {
  ACTION_STATUSES,
  ACTION_TARGETS,
  addLine,
  approvalReasons,
  availableActions,
  canTransition,
  describeHistoryReason,
  hasPendingCancel,
  isTerminal,
  linesToBuilder,
  MAX_LINES,
  MAX_QUANTITY,
  ORDER_ERROR_CODES,
  ORDER_TRANSITIONS,
  orderErrorCode,
  parseStatusFilter,
  sanitizeSearch,
  STATUS_FILTERS,
  statusTone,
  toNumber,
  warehouseOptions,
} from "@/modules/orders/logic";
import { ORDER_STATUSES, type OrderRow, type OrderStatus } from "@/modules/orders/types";

// ---------------------------------------------------------------------------
// The database's state machine, read from the migrations
// ---------------------------------------------------------------------------
const MIGRATIONS = join(__dirname, "../../supabase/migrations");
const allSql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");

function dbTransitions(): { from: string; to: string; permission: string }[] {
  const block = /insert into sales\.order_transitions[^;]*?values([\s\S]*?)on conflict/i.exec(allSql)?.[1];
  if (!block) throw new Error("order_transitions seed not found");
  return [...block.matchAll(/\('([a-z_]+)','([a-z_]+)','([a-z_.]+)'\)/g)].map((m) => ({ from: m[1]!, to: m[2]!, permission: m[3]! }));
}

function dbStatuses(): string[] {
  const check = /create table sales\.orders[\s\S]*?status\s+text[^\n]*\n\s*check \(status in \(([\s\S]*?)\)\)/i.exec(allSql)?.[1];
  if (!check) throw new Error("sales.orders status check not found");
  return [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** Body of the LAST definition of an api function across all migrations (later migrations redefine). */
function functionBody(name: string): string {
  const starts = [...allSql.matchAll(new RegExp(`create or replace function api\\.${name}\\(`, "g"))];
  const start = starts.at(-1)?.index;
  if (start === undefined) throw new Error(`api.${name} not found`);
  const end = allSql.indexOf("end $$;", start);
  return allSql.slice(start, end);
}

/** Order statuses a command body tests the locked order against. */
function statusesChecked(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/v_order\.status\s*(?:<>|=)\s*'([a-z_]+)'/g)) out.add(m[1]!);
  for (const m of body.matchAll(/v_order\.status\s+(?:not\s+)?in\s*\(([^)]*)\)/g)) for (const s of m[1]!.matchAll(/'([a-z_]+)'/g)) out.add(s[1]!);
  return [...out].sort();
}

describe("order status machine", () => {
  it("ORDER_TRANSITIONS equals sales.order_transitions (reference data migration)", () => {
    const key = (t: { from: string; to: string; permission: string }) => `${t.from}>${t.to}:${t.permission}`;
    expect(ORDER_TRANSITIONS.map(key).sort()).toEqual(dbTransitions().map(key).sort());
  });

  it("ORDER_STATUSES equals the sales.orders status CHECK, in order", () => {
    expect([...ORDER_STATUSES]).toEqual(dbStatuses());
  });

  it("every action's statuses match the status checks in its api command", () => {
    expect(statusesChecked(functionBody("submit_order"))).toEqual(["draft"]);
    expect(statusesChecked(functionBody("approve_order"))).toEqual(["submitted"]);
    expect(statusesChecked(functionBody("reject_order"))).toEqual(["submitted"]);
    expect(statusesChecked(functionBody("reserve_order"))).toEqual(["approved"]);
    expect(statusesChecked(functionBody("post_fulfillment"))).toEqual([...ACTION_STATUSES.fulfil].sort());
    expect(statusesChecked(functionBody("cancel_order"))).toEqual([...ACTION_STATUSES.cancel].sort());
    expect(statusesChecked(functionBody("save_order_draft"))).toEqual([...ACTION_STATUSES.edit]);
    expect([...ACTION_STATUSES.submit]).toEqual(["draft"]);
    expect([...ACTION_STATUSES.approve]).toEqual(["submitted"]);
    expect([...ACTION_STATUSES.reserve]).toEqual(["approved"]);
  });

  it("every action leads somewhere the state machine allows", () => {
    for (const [action, froms] of Object.entries(ACTION_STATUSES)) {
      if (action === "edit") continue;
      const targets = ACTION_TARGETS[action as keyof typeof ACTION_TARGETS];
      for (const from of froms) {
        expect(targets.some((to) => canTransition(from, to)), `${action} from ${from}`).toBe(true);
      }
    }
  });

  it("terminal statuses have no way out", () => {
    expect(ORDER_STATUSES.filter(isTerminal).sort()).toEqual(["cancelled", "rejected", "returned"]);
    expect(canTransition("fulfilled", "cancelled")).toBe(false);
    expect(canTransition("draft", "approved")).toBe(false);
  });

  it("status filters partition every status exactly once", () => {
    const listed = Object.entries(STATUS_FILTERS)
      .filter(([k]) => k !== "all")
      .flatMap(([, v]) => [...v]);
    expect([...listed].sort()).toEqual([...ORDER_STATUSES].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("parseStatusFilter accepts known filters only", () => {
    expect(parseStatusFilter("draft")).toBe("draft");
    expect(parseStatusFilter(["awaiting", "x"])).toBe("awaiting");
    expect(parseStatusFilter("constructor")).toBe("all");
    expect(parseStatusFilter(undefined)).toBe("all");
  });

  it("gives every status a tone", () => {
    for (const s of ORDER_STATUSES) expect(statusTone(s)).toMatch(/neutral|success|warning|danger|info/);
    expect(statusTone("cancelled")).toBe("danger");
  });
});

// ---------------------------------------------------------------------------
// Available actions by role (mirrors the fixture roles in reference data)
// ---------------------------------------------------------------------------
const ME_EMP = "20000000-0000-0000-0000-000000000004";
const OTHER_EMP = "20000000-0000-0000-0000-000000000005";

function ctx(perms: Record<string, Scope>, extra: Partial<UserContext> = {}): UserContext {
  return {
    ...ANONYMOUS_CONTEXT,
    user_id: "00000000-0000-0000-0000-0000000000a4",
    active: true,
    status: "active",
    employee: { id: ME_EMP, employee_no: "E004", full_name_en: "Rep", full_name_ar: null, job_title: "Rep" },
    permissions: Object.fromEntries(Object.entries(perms).map(([k, scope]) => [k, { scope, limit: null }])),
    ...extra,
  };
}

const rep = ctx({ "sales.order.read": "own", "sales.order.create": "own", "sales.order.submit": "own" });
const manager = ctx(
  { "sales.order.read": "team", "sales.order.create": "team", "sales.order.submit": "team", "sales.order.approve": "team" },
  { employee: { id: "20000000-0000-0000-0000-000000000003", employee_no: "E003", full_name_en: "AM", full_name_ar: null, job_title: "AM" } },
);
const director = ctx(
  { "sales.order.read": "all", "sales.order.approve": "all", "sales.order.cancel": "all", "sales.order.create": "all" },
  { employee: { id: "20000000-0000-0000-0000-000000000002", employee_no: "E002", full_name_en: "SD", full_name_ar: null, job_title: "SD" } },
);
const warehouse = ctx(
  { "sales.order.read": "all", "sales.order.fulfil": "all" },
  { employee: { id: "20000000-0000-0000-0000-000000000008", employee_no: "E008", full_name_en: "Inv", full_name_ar: null, job_title: "Inv" } },
);

const order = (status: OrderStatus, over: Partial<OrderRow> = {}) => ({
  status,
  employee_id: ME_EMP,
  pending_approval_request_id: null as string | null,
  ...over,
});
const reservedLine = [{ reserved_qty: 3 }];

describe("availableActions", () => {
  it("a rep edits, submits and cancels their own draft", () => {
    const a = availableActions(rep, order("draft"));
    expect(a).toMatchObject({ edit: true, submit: true, cancel: "direct", approve: false, reserve: false, fulfil: false });
  });

  it("a rep cannot cancel a submitted order (needs sales.order.cancel)", () => {
    expect(availableActions(rep, order("submitted")).cancel).toBeNull();
    expect(availableActions(director, order("submitted", { employee_id: OTHER_EMP })).cancel).toBe("direct");
  });

  it("a rep asks for approval to cancel their approved or reserved order", () => {
    expect(availableActions(rep, order("approved")).cancel).toBe("request");
    expect(availableActions(rep, order("reserved")).cancel).toBe("request");
    expect(availableActions(rep, order("fulfilled")).cancel).toBeNull();
    expect(availableActions(rep, order("approved", { employee_id: OTHER_EMP })).cancel).toBeNull();
  });

  it("managers accept or reject submitted orders, never their own", () => {
    const team = order("submitted", { employee_id: ME_EMP });
    expect(availableActions(manager, team)).toMatchObject({ approve: true, reject: true });
    expect(availableActions(manager, order("submitted", { employee_id: manager.employee!.id }))).toMatchObject({ approve: false, reject: false });
    expect(availableActions(manager, order("pending_approval"))).toMatchObject({ approve: false, reject: false });
    expect(availableActions(rep, order("submitted", { employee_id: OTHER_EMP }))).toMatchObject({ approve: false, reject: false });
  });

  it("warehouse reserves approved orders and fulfils reserved ones with active reservations", () => {
    expect(availableActions(warehouse, order("approved")).reserve).toBe(true);
    expect(availableActions(warehouse, order("reserved"), reservedLine).fulfil).toBe(true);
    expect(availableActions(warehouse, order("reserved"), [{ reserved_qty: 0 }]).fulfil).toBe(false);
    expect(availableActions(warehouse, order("partially_fulfilled"), reservedLine).fulfil).toBe(true);
    expect(availableActions(rep, order("approved")).reserve).toBe(false);
    expect(availableActions(warehouse, order("submitted")).reserve).toBe(false);
  });

  it("a pending cancellation pauses reserve, fulfil and a second cancel", () => {
    const pending = { pending_approval_request_id: "90000000-0000-0000-0000-000000000001" };
    expect(hasPendingCancel(order("approved", pending))).toBe(true);
    expect(hasPendingCancel(order("pending_approval", pending))).toBe(false);
    const a = availableActions(warehouse, order("approved", pending));
    expect(a).toMatchObject({ reserve: false, cancelPending: true });
    expect(availableActions(warehouse, order("reserved", pending), reservedLine).fulfil).toBe(false);
    expect(availableActions(rep, order("reserved", pending)).cancel).toBeNull();
  });

  it("owners see every action the status allows; inactive users none", () => {
    const owner = ctx({}, { is_owner: true, employee: null });
    expect(availableActions(owner, order("submitted"))).toMatchObject({ approve: true, reject: true, cancel: "direct" });
    const inactive = { ...rep, active: false };
    expect(availableActions(inactive, order("draft"))).toMatchObject({ edit: false, submit: false, cancel: null });
  });

  it("no action is offered in a terminal status", () => {
    for (const s of ["cancelled", "rejected", "returned"] as const) {
      const a = availableActions(ctx({}, { is_owner: true }), order(s), reservedLine);
      expect(Object.entries(a).filter(([k, v]) => k !== "cancelPending" && v)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Submit outcome and history
// ---------------------------------------------------------------------------
describe("approval reasons", () => {
  it("reads reasons from the latest draft → pending_approval history row", () => {
    expect(
      approvalReasons([
        { id: 1, to_status: "draft", reason: "draft created" },
        { id: 2, to_status: "pending_approval", reason: "discount above limit; credit limit" },
      ]),
    ).toEqual(["discount", "credit"]);
    expect(approvalReasons([{ id: 2, to_status: "pending_approval", reason: "credit limit" }])).toEqual(["credit"]);
    expect(approvalReasons([{ id: 2, to_status: "pending_approval", reason: null }])).toEqual([]);
    expect(approvalReasons([])).toEqual([]);
  });

  it("translates the fixed phrases the commands write, keeps people's words", () => {
    expect(describeHistoryReason({ to_status: "draft", reason: "draft created" })).toEqual({ kind: "draftCreated" });
    expect(describeHistoryReason({ to_status: "approved", reason: "accepted" })).toEqual({ kind: "accepted" });
    expect(describeHistoryReason({ to_status: "approved", reason: "approval request 9c1e8a52-1111-4222-8333-444455556666" })).toEqual({
      kind: "approvalDecision",
    });
    expect(describeHistoryReason({ to_status: "pending_approval", reason: "credit limit" })).toEqual({
      kind: "approvalReasons",
      reasons: ["credit"],
    });
    expect(describeHistoryReason({ to_status: "cancelled", reason: "customer changed mind" })).toEqual({
      kind: "text",
      text: "customer changed mind",
    });
    expect(describeHistoryReason({ to_status: "fulfilled", reason: null })).toEqual({ kind: "none" });
  });
});

// ---------------------------------------------------------------------------
// Warehouse picker
// ---------------------------------------------------------------------------
describe("warehouseOptions", () => {
  const lines = [
    { variant_id: "v1", quantity: 10, fulfilled_qty: 0, reserved_qty: 0 },
    { variant_id: "v2", quantity: 5, fulfilled_qty: 0, reserved_qty: 0 },
  ];
  const stock = (warehouse_id: string, code: string, variant_id: string, available: number) => ({
    warehouse_id,
    warehouse_code: code,
    warehouse_name: `${code} name`,
    variant_id,
    available,
  });

  it("ranks warehouses that cover every open line first", () => {
    const options = warehouseOptions(
      [stock("w2", "WH-B", "v1", 4), stock("w2", "WH-B", "v2", 9), stock("w1", "WH-A", "v1", 10), stock("w1", "WH-A", "v2", 5)],
      lines,
    );
    expect(options.map((o) => [o.code, o.coversAll, o.shortLines])).toEqual([
      ["WH-A", true, 0],
      ["WH-B", false, 1],
    ]);
  });

  it("ignores stock of variants not on the order and already-covered lines", () => {
    const options = warehouseOptions(
      [stock("w1", "WH-A", "other", 100), stock("w1", "WH-A", "v2", 5)],
      [lines[0]!, { ...lines[1]!, reserved_qty: 0 }].map((l) => (l.variant_id === "v1" ? { ...l, reserved_qty: 10 } : l)),
    );
    expect(options).toEqual([{ id: "w1", code: "WH-A", name: "WH-A name", coversAll: true, shortLines: 0 }]);
    expect(warehouseOptions([], lines)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Errors, search and builder helpers
// ---------------------------------------------------------------------------
describe("orderErrorCode", () => {
  const err = (code: string, messageKey = "UNKNOWN", detail = "") => ({ code, messageKey: messageKey as never, detail });

  it("keeps business codes the commands raise", () => {
    for (const code of ["CUSTOMER_BLOCKED", "WAREHOUSE_NOT_SELLABLE", "INSUFFICIENT_STOCK", "NO_PRICE", "SELF_APPROVAL", "CANCEL_PENDING"]) {
      expect(orderErrorCode(err(code))).toBe(code);
    }
  });

  it("recognises an unsellable variant behind NOT_FOUND", () => {
    expect(orderErrorCode(err("NOT_FOUND", "NOT_FOUND", "P0002 | NOT_FOUND: variant 53… is not sellable"))).toBe("VARIANT_NOT_SELLABLE");
    expect(orderErrorCode(err("NOT_FOUND", "NOT_FOUND", "P0002 | NOT_FOUND: customer"))).toBe("NOT_FOUND");
  });

  it("maps NOT_SELLABLE (discontinued after the draft was saved) to the unsellable-variant message", () => {
    expect(orderErrorCode(err("NOT_SELLABLE", "UNKNOWN", "P0001 | NOT_SELLABLE: BIO-TOP-4110 is no longer sold"))).toBe("VARIANT_NOT_SELLABLE");
  });

  it("falls back to the generic message key, then UNKNOWN", () => {
    expect(orderErrorCode(err("LIMIT_EXCEEDED", "PERMISSION_DENIED"))).toBe("PERMISSION_DENIED");
    expect(orderErrorCode(err("SOMETHING_NEW"))).toBe("UNKNOWN");
    expect(ORDER_ERROR_CODES).toContain("UNKNOWN");
  });
});

describe("sanitizeSearch", () => {
  it("keeps letters (incl. Arabic), digits and . - /", () => {
    expect(sanitizeSearch("  BIO-TOP 4.1/10 ")).toBe("BIO-TOP 4.1/10");
    expect(sanitizeSearch("زرعة")).toBe("زرعة");
  });

  it("drops characters that would break or widen a PostgREST filter", () => {
    expect(sanitizeSearch("a,b)(c%d*e:f\"g'")).toBe("a b c d e f g");
    expect(sanitizeSearch("x".repeat(100))).toHaveLength(60);
  });
});

describe("builder lines", () => {
  const line = (variant_id: string, quantity = 1) => ({ variant_id, quantity, sku: variant_id, name: variant_id });

  it("adds a new variant or increases the existing line", () => {
    const one = addLine([], line("v1"));
    expect(addLine(one, line("v1", 2))).toEqual([line("v1", 3)]);
    expect(addLine(one, line("v2")).map((l) => l.variant_id)).toEqual(["v1", "v2"]);
  });

  it("caps quantities and line count", () => {
    expect(addLine([line("v1", MAX_QUANTITY)], line("v1", 5))[0]!.quantity).toBe(MAX_QUANTITY);
    const full = Array.from({ length: MAX_LINES }, (_, i) => line(`v${i}`));
    expect(addLine(full, line("new"))).toHaveLength(MAX_LINES);
  });

  it("merges repeated variants of a saved draft", () => {
    expect(
      linesToBuilder([
        { variant_id: "v1", quantity: 2, sku: "S1", variant_name: "One" },
        { variant_id: "v1", quantity: 3, sku: "S1", variant_name: "One" },
        { variant_id: "v2", quantity: 1, sku: "S2", variant_name: null },
      ]),
    ).toEqual([
      { variant_id: "v1", quantity: 5, sku: "S1", name: "One" },
      { variant_id: "v2", quantity: 1, sku: "S2", name: "S2" },
    ]);
  });

  it("toNumber reads PostgREST numerics", () => {
    expect(toNumber("16758.00")).toBe(16758);
    expect(toNumber(12.5)).toBe(12.5);
    expect(toNumber(null)).toBe(0);
    expect(toNumber("x")).toBe(0);
  });
});
