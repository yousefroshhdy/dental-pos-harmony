import { can, canAny, type UserContext } from "@/lib/authz/can";

/**
 * A main-navigation entry. Each module exports its own list from
 * `src/modules/<module>/nav.ts`; the app layout shows an entry only if the user
 * holds its permission (UX only — Postgres enforces access).
 */
export interface NavItem {
  href: string;
  /** Full message key, e.g. "crm.nav.customers". */
  labelKey: string;
  permission: string | null;
  /** Optional: the entry also needs at least one of these (e.g. any export permission). */
  anyPermission?: readonly string[];
}

/** Whether the layout shows `item` to this user (UX only). */
export function navVisible(ctx: UserContext, item: NavItem): boolean {
  if (item.permission !== null && !can(ctx, item.permission)) return false;
  return item.anyPermission === undefined || canAny(ctx, item.anyPermission);
}
