import type { UserContext } from "@/lib/authz/can";
import { bottomBarItems } from "@/lib/nav";

/** True when the shell shows the field users' bottom bar on phones, so a StickyActionBar must sit above it. */
export function hasBottomNav(ctx: UserContext): boolean {
  return bottomBarItems(ctx).length > 0;
}
