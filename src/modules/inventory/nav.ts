import type { NavItem } from "@/lib/nav";

/**
 * Inventory screens and the permission that opens each (docs/AUTHORIZATION.md,
 * inventory.* catalogue). UX only: RLS and the api.* commands enforce access
 * and warehouse scope.
 *  - Stock: inventory.stock.read (sales roles see sellable availability only;
 *    inventory.module.access adds lots, expiry, quarantine/transit and alerts).
 *  - Transfers: the page also opens for inventory.transfer.receive and
 *    inventory.movement.read; the entry uses the creating permission because a
 *    NavItem takes a single permission.
 */
export const inventoryNav: NavItem[] = [
  { href: "/inventory", labelKey: "inventory.nav.stock", permission: "inventory.stock.read" },
  { href: "/inventory/movements", labelKey: "inventory.nav.movements", permission: "inventory.movement.read" },
  { href: "/inventory/receipts", labelKey: "inventory.nav.receipts", permission: "inventory.receipt.post" },
  { href: "/inventory/transfers", labelKey: "inventory.nav.transfers", permission: "inventory.transfer.create" },
  { href: "/inventory/adjustments/new", labelKey: "inventory.nav.adjustments", permission: "inventory.adjustment.post" },
];
