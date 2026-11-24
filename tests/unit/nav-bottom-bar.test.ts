import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Grant, Scope, UserContext } from "@/lib/authz/can";
import { BOTTOM_BAR, bottomBarItems, navIcon, showBottomBar } from "@/lib/nav";

function ctx(perms: Record<string, Scope> = {}, extra: Partial<UserContext> = {}): UserContext {
  const permissions: Record<string, Grant> = Object.fromEntries(Object.entries(perms).map(([p, scope]) => [p, { scope, limit: null }]));
  return { user_id: "u1", active: true, is_owner: false, locale: "ar", status: "active", employee: null, permissions, ...extra };
}

const hrefs = (c: UserContext) => bottomBarItems(c).map((i) => i.href);

describe("field bottom bar", () => {
  it("is Today · Map · Leads · Visits · Orders, in that order", () => {
    expect(BOTTOM_BAR.map((i) => i.href)).toEqual(["/today", "/map", "/leads", "/visits", "/orders"]);
    expect(BOTTOM_BAR.map((i) => navIcon(i.href))).toEqual(["today", "map", "leads", "visits", "orders"]);
  });

  it("a rep gets all five", () => {
    const rep = ctx({ "field.visit.create": "own", "field.visit.read": "own", "crm.customer.read": "own", "sales.order.read": "own" });
    expect(showBottomBar(rep)).toBe(true);
    expect(hrefs(rep)).toEqual(["/today", "/map", "/leads", "/visits", "/orders"]);
  });

  it("is hidden for users without field (check-in) permission", () => {
    expect(showBottomBar(ctx())).toBe(false);
    expect(hrefs(ctx({ "finance.page.aging": "all", "crm.customer.read": "all", "sales.order.read": "all" }))).toEqual([]);
    expect(hrefs(ctx({ "field.visit.read": "team", "crm.customer.read": "territory" }))).toEqual([]); // reads visits, never checks in
  });

  it("is hidden for the owner (every permission implicitly, but not a field user) and for inactive users", () => {
    expect(showBottomBar(ctx({}, { is_owner: true }))).toBe(false);
    expect(showBottomBar(ctx({ "field.visit.create": "own" }, { active: false }))).toBe(false);
  });

  it("Map needs field.visit.read or crm.customer.read; Leads needs field.visit.create", () => {
    const base = { "field.visit.create": "own" } as const;
    expect(hrefs(ctx(base))).toEqual(["/today", "/leads"]);
    expect(hrefs(ctx({ ...base, "crm.customer.read": "own" }))).toEqual(["/today", "/map", "/leads"]);
    expect(hrefs(ctx({ ...base, "field.visit.read": "own" }))).toEqual(["/today", "/map", "/leads", "/visits"]);
    expect(BOTTOM_BAR.find((i) => i.href === "/leads")?.permission).toBe("field.visit.create");
  });

  it("an area manager who also visits gets it, with the same filtering", () => {
    const manager = ctx({ "field.visit.create": "own", "field.visit.read": "team", "perf.kpi.read": "team", "sales.order.read": "team" });
    expect(hrefs(manager)).toEqual(["/today", "/map", "/leads", "/visits", "/orders"]);
  });

  it.each(["ar", "en"])("%s labels exist", (locale) => {
    const messages = JSON.parse(readFileSync(join(__dirname, "../../messages", `${locale}.json`), "utf8"));
    for (const item of BOTTOM_BAR) {
      const value = item.labelKey.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown> | undefined)?.[k], messages);
      expect(value, item.labelKey).toEqual(expect.any(String));
    }
  });
});
