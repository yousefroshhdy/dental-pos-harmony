import type { NavItem } from "@/lib/nav";

/**
 * Workflow administration. Rules: whoever configures workflows (owner/admin,
 * admin.workflow.manage). Delegations: approvers who may delegate
 * (wf.delegation.manage); a delegate without it still reaches the page from the
 * delegation notification. Escalations: approval readers; the page itself is
 * caller-scoped, so an escalation target reaches it from the notification too.
 */
export const workflowNav: NavItem[] = [
  { href: "/workflow/delegations", labelKey: "workflow.nav.delegations", permission: "wf.delegation.manage" },
  { href: "/workflow/escalations", labelKey: "workflow.nav.escalations", permission: "wf.approval.read" },
  { href: "/workflow/rules", labelKey: "workflow.nav.rules", permission: "admin.workflow.manage" },
];
