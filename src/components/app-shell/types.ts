import type { NavGroupId, NavIconKey } from "@/lib/nav";

/** Nav data the server layout hands to the client shell: permission-filtered and already translated. */
export interface ShellNavItem {
  href: string;
  label: string;
  icon: NavIconKey;
}

export interface ShellNavGroup {
  id: NavGroupId;
  label: string;
  items: ShellNavItem[];
}

/** Cookie that remembers the collapsed desktop sidebar, read on the server so the first paint is right. */
export const SIDEBAR_COOKIE = "honest_sidebar";
