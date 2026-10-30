import type { NavItem } from "@/lib/nav";

/** Visit planning (reps and managers) and coverage (anyone who reads visits). */
export const planningNav: NavItem[] = [
  { href: "/planning", labelKey: "planning.nav.planning", permission: "field.visit.plan" },
  { href: "/planning/coverage", labelKey: "planning.nav.coverage", permission: "field.visit.read" },
];
