import type { NavItem } from "@/lib/nav";

/**
 * Leads around each rep (Phase P step 4). "Leads near me" for anyone who reads leads (reps: their
 * own; managers: their team's); the team view for those who may reassign leads (and the owner).
 */
export const leadsNav: NavItem[] = [
  { href: "/leads", labelKey: "leads.nav.leads", permission: "crm.lead.read" },
  { href: "/leads/team", labelKey: "leads.nav.team", permission: "crm.lead.assign" },
];
