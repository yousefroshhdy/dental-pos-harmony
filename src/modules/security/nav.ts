import type { NavItem } from "@/lib/nav";

/** Every signed-in user manages their own second factor, so the entry needs no permission. */
export const securityNav: NavItem[] = [{ href: "/account/security", labelKey: "security.nav.account", permission: null }];
