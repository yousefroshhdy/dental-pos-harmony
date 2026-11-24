"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useState } from "react";
import { Link, usePathname } from "@/i18n/navigation";
import { activeHref } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { Brand } from "./brand";
import { NavIcon } from "./nav-icons";
import { SIDEBAR_COOKIE, type ShellNavGroup } from "./types";

/**
 * Desktop sidebar (md and up): department groups, permission-filtered on the server.
 * Collapses to an icon rail; the choice is kept in a cookie so the server renders
 * the right width on the next page. Each entry keeps its text as the accessible
 * name when collapsed (sr-only + tooltip).
 */
export function AppSidebar({
  groups,
  initialCollapsed,
  dir,
  labels,
}: {
  groups: ShellNavGroup[];
  initialCollapsed: boolean;
  dir: "rtl" | "ltr";
  labels: { nav: string; home: string; collapse: string; expand: string };
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const pathname = usePathname();
  const active = activeHref(
    pathname,
    groups.flatMap((g) => g.items.map((i) => i.href)),
  );

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`;
  };

  return (
    <aside
      data-collapsed={collapsed || undefined}
      className={cn(
        // The dark column stretches to the full page height (flex row parent); its
        // content sticks to the viewport and scrolls on its own.
        "hidden shrink-0 self-stretch border-e border-sidebar-border bg-sidebar text-sidebar-foreground transition-[inline-size] duration-200 md:block print:hidden",
        collapsed ? "w-[4.5rem]" : "w-64",
      )}
    >
      <div data-testid="sidebar-panel" className="sticky top-0 flex h-dvh flex-col">
        <div className={cn("flex h-14 items-center gap-2 px-3", collapsed && "justify-center px-0")}>
          <Link href="/" aria-label={labels.home} className="inline-flex min-h-11 items-center rounded-md px-1 focus-visible:ring-2 focus-visible:ring-sidebar-primary focus-visible:outline-none">
            <Brand compact={collapsed} onSidebar />
          </Link>
        </div>

        <nav aria-label={labels.nav} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
          {groups.map((group) => (
            <div key={group.id} className="mt-3 first:mt-1">
              {collapsed ? (
                <div className="mx-2 my-2 h-px bg-sidebar-border first:hidden" aria-hidden="true" />
              ) : (
                <p className="px-3 pb-1 text-[0.6875rem] font-semibold tracking-wider text-sidebar-muted uppercase">{group.label}</p>
              )}
              <ul className="space-y-0.5" aria-label={collapsed ? group.label : undefined}>
                {group.items.map((item) => {
                  const isActive = item.href === active;
                  const link = (
                    <Link
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "relative flex min-h-10 items-center gap-3 rounded-md px-3 text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-primary focus-visible:outline-none",
                        isActive && "bg-sidebar-accent font-medium text-sidebar-foreground",
                        collapsed && "justify-center px-0",
                      )}
                    >
                      {isActive ? <span aria-hidden="true" className="absolute inset-y-2 start-0 w-1 rounded-full bg-sidebar-primary" /> : null}
                      <NavIcon icon={item.icon} className="size-[1.125rem] shrink-0" />
                      <span className={cn("truncate", collapsed && "sr-only")}>{item.label}</span>
                    </Link>
                  );
                  return (
                    <li key={item.href}>
                      {collapsed ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{link}</TooltipTrigger>
                          {/* Radix sides are physical: the tooltip opens towards the content. */}
                          <TooltipContent side={dir === "rtl" ? "left" : "right"}>
                            {item.label}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        link
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-sidebar-border p-2">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            className={cn(
              "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-sm text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-primary focus-visible:outline-none",
              collapsed && "justify-center px-0",
            )}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" className="size-[1.125rem] rtl:rotate-180" />
            ) : (
              <PanelLeftClose aria-hidden="true" className="size-[1.125rem] rtl:rotate-180" />
            )}
            <span className={cn(collapsed && "sr-only")}>{collapsed ? labels.expand : labels.collapse}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
