import type { NavItem } from "@/lib/nav";

/**
 * Admin console navigation. The first three entries replace the ones the app layout still
 * hard-codes (nav.users / nav.roles / nav.security); the layout should spread `adminNav`
 * instead (see the admin v2 hand-over notes).
 */
export const adminNav: NavItem[] = [
  { href: "/admin/users", labelKey: "admin.nav.users", permission: "admin.user.read" },
  { href: "/admin/employees", labelKey: "admin.nav.employees", permission: "core.employee.read" },
  { href: "/admin/territories", labelKey: "admin.nav.territories", permission: "core.territory.manage" },
  { href: "/admin/roles", labelKey: "admin.nav.roles", permission: "admin.role.read" },
  { href: "/admin/settings", labelKey: "admin.nav.settings", permission: "admin.settings.manage" },
  { href: "/admin/security", labelKey: "admin.nav.security", permission: "audit.security.read" },
];
