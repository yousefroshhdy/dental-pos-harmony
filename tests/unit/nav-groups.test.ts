import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Grant, Scope, UserContext } from "@/lib/authz/can";
import { activeHref, HOME_ITEM, NAV_GROUP_IDS, NAV_SOURCES, navIcon, USER_MENU_NAV, visibleNavGroups, type NavItem } from "@/lib/nav";
import { adminNav } from "@/modules/admin/nav";
import { approvalsNav } from "@/modules/approvals/nav";
import { auditNav } from "@/modules/audit/nav";
import { catalogNav } from "@/modules/catalog/nav";
import { commissionsNav } from "@/modules/commissions/nav";
import { crmNav } from "@/modules/crm/nav";
import { dashboardsNav } from "@/modules/dashboards/nav";
import { fieldNav } from "@/modules/field/nav";
import { financeNav } from "@/modules/finance/nav";
import { importsNav } from "@/modules/imports/nav";
import { inventoryNav } from "@/modules/inventory/nav";
import { ordersNav } from "@/modules/orders/nav";
import { planningNav } from "@/modules/planning/nav";
import { reportsNav } from "@/modules/reports/nav";
import { returnsNav } from "@/modules/returns/nav";
import { securityNav } from "@/modules/security/nav";
import { trackingNav } from "@/modules/tracking/nav";
import { mapsNav } from "@/modules/maps/nav";
import { workflowNav } from "@/modules/workflow/nav";

function ctx(perms: Record<string, Scope> = {}, extra: Partial<UserContext> = {}): UserContext {
  const permissions: Record<string, Grant> = Object.fromEntries(Object.entries(perms).map(([p, scope]) => [p, { scope, limit: null }]));
  return { user_id: "u1", active: true, is_owner: false, locale: "ar", status: "active", employee: null, permissions, ...extra };
}

const OWNER = ctx({}, { is_owner: true });
/** The seeded sales_rep grants that drive navigation (reference_data migration). */
const REP = ctx({
  "crm.customer.read": "own",
  "crm.opportunity.read": "own",
  "field.visit.create": "own",
  "field.visit.read": "own",
  "field.visit.plan": "own",
  "work.task.read": "own",
  "sales.order.read": "own",
  "sales.order.create": "own",
  "sales.return.request": "own",
  "finance.invoice.read": "own",
  "finance.payment.read": "own",
  "finance.payment.record": "own",
  "perf.kpi.read": "own",
  "perf.commission.read": "own",
  "catalog.product.read": "all",
});

/** Every module nav array: the pre-Phase-P layout's list plus modules added in Phase P (maps). */
const LAYOUT_NAVS: readonly (readonly NavItem[])[] = [
  dashboardsNav, fieldNav, trackingNav, crmNav, ordersNav, financeNav, approvalsNav, inventoryNav, catalogNav,
  planningNav, returnsNav, commissionsNav, reportsNav, importsNav, workflowNav, auditNav, securityNav, adminNav,
  mapsNav,
];

