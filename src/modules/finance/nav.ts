import type { NavItem } from "@/lib/nav";

/**
 * Finance entries. RLS scopes every list (reps: their customers' invoices and
 * the payments they collected; finance: everything); each entry needs the
 * permission that lets the user see that screen.
 */
export const financeNav: NavItem[] = [
  { href: "/finance/invoices", labelKey: "finance.nav.invoices", permission: "finance.invoice.read" },
  { href: "/finance/payments", labelKey: "finance.nav.payments", permission: "finance.payment.read" },
  { href: "/finance/payments/new", labelKey: "finance.nav.collect", permission: "finance.payment.record" },
  { href: "/finance/aging", labelKey: "finance.nav.aging", permission: "finance.page.aging" },
  { href: "/finance/collections", labelKey: "finance.nav.collections", permission: "finance.collection.manage" },
];
