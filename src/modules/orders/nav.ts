import type { NavItem } from "@/lib/nav";

/** Orders list (RLS scopes it: own / team / all); "New order" for users who may draft. */
export const ordersNav: NavItem[] = [
  { href: "/orders", labelKey: "orders.nav.orders", permission: "sales.order.read" },
  { href: "/orders/new", labelKey: "orders.nav.newOrder", permission: "sales.order.create" },
];
