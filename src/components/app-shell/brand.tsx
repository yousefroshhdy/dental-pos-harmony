import { cn } from "@/lib/utils";

/**
 * The HONEST wordmark. Bebas Neue (font-display) is Latin-only, so the word carries
 * lang="en" and dir="ltr"; that also keeps it out of the `.font-display:lang(ar)`
 * fallback in globals.css. Decorative: the surrounding link has the accessible name.
 * `onSidebar`: the deep sidebar surface, where the warm accent has the contrast.
 */
export function Brand({ compact = false, onSidebar = false, className }: { compact?: boolean; onSidebar?: boolean; className?: string }) {
  return (
    <span aria-hidden="true" lang="en" dir="ltr" className={cn("inline-flex items-baseline gap-1 select-none", className)}>
      <span className={cn("font-display leading-none", compact ? "text-2xl" : "text-[1.75rem]")}>HONEST</span>
      {compact ? null : (
        <span className={cn("text-[0.6875rem] font-semibold tracking-[0.2em]", onSidebar ? "text-sidebar-primary" : "text-primary")}>OS</span>
      )}
    </span>
  );
}
