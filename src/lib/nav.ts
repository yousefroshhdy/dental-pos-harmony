import { can, canAny, type UserContext } from "@/lib/authz/can";
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
import { workflowNav } from "@/modules/workflow/nav";

/**
 * A main-navigation entry. Each module exports its own list from
 * `src/modules/<module>/nav.ts`; the shell shows an entry only if the user
 * holds its permission (UX only: Postgres enforces access).
 */
export interface NavItem {
  href: string;
  /** Full message key, e.g. "crm.nav.customers". */
  labelKey: string;
  permission: string | null;
  /** Optional: the entry also needs at least one of these (e.g. any export permission). */
  anyPermission?: readonly string[];
}

/** Whether the shell shows `item` to this user (UX only). */
export function navVisible(ctx: UserContext, item: NavItem): boolean {
  if (item.permission !== null && !can(ctx, item.permission)) return false;
  return item.anyPermission === undefined || canAny(ctx, item.anyPermission);
}

// ---------------------------------------------------------------------------
// Department groups (owner prompt, Phase P step 2)
// ---------------------------------------------------------------------------

/** Sidebar order. Labels: `nav.groups.<id>` in messages/{ar,en}.json. */
export const NAV_GROUP_IDS = ["home", "sales", "field", "orders", "finance", "inventory", "reports", "admin"] as const;
export type NavGroupId = (typeof NAV_GROUP_IDS)[number];

export const HOME_ITEM: NavItem = { href: "/", labelKey: "nav.home", permission: null };

/**
 * Which group each module's nav array belongs to. A new module adds one line here
 * (its own entries stay in its nav.ts). Order inside a group follows this list.
 */
export const NAV_SOURCES: readonly { group: NavGroupId; items: readonly NavItem[] }[] = [
  { group: "home", items: [HOME_ITEM] },
  { group: "home", items: approvalsNav },
  { group: "sales", items: crmNav },
  { group: "sales", items: catalogNav },
  { group: "sales", items: commissionsNav },
  { group: "field", items: fieldNav },
  { group: "field", items: planningNav },
  { group: "field", items: trackingNav },
  { group: "orders", items: ordersNav },
  { group: "orders", items: returnsNav },
  { group: "finance", items: financeNav },
  { group: "inventory", items: inventoryNav },
  { group: "reports", items: dashboardsNav },
  { group: "reports", items: reportsNav },
  { group: "admin", items: adminNav },
  { group: "admin", items: workflowNav },
  { group: "admin", items: importsNav },
  { group: "admin", items: auditNav },
];

/** Personal entries shown in the user menu instead of the sidebar. */
export const USER_MENU_NAV: readonly NavItem[] = securityNav;

export interface NavGroup {
  id: NavGroupId;
  labelKey: `nav.groups.${NavGroupId}`;
  items: NavItem[];
}

/** The groups this user sees, in sidebar order: hidden entries dropped, empty groups left out, duplicate hrefs once. */
export function visibleNavGroups(ctx: UserContext, sources: readonly { group: NavGroupId; items: readonly NavItem[] }[] = NAV_SOURCES): NavGroup[] {
  const seen = new Set<string>();
  const byGroup = new Map<NavGroupId, NavItem[]>();
  for (const { group, items } of sources) {
    for (const item of items) {
      if (seen.has(item.href) || !navVisible(ctx, item)) continue;
      seen.add(item.href);
      byGroup.set(group, [...(byGroup.get(group) ?? []), item]);
    }
  }
  return NAV_GROUP_IDS.flatMap((id) => {
    const items = byGroup.get(id);
    return items && items.length > 0 ? [{ id, labelKey: `nav.groups.${id}` as const, items }] : [];
  });
}

// ---------------------------------------------------------------------------
// Mobile bottom bar for field users
// ---------------------------------------------------------------------------

/**
 * Today · Map · Leads · Visits · Orders. Map and Leads are the Phase P maps and
 * leads screens (other modules); they 404 until those merge.
 */
export const BOTTOM_BAR: readonly NavItem[] = [
  { href: "/today", labelKey: "nav.bottom.today", permission: "field.visit.create" },
  { href: "/map", labelKey: "nav.bottom.map", permission: null, anyPermission: ["field.visit.read", "crm.customer.read"] },
  { href: "/leads", labelKey: "nav.bottom.leads", permission: "field.visit.create" },
  { href: "/visits", labelKey: "nav.bottom.visits", permission: "field.visit.read" },
  { href: "/orders", labelKey: "nav.bottom.orders", permission: "sales.order.read" },
];

