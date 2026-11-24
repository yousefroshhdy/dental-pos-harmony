import type { NavItem } from "@/lib/nav";

/**
 * Commission entries. RLS scopes every statement (a rep: their own, an area manager:
 * the team, finance, the sales director and the owner: everyone); the team summary is
 * a link on the statement page. Periods need perf.commission.calculate (finance) and
 * adjustments perf.commission.adjust (owner by default), the rate editor
 * perf.commission_plan.read (changes need perf.commission_plan.manage: the owner).
 */
export const commissionsNav: NavItem[] = [
  { href: "/commissions", labelKey: "commissions.nav.statement", permission: "perf.commission.read" },
  { href: "/commissions/periods", labelKey: "commissions.nav.periods", permission: "perf.commission.calculate" },
  { href: "/commissions/adjustments", labelKey: "commissions.nav.adjustments", permission: "perf.commission.adjust" },
  // Rate editor: readable with perf.commission_plan.read (sales director); editable by the owner only.
  { href: "/commissions/plans", labelKey: "commissions.nav.plans", permission: "perf.commission_plan.read" },
];
