import type { NavItem } from "@/lib/nav";

/**
 * One main-nav entry for the whole catalogue; price lists and promotions are tabs
 * inside it (src/modules/catalog/components/catalog-tabs.tsx), each gated by its own
 * read permission. Reps hold catalog.product.read too and get a read-only view.
 */
export const catalogNav: NavItem[] = [{ href: "/catalog", labelKey: "catalog.nav.catalog", permission: "catalog.product.read" }];