/**
 * The bottom bar is for people who work in the field: those who may check in at a
 * clinic (field.visit.create; reps, area managers, collectors). The owner holds every
 * permission implicitly but is not a field user, so the owner does not get it.
 */
export function showBottomBar(ctx: UserContext): boolean {
  return ctx.active && !ctx.is_owner && can(ctx, "field.visit.create");
}

export function bottomBarItems(ctx: UserContext): NavItem[] {
  return showBottomBar(ctx) ? BOTTOM_BAR.filter((item) => navVisible(ctx, item)) : [];
}

// ---------------------------------------------------------------------------
// Active entry and icons
// ---------------------------------------------------------------------------

const pathOf = (href: string) => href.split("?")[0] ?? href;

/**
 * The one href in `hrefs` that the current (locale-less) path belongs to: the
 * longest matching path, and among equal paths the one without a query
 * (/returns over /returns?status=approved). "/" matches only the home page.
 */
export function activeHref(pathname: string, hrefs: readonly string[]): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  let best: string | null = null;
  for (const href of hrefs) {
    const p = pathOf(href);
    const match = p === "/" ? path === "/" : path === p || path.startsWith(`${p}/`);
    if (!match) continue;
    if (best === null) {
      best = href;
      continue;
    }
    const bp = pathOf(best);
    if (p.length > bp.length || (p.length === bp.length && !href.includes("?") && best.includes("?"))) best = href;
  }
  return best;
}

export const NAV_ICON_KEYS = [
  "home",
  "approvals",
  "notifications",
  "customers",
  "opportunities",
  "catalog",
  "commissions",
  "today",
  "visits",
  "tasks",
  "planning",
  "coverage",
  "tracking",
  "map",
  "leads",
  "orders",
  "newOrder",
  "returns",
  "invoices",
  "payments",
  "collect",
  "aging",
  "collections",
  "stock",
  "movements",
  "receipts",
  "transfers",
  "adjustments",
  "dashboard",
  "reports",
  "users",
  "employees",
  "territories",
  "roles",
  "settings",
  "security",
  "workflow",
  "imports",
  "audit",
  "account",
  "default",
] as const;
export type NavIconKey = (typeof NAV_ICON_KEYS)[number];

const ICONS: Record<string, NavIconKey> = {
  "/": "home",
  "/approvals": "approvals",
  "/notifications": "notifications",
  "/customers": "customers",
  "/opportunities": "opportunities",
  "/catalog": "catalog",
  "/commissions": "commissions",
  "/commissions/periods": "commissions",
  "/commissions/adjustments": "commissions",
  "/today": "today",
  "/visits": "visits",
  "/tasks": "tasks",
  "/planning": "planning",
  "/planning/coverage": "coverage",
  "/tracking": "tracking",
  "/map": "map",
  "/leads": "leads",
  "/orders": "orders",
  "/orders/new": "newOrder",
  "/returns": "returns",
  "/finance/invoices": "invoices",
  "/finance/payments": "payments",
  "/finance/payments/new": "collect",
  "/finance/aging": "aging",
  "/finance/collections": "collections",
  "/inventory": "stock",
  "/inventory/movements": "movements",
  "/inventory/receipts": "receipts",
  "/inventory/transfers": "transfers",
  "/inventory/adjustments/new": "adjustments",
  "/dashboard": "dashboard",
  "/reports": "reports",
  "/admin/users": "users",
  "/admin/employees": "employees",
  "/admin/territories": "territories",
  "/admin/roles": "roles",
  "/admin/settings": "settings",
  "/admin/security": "security",
  "/workflow/delegations": "workflow",
  "/workflow/escalations": "workflow",
  "/workflow/rules": "workflow",
  "/imports": "imports",
  "/audit": "audit",
  "/account/security": "account",
};

/** Icon key for an entry (by path, query ignored); unknown entries get a neutral dot. */
export function navIcon(href: string): NavIconKey {
  return ICONS[pathOf(href)] ?? "default";
}