describe("department groups", () => {
  it("cover every module entry the old layout showed, each exactly once (sidebar or user menu)", () => {
    const placed = [...NAV_SOURCES.flatMap((s) => s.items), ...USER_MENU_NAV].map((i) => i.href);
    const expected = [HOME_ITEM, ...LAYOUT_NAVS.flat()].map((i) => i.href);
    expect([...placed].sort()).toEqual([...expected].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("the owner sees all eight groups in department order", () => {
    expect(visibleNavGroups(OWNER).map((g) => g.id)).toEqual([...NAV_GROUP_IDS]);
    expect(NAV_GROUP_IDS).toEqual(["home", "sales", "field", "orders", "finance", "inventory", "reports", "admin"]);
  });

  it("puts each module in its department", () => {
    const groupOf = (href: string) => visibleNavGroups(OWNER).find((g) => g.items.some((i) => i.href === href))?.id;
    expect(groupOf("/")).toBe("home");
    expect(groupOf("/approvals")).toBe("home");
    expect(groupOf("/customers")).toBe("sales");
    expect(groupOf("/catalog")).toBe("sales");
    expect(groupOf("/today")).toBe("field");
    expect(groupOf("/tracking")).toBe("field");
    expect(groupOf("/map")).toBe("field");
    expect(groupOf("/planning")).toBe("field");
    expect(groupOf("/orders")).toBe("orders");
    expect(groupOf("/returns")).toBe("orders");
    expect(groupOf("/finance/aging")).toBe("finance");
    expect(groupOf("/inventory")).toBe("inventory");
    expect(groupOf("/dashboard")).toBe("reports");
    expect(groupOf("/reports")).toBe("reports");
    expect(groupOf("/admin/users")).toBe("admin");
    expect(groupOf("/audit")).toBe("admin");
    expect(groupOf("/account/security")).toBeUndefined(); // user menu
  });

  it("filters by permission and drops groups left empty", () => {
    const groups = visibleNavGroups(REP);
    expect(groups.map((g) => g.id)).toEqual(["home", "sales", "field", "orders", "finance", "reports"]);
    const hrefs = groups.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toContain("/today");
    expect(hrefs).toContain("/finance/payments/new");
    expect(hrefs).not.toContain("/tracking"); // field.tracking.read
    expect(hrefs).not.toContain("/finance/aging");
    expect(hrefs).not.toContain("/approvals"); // wf.approval.read
    expect(hrefs).not.toContain("/reports"); // no export permission
    expect(hrefs).not.toContain("/admin/users");
  });

  it("a user without roles sees only Home", () => {
    expect(visibleNavGroups(ctx()).map((g) => [g.id, g.items.map((i) => i.href)])).toEqual([["home", ["/", "/notifications"]]]);
  });

  it("an inactive user gets no permission-gated entry", () => {
    const hrefs = visibleNavGroups({ ...OWNER, active: false }).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs.every((h) => [HOME_ITEM, ...approvalsNav, ...reportsNav].some((i) => i.href === h && i.permission === null))).toBe(true);
    expect(hrefs).not.toContain("/reports"); // anyPermission still applies
  });

  it("keeps the first of duplicate hrefs", () => {
    const a: NavItem = { href: "/x", labelKey: "a", permission: null };
    const b: NavItem = { href: "/x", labelKey: "b", permission: null };
    const groups = visibleNavGroups(OWNER, [
      { group: "admin", items: [a] },
      { group: "home", items: [b] },
    ]);
    expect(groups).toEqual([{ id: "admin", labelKey: "nav.groups.admin", items: [a] }]);
  });

  it("every sidebar and user-menu entry has its own icon", () => {
    for (const item of [...NAV_SOURCES.flatMap((s) => s.items), ...USER_MENU_NAV]) expect(navIcon(item.href), item.href).not.toBe("default");
    expect(navIcon("/returns?status=approved")).toBe("returns");
    expect(navIcon("/somewhere-new")).toBe("default");
  });
});

describe("activeHref", () => {
  const hrefs = ["/", "/finance/payments", "/finance/payments/new", "/returns", "/returns?status=approved", "/inventory"];
  it.each([
    ["/", "/"],
    ["/finance/payments", "/finance/payments"],
    ["/finance/payments/0000-1", "/finance/payments"],
    ["/finance/payments/new", "/finance/payments/new"],
    ["/returns", "/returns"],
    ["/returns/abc", "/returns"],
    ["/inventory/", "/inventory"],
    ["/inventory-x", null],
    ["/customers", null],
  ])("%s → %s", (path, expected) => {
    expect(activeHref(path, hrefs)).toBe(expected);
  });
});

describe("nav messages", () => {
  const root = join(__dirname, "../../messages");
  const load = (locale: string) => {
    const core = JSON.parse(readFileSync(join(root, `${locale}.json`), "utf8")) as Record<string, unknown>;
    for (const f of readdirSync(join(root, locale))) core[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(root, locale, f), "utf8"));
    return core;
  };
  const at = (tree: unknown, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown> | undefined)?.[k], tree);

  it.each(["ar", "en"])("%s: every group label and entry label resolves", (locale) => {
    const messages = load(locale);
    for (const id of NAV_GROUP_IDS) expect(at(messages, `nav.groups.${id}`), id).toEqual(expect.any(String));
    for (const item of [...NAV_SOURCES.flatMap((s) => s.items), ...USER_MENU_NAV]) expect(at(messages, item.labelKey), item.labelKey).toEqual(expect.any(String));
  });

  it("the shell namespaces have the same keys in Arabic and English, none empty", () => {
    const keys = (node: unknown, prefix = ""): string[] =>
      typeof node !== "object" || node === null ? [prefix] : Object.entries(node).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
    const ar = load("ar");
    const en = load("en");
    for (const ns of ["nav", "shell", "auth", "dataTable", "form", "common", "app"]) {
      expect(keys(ar[ns]).sort(), ns).toEqual(keys(en[ns]).sort());
      for (const k of keys(ar[ns])) expect(at(ar[ns], k), `ar ${ns}.${k}`).not.toBe("");
    }
  });
});
