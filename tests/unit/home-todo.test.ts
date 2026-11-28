import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Grant, Scope, UserContext } from "@/lib/authz/can";
import { HOME_ROLES } from "@/modules/home/logic";
import { buildTodos, remainingSteps, ROLE_TODOS, setupStepHref, TODO_KEYS, visibleTodos, type TodoSpec } from "@/modules/home/todo";

function ctx(perms: Record<string, Scope> = {}, extra: Partial<UserContext> = {}): UserContext {
  const permissions: Record<string, Grant> = Object.fromEntries(Object.entries(perms).map(([p, scope]) => [p, { scope, limit: null }]));
  return { user_id: "u1", active: true, is_owner: false, locale: "ar", status: "active", employee: null, permissions, ...extra };
}

// Seeded grants that matter here (supabase/migrations reference data; see the role list in docs/AUTHORIZATION.md).
const REP = { "field.visit.create": "own", "crm.lead.read": "own", "sales.order.create": "own", "work.task.read": "own", "finance.invoice.read": "own" } as const;
const FINANCE = {
  "finance.payment.confirm": "all",
  "finance.invoice.issue": "all",
  "finance.invoice.read": "all",
  "sales.return.credit": "all",
  "wf.approval.read": "all",
  "wf.decide.write_off": "all",
} as const;
const INVENTORY = { "sales.order.fulfil": "all", "sales.return.receive": "all", "inventory.receipt.post": "all", "inventory.module.access": "all", "wf.approval.read": "all" } as const;
const AREA_MANAGER = { "wf.approval.read": "team", "wf.decide.order_discount": "team", "field.tracking.read": "team", "sales.order.create": "team" } as const;

const keys = (specs: readonly TodoSpec[]) => specs.map((s) => s.key);

describe("visibleTodos: the role's order, only what the user may open", () => {
  it("rep: today's plan → clinics near me → orders to finish → tasks", () => {
    expect(keys(visibleTodos("rep", ctx(REP)))).toEqual(["planToday", "leadsNew", "draftOrders", "tasksToday"]);
  });

  it("a rep without leads or tasks does not see those entries", () => {
    expect(keys(visibleTodos("rep", ctx({ "field.visit.create": "own", "sales.order.create": "own" })))).toEqual(["planToday", "draftOrders"]);
  });

  it("finance: payments to verify → orders to invoice → overdue → returns to credit → approvals", () => {
    expect(keys(visibleTodos("finance", ctx(FINANCE)))).toEqual(["paymentsToVerify", "ordersToInvoice", "overdueInvoices", "returnsToCredit", "approvals"]);
  });

  it("a collection officer (no verify, no issue) sees only what they can act on", () => {
    expect(keys(visibleTodos("finance", ctx({ "finance.invoice.read": "all", "finance.page.aging": "all" })))).toEqual(["overdueInvoices"]);
  });

  it("a collection officer who visits clinics starts with today's visits (owner decision 2026-11-28)", () => {
    const collector = ctx({ "finance.invoice.read": "all", "finance.page.aging": "all", "field.visit.create": "own", "field.shift.start": "own" });
    expect(keys(visibleTodos("finance", collector))).toEqual(["planToday", "overdueInvoices"]);
  });

  it("inventory: reserve → deliver → receive returns → post receipts → low stock (approvals only for deciders)", () => {
    expect(keys(visibleTodos("inventory", ctx(INVENTORY)))).toEqual(["ordersToReserve", "ordersToFulfil", "returnsToReceive", "draftReceipts", "lowStock"]);
    expect(keys(visibleTodos("inventory", ctx({ ...INVENTORY, "wf.decide.inventory_adjustment": "all" })))).toContain("approvals");
  });

  it("manager: approvals, then reps whose location stopped (no rep to-dos for managers)", () => {
    expect(keys(visibleTodos("manager", ctx(AREA_MANAGER)))).toEqual(["approvals", "repsNeedingAttention"]);
  });

  it("owner: every entry of the owner home (the owner holds every permission)", () => {
    expect(keys(visibleTodos("owner", ctx({}, { is_owner: true })))).toEqual([...ROLE_TODOS.owner]);
  });

  it("nothing without permissions", () => {
    for (const role of HOME_ROLES) expect(visibleTodos(role, ctx())).toEqual([]);
  });

  it("every role list uses known keys once", () => {
    for (const role of HOME_ROLES) {
      const list = ROLE_TODOS[role];
      expect(new Set(list).size).toBe(list.length);
      for (const k of list) expect(TODO_KEYS).toContain(k);
    }
  });

  it("every entry links into the app (a path, never an external URL)", () => {
    for (const s of visibleTodos("owner", ctx({}, { is_owner: true })).concat(visibleTodos("inventory", ctx(INVENTORY)), visibleTodos("rep", ctx(REP)))) {
      expect(s.href).toMatch(/^\/[a-z]/);
    }
  });
});

describe("buildTodos: open work first, failures never shown as zero", () => {
  const specs = visibleTodos("finance", ctx(FINANCE));

  it("orders open → failed → nothing waiting, keeping the role's order inside each group", () => {
    const items = buildTodos(specs, { paymentsToVerify: 0, ordersToInvoice: 3, overdueInvoices: null, returnsToCredit: 1, approvals: 0 });
    expect(items.map((i) => [i.key, i.state, i.count])).toEqual([
      ["ordersToInvoice", "todo", 3],
      ["returnsToCredit", "todo", 1],
      ["overdueInvoices", "error", null],
      ["paymentsToVerify", "done", 0],
      ["approvals", "done", 0],
    ]);
  });

  it("an entry without a count is left out; odd numbers are cleaned", () => {
    const items = buildTodos(specs, { paymentsToVerify: 2.7, approvals: Number.NaN, overdueInvoices: -4 });
    expect(items.map((i) => [i.key, i.state, i.count])).toEqual([
      ["paymentsToVerify", "todo", 2],
      ["approvals", "error", null],
      ["overdueInvoices", "done", 0],
    ]);
  });

  it("keeps the spec's link and urgency", () => {
    const [item] = buildTodos(specs, { overdueInvoices: 5 });
    expect(item).toMatchObject({ key: "overdueInvoices", href: "/finance/invoices?status=overdue", urgent: true });
  });
});

describe("owner setup card helpers", () => {
  it("remaining steps keep the checklist order", () => {
    const steps = [
      { key: "a", done: true },
      { key: "b", done: false },
      { key: "c", done: false },
    ];
    expect(remainingSteps(steps).map((s) => s.key)).toEqual(["b", "c"]);
    expect(remainingSteps(steps.map((s) => ({ ...s, done: true })))).toEqual([]);
  });

  it("anchors point into the setup page; import links stay", () => {
    expect(setupStepHref("#setup-people")).toBe("/admin/setup#setup-people");
    expect(setupStepHref("/imports?kind=customers")).toBe("/imports?kind=customers");
  });
});

describe.each(["ar", "en"])("to-do messages (%s)", (locale) => {
  const messages = JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "home.json"), "utf8"));
  it("a label for every to-do key and the setup card texts", () => {
    for (const k of TODO_KEYS) expect(messages.todo.items[k], k).toEqual(expect.any(String));
    for (const k of ["title", "allClear", "nothing", "failed"]) expect(messages.todo[k], k).toEqual(expect.any(String));
    for (const k of ["title", "body", "continue", "more"]) expect(messages.setup[k], k).toEqual(expect.any(String));
    expect(messages.shortcuts).toEqual(expect.any(String));
  });
});
