import type { NavItem } from "@/lib/nav";

/**
 * Audit reader. Row images are owner-only by default: audit.row_image.read is held by
 * no role, and owners hold every permission implicitly (api.audit_* enforce it).
 */
export const auditNav: NavItem[] = [{ href: "/audit", labelKey: "audit.nav.log", permission: "audit.row_image.read" }];
