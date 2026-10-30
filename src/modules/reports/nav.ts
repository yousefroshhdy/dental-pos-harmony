import type { NavItem } from "@/lib/nav";

/**
 * /reports lists the exports the user may run. Every role in the catalogue
 * holds at least one list permission an export uses, and NavItem takes a
 * single permission, so the entry is ungated; the page shows only the
 * exports the user may run (and an empty state if none).
 */
export const reportsNav: NavItem[] = [{ href: "/reports", labelKey: "reports.nav.reports", permission: null }];
