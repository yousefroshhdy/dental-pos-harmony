import type { NavItem } from "@/lib/nav";

/**
 * Commission entries. RLS scopes every statement (a rep: their own, an area manager:
 * the team, finance, the sales director and the owner: everyone); the team summary is
 * a link on the statement page. Periods need perf.commission.calculate (finance) and
 * adjustments perf.commission.adjust (owner by default).
 */
export const commissionsNav: NavItem[] = [
  { href: "/commissions", labelKey: "commissions.nav.statement", permission: "perf.commission.read" },
  { href: "/commissions/periods", labelKey: "commissions.nav.periods", permission: "perf.commission.calculate" },
  { href: "/commissions/adjustments", labelKey: "commissions.nav.adjustments", permission: "perf.commission.adjust" },
];
