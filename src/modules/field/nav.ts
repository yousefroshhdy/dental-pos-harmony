import type { NavItem } from "@/lib/nav";

/**
 * The rep's day. Today is gated on check-in rights (it is the field home);
 * the page itself also opens for task-only users (logic.canSeeToday).
 */
export const fieldNav: NavItem[] = [
  { href: "/today", labelKey: "field.nav.today", permission: "field.visit.create" },
  { href: "/visits", labelKey: "field.nav.visits", permission: "field.visit.read" },
  { href: "/tasks", labelKey: "field.nav.tasks", permission: "work.task.read" },
];
