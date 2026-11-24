"use client";

import { Menu } from "lucide-react";
import { useState } from "react";
import { Link, usePathname } from "@/i18n/navigation";
import { activeHref } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "../ui/sheet";
import { Brand } from "./brand";
import { NavIcon } from "./nav-icons";
import type { ShellNavGroup } from "./types";

/** Phones and small tablets: the same department groups in a drawer from the reading start. */
export function MobileNav({
  groups,
  labels,
}: {
  groups: ShellNavGroup[];
  labels: { open: string; title: string; description: string; close: string; nav: string };
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const active = activeHref(
    pathname,
    groups.flatMap((g) => g.items.map((i) => i.href)),
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={labels.open} className="md:hidden">
          <Menu aria-hidden="true" className="size-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="start" closeLabel={labels.close} className="gap-0 bg-sidebar p-0 text-sidebar-foreground">
        <SheetHeader className="border-b border-sidebar-border">
          <SheetTitle className="flex items-center">
            <Brand onSidebar />
            <span className="sr-only">{labels.title}</span>
          </SheetTitle>
          <SheetDescription className="sr-only">{labels.description}</SheetDescription>
        </SheetHeader>
        <nav aria-label={labels.nav} className="flex-1 overflow-y-auto px-2 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {groups.map((group) => (
            <div key={group.id} className="mt-3 first:mt-1">
              <p className="px-3 pb-1 text-[0.6875rem] font-semibold tracking-wider text-sidebar-muted uppercase">{group.label}</p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const isActive = item.href === active;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setOpen(false)}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "relative flex min-h-11 items-center gap-3 rounded-md px-3 text-sm text-sidebar-foreground/85 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-primary focus-visible:outline-none",
                          isActive && "bg-sidebar-accent font-medium text-sidebar-foreground",
                        )}
                      >
                        {isActive ? <span aria-hidden="true" className="absolute inset-y-2 start-0 w-1 rounded-full bg-sidebar-primary" /> : null}
                        <NavIcon icon={item.icon} className="size-[1.125rem] shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
