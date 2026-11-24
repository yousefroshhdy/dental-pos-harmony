import type { NavItem } from "@/lib/nav";

/**
 * Google Maps (Phase P step 3). The customers map for anyone who reads customers, the team map
 * for tracking readers (D-14), and the pin proposals for crm.customer_location.verify holders.
 */
export const mapsNav: NavItem[] = [
  { href: "/map", labelKey: "maps.nav.map", permission: "crm.customer.read" },
  { href: "/map/team", labelKey: "maps.nav.team", permission: "field.tracking.read" },
  { href: "/map/proposals", labelKey: "maps.nav.proposals", permission: "crm.customer_location.verify" },
];
