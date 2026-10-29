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
}
