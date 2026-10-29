import type { NavItem } from "@/lib/nav";

export const crmNav: NavItem[] = [
  { href: "/customers", labelKey: "crm.nav.customers", permission: "crm.customer.read" },
  { href: "/opportunities", labelKey: "crm.nav.opportunities", permission: "crm.opportunity.read" },
];
