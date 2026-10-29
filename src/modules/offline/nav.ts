import type { NavItem } from "@/lib/nav";

/**
 * The sync screen shows only the user's own device queue, so it needs no
 * permission. The header SyncIndicator links to it as well.
 */
export const offlineNav: NavItem[] = [{ href: "/sync", labelKey: "offline.nav.sync", permission: null }];
