import type { NavItem } from "@/lib/nav";

/**
 * Approvals: every seeded role that holds a wf.decide.* permission also holds
 * wf.approval.read, so that permission shows the inbox. Requesters without it
 * still reach their own requests from notifications (/approvals is
 * caller-scoped, not permission-gated). Notifications are self-service.
 */
export const approvalsNav: NavItem[] = [
  { href: "/approvals", labelKey: "approvals.nav.approvals", permission: "wf.approval.read" },
  { href: "/notifications", labelKey: "approvals.nav.notifications", permission: null },
];
