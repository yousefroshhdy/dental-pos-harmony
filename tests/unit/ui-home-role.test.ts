import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Grant, Scope, UserContext } from "@/lib/authz/can";
import { displayName, HOME_ROLES, OPEN_STAGES, pipelineByStage, receiptsSummary, selectHome } from "@/modules/home/logic";

function ctx(perms: Record<string, Scope> = {}, extra: Partial<UserContext> = {}): UserContext {
  const permissions: Record<string, Grant> = Object.fromEntries(Object.entries(perms).map(([p, scope]) => [p, { scope, limit: null }]));
  return { user_id: "u1", active: true, is_owner: false, locale: "ar", status: "active", employee: null, permissions, ...extra };
}

// Seeded role grants that decide the home (supabase/migrations/20261028001500_reference_data.sql).
const SALES_REP = { "field.visit.create": "own", "field.visit.read": "own", "perf.kpi.read": "own" } as const;
const AREA_MANAGER = { "field.visit.create": "own", "field.visit.read": "team", "perf.kpi.read": "team", "wf.approval.read": "team" } as const;
const SALES_DIRECTOR = { "field.visit.create": "own", "perf.kpi.read": "all", "wf.approval.read": "all" } as const;
const FINANCE_OFFICER = { "finance.page.aging": "all", "finance.payment.read": "all", "wf.approval.read": "all" } as const;
const COLLECTION_OFFICER = { "finance.page.aging": "all", "field.visit.create": "own" } as const;

const INVENTORY_MANAGER = { "inventory.module.access": "all", "sales.order.fulfil": "all", "wf.approval.read": "all" } as const;

describe("selectHome: owner > finance > manager > rep > inventory", () => {
  it.each([
    ["owner", ctx({}, { is_owner: true }), "owner"],
    ["owner even with field rights", ctx(SALES_REP, { is_owner: true }), "owner"],
    ["finance officer", ctx(FINANCE_OFFICER), "finance"],
    ["collection officer (also visits)", ctx(COLLECTION_OFFICER), "finance"],
    ["finance beats manager", ctx({ ...FINANCE_OFFICER, ...AREA_MANAGER }), "finance"],
    ["area manager (also visits)", ctx(AREA_MANAGER), "manager"],
    ["sales director", ctx(SALES_DIRECTOR), "manager"],
    ["sales rep", ctx(SALES_REP), "rep"],
    ["rep without KPIs", ctx({ "field.visit.create": "own" }), "rep"],
    ["own-scope KPI reader is not a manager", ctx({ "perf.kpi.read": "own" }), "general"],
    ["inventory manager", ctx(INVENTORY_MANAGER), "inventory"],
    ["fulfilment only", ctx({ "sales.order.fulfil": "all" }), "inventory"],
    ["rep beats inventory", ctx({ ...SALES_REP, ...INVENTORY_MANAGER }), "rep"],
    ["admin", ctx({ "admin.user.read": "all", "admin.role.read": "all" }), "general"],
    ["no roles", ctx(), "general"],
    ["inactive owner", ctx({}, { is_owner: true, active: false }), "general"],
  ] as const)("%s → %s", (_name, user, expected) => {
    expect(selectHome(user)).toBe(expected);
  });
});

describe("home figures", () => {
  it("receipts today leave out reversed and bounced payments and count pending ones", () => {
    expect(
      receiptsSummary([
        { amount: "1500.10", status: "confirmed" },
        { amount: 250.2, status: "pending_verification" },
        { amount: "900", status: "reversed" },
        { amount: "400", status: "bounced" },
        { amount: null, status: "confirmed" },
      ]),
    ).toEqual({ count: 3, total: 1750.3, pending: 1 });
    expect(receiptsSummary([])).toEqual({ count: 0, total: 0, pending: 0 });
  });

  it("pipeline counts open stages in order and ignores closed ones", () => {
    const out = pipelineByStage([
      { stage: "proposal", expected_value: "1000.50" },
      { stage: "new", expected_value: null },
      { stage: "proposal", expected_value: 2000 },
      { stage: "won", expected_value: 99999 },
      { stage: "lost", expected_value: 1 },
    ]);
    expect(out.map((s) => s.stage)).toEqual([...OPEN_STAGES]);
    expect(out).toEqual([
      { stage: "new", count: 1, value: 0 },
      { stage: "qualified", count: 0, value: 0 },
      { stage: "proposal", count: 2, value: 3000.5 },
      { stage: "negotiation", count: 0, value: 0 },
    ]);
  });

  it("greets with the Arabic name on Arabic pages, else the English one", () => {
    const employee = { id: "e", employee_no: "E1", full_name_en: "Test Rep", full_name_ar: "مندوب تجريبي", job_title: "Rep" };
    expect(displayName(ctx({}, { employee }), "ar")).toBe("مندوب تجريبي");
    expect(displayName(ctx({}, { employee }), "en")).toBe("Test Rep");
    expect(displayName(ctx({}, { employee: { ...employee, full_name_ar: null } }), "ar")).toBe("Test Rep");
    expect(displayName(ctx(), "ar")).toBe("");
  });
});

describe.each(["ar", "en"])("home messages (%s)", (locale) => {
  const messages = JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "home.json"), "utf8"));
  it("a subtitle for every home and a label for every open stage", () => {
    for (const role of HOME_ROLES) expect(messages.subtitle[role], role).toEqual(expect.any(String));
    for (const stage of OPEN_STAGES) expect(messages.pipeline.stages[stage], stage).toEqual(expect.any(String));
  });
});
