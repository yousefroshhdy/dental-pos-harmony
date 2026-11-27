import type { UserContext } from "@/lib/authz/can";
import type { NavItem } from "@/lib/nav";

/**
 * Whether the user can decide some approval (the owner, or any wf.decide.* holder). UX only:
 * api.decide_approval re-checks every stage. An inventory manager holds wf.approval.read but
 * decides nothing, so their inbox's "To decide" tab is always empty.
 */
export function decidesApprovals(ctx: UserContext): boolean {
  if (!ctx.active) return false;
  return ctx.is_owner || Object.keys(ctx.permissions).some((p) => p.startsWith("wf.decide."));
}

/**
 * Approvals (H1 UI pass): deciders get "Approvals" (/approvals opens on "To decide"); everyone
 * else who holds a role gets "My requests" (/approvals?tab=mine), the requests they raised
 * (discounts, returns, visit exceptions, stock adjustments). /approvals is caller-scoped, not
 * permission-gated, so both entries only choose the starting tab. Notifications are self-service.
 */
export const approvalsNav: NavItem[] = [
  { href: "/approvals", labelKey: "approvals.nav.approvals", permission: "wf.approval.read", when: decidesApprovals },
  {
    href: "/approvals?tab=mine",
    labelKey: "approvals.nav.myRequests",
    permission: null,
    when: (ctx) => ctx.active && !decidesApprovals(ctx) && Object.keys(ctx.permissions).length > 0,
  },
  { href: "/notifications", labelKey: "approvals.nav.notifications", permission: null },
];
