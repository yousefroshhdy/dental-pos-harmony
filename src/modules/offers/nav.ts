import type { NavItem } from "@/lib/nav";

/**
 * Offers and packages (decision B): sellers and price readers see them, the owner
 * (sales.offer.manage) defines them. The messages live in the orders namespace
 * (messages/<locale>/orders.json → "offerAdmin"), so no shared file changes.
 */
export const offersNav: NavItem[] = [
  { href: "/offers", labelKey: "orders.nav.offers", permission: null, anyPermission: ["sales.offer.manage", "catalog.price.read", "sales.order.create"] },
];
