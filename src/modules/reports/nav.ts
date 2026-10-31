import type { NavItem } from "@/lib/nav";
import { EXPORT_PERMISSION } from "./kinds";

/** Every dedicated export permission, once each (orders and order lines share one). */
export const EXPORT_PERMISSION_CODES: readonly string[] = [...new Set(Object.values(EXPORT_PERMISSION))].sort();

/**
 * /reports lists the exports the user may run. Each export needs its own
 * `<module>.<resource>.export` permission (owner decision 2026-10-31), so the
 * entry is shown only to users who hold at least one of them; the page itself
 * shows only the exports the user may run (and an empty state if none).
 */
export const reportsNav: NavItem[] = [
  { href: "/reports", labelKey: "reports.nav.reports", permission: null, anyPermission: EXPORT_PERMISSION_CODES },
];
