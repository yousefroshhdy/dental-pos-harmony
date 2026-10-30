import type { NavItem } from "@/lib/nav";

/**
 * Data migration (ROADMAP Phase 3 task 11). admin.import.run is held by the owner only
 * by default (sensitive); the page re-checks the scope and Postgres enforces it.
 */
export const importsNav: NavItem[] = [{ href: "/imports", labelKey: "imports.nav.imports", permission: "admin.import.run" }];
