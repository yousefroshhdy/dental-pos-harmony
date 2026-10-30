import type { NavItem } from "@/lib/nav";

/**
 * Returns entries, one per job: reps request returns, inventory receives the
 * approved ones into quarantine, finance credits the received ones. RLS scopes
 * every list; each entry needs the permission for that job.
 */
export const returnsNav: NavItem[] = [
  { href: "/returns", labelKey: "returns.nav.returns", permission: "sales.return.request" },
  { href: "/returns?status=approved", labelKey: "returns.nav.toReceive", permission: "sales.return.receive" },
  { href: "/returns?status=received", labelKey: "returns.nav.toCredit", permission: "sales.return.credit" },
];
