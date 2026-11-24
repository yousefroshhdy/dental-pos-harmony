import { Link } from "@/i18n/navigation";
import { hrefWithParam } from "@/lib/list-query";
import { cn } from "@/lib/utils";

export interface FilterChip {
  /** URL value; null is the default (the parameter is removed). */
  value: string | null;
  label: string;
  /** Optional count shown after the label. */
  count?: number;
}

/**
 * A row of filter links (`?status=…`), one per option, the current one marked
 * `aria-current`. Plain links: they work before hydration and without JavaScript,
 * keep the search and sort, and go back to page 1. 44 px tall, scrolls sideways
 * inside itself on a narrow phone instead of widening the page.
 */
export function FilterChips({
  label,
  pathname,
  params,
  param,
  current,
  options,
  className,
}: {
  /** Accessible name of the group, e.g. "Filter by status". */
  label: string;
  pathname: string;
  params: Record<string, string | string[] | undefined>;
  param: string;
  current: string | null;
  options: readonly FilterChip[];
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn("-mx-1 max-w-full overflow-x-auto px-1", className)}>
      <ul className="flex w-max gap-2">
        {options.map((o) => {
          const active = o.value === current;
          return (
            <li key={o.value ?? "_all"}>
              <Link
                href={hrefWithParam(pathname, params, param, o.value)}
                aria-current={active ? "page" : undefined}
                scroll={false}
                className={cn(
                  "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  active ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-accent",
                )}
              >
                {o.label}
                {o.count !== undefined ? (
                  <span className={cn("rounded-full px-1.5 text-xs tabular-nums", active ? "bg-primary-foreground/20" : "bg-muted text-muted-foreground")}>
                    {o.count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
