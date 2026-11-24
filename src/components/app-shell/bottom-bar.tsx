"use client";

import { Link, usePathname } from "@/i18n/navigation";
import { activeHref } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { NavIcon } from "./nav-icons";
import type { ShellNavItem } from "./types";

/**
 * Field users' bottom bar on phones (below md): Today · Map · Leads · Visits · Orders,
 * as permitted. Fixed to the bottom with the safe-area inset; the layout pads <main>
 * so content never hides under it. Each item is at least 56 px tall.
 */
export function BottomBar({ items, label }: { items: ShellNavItem[]; label: string }) {
  const pathname = usePathname();
  if (items.length === 0) return null;
  const active = activeHref(
    pathname,
    items.map((i) => i.href),
  );

  return (
    <nav
      aria-label={label}
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_8px_rgb(0_0_0/0.06)] backdrop-blur md:hidden print:hidden"
    >
      <ul className="mx-auto flex max-w-lg">
        {items.map((item) => {
          const isActive = item.href === active;
          return (
            <li key={item.href} className="min-w-0 flex-1">
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[0.6875rem] font-medium text-muted-foreground transition-colors focus-visible:bg-accent focus-visible:outline-none",
                  isActive && "text-primary",
                )}
              >
                <span
                  className={cn("flex h-7 w-12 items-center justify-center rounded-full transition-colors", isActive && "bg-primary/12")}
                  aria-hidden="true"
                >
                  <NavIcon icon={item.icon} className="size-5" />
                </span>
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
