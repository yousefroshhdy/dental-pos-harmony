import type { NavItem } from "@/lib/nav";

/** Work-hours tracking (D-14): the managers' team view. Reps reach their own day from the shift card. */
export const trackingNav: NavItem[] = [{ href: "/tracking", labelKey: "tracking.nav.tracking", permission: "field.tracking.read" }];
