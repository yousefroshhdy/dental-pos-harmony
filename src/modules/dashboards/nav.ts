import type { NavItem } from "@/lib/nav";

/**
 * The role dashboard: perf.kpi.read opens it (own → rep, team/territory → manager,
 * all → company view). Targets are managed from a link on the dashboard itself.
 */
export const dashboardsNav: NavItem[] = [{ href: "/dashboard", labelKey: "dashboards.nav.dashboard", permission: "perf.kpi.read" }];
