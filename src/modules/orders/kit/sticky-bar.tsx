import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The primary actions of a form or detail page, kept in reach on phones: sticky at
 * the bottom of the viewport while the page scrolls (above the shell's bottom bar
 * when there is one), an ordinary row from `md` up. Server or client.
 */
export function StickyActionBar({ aboveBottomNav, children, className }: { aboveBottomNav: boolean; children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="sticky-action-bar"
      className={cn(
        "sticky z-20 -mx-4 border-t bg-card/95 px-4 py-3 shadow-[0_-1px_8px_rgb(0_0_0/0.06)] backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:p-0 md:shadow-none md:backdrop-blur-none print:hidden",
        aboveBottomNav ? "bottom-[calc(3.5rem+1px+env(safe-area-inset-bottom))] md:bottom-auto" : "bottom-0 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:pb-0",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">{children}</div>
    </div>
  );
}
