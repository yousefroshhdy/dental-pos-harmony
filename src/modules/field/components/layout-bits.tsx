import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Small layout pieces for the field screens (module-local, so no shared file
 * changes). Mobile-first: one column, ≥ 44 px tap targets, the primary action
 * pinned to the bottom of the screen on phones.
 */

/** Primary actions: a bar fixed to the bottom on phones, inline from `sm` up. Pair with <PageBody>. */
export function BottomActions({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      role="region"
      aria-label={label}
      className="fixed inset-x-0 bottom-0 z-10 flex gap-2 border-t bg-card/95 p-3 backdrop-blur sm:static sm:z-auto sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none [&>*]:flex-1 sm:[&>*]:flex-none"
    >
      {children}
    </div>
  );
}

/** Page wrapper leaving room for <BottomActions> on phones. */
export function PageBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("space-y-6 pb-24 sm:pb-0", className)} {...props} />;
}

export function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        {title}
        {count !== undefined ? <span className="rounded-full bg-muted px-2 text-sm font-normal text-muted-foreground">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

export function ItemList({ className, ...props }: ComponentProps<"ul">) {
  return <ul className={cn("space-y-3", className)} {...props} />;
}

export function Item({ className, ...props }: ComponentProps<"li">) {
  return <li className={cn("space-y-3 rounded-lg border bg-card p-4 shadow-sm", className)} {...props} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{children}</p>;
}

/** A filter chip: a link that shows whether it is the active filter. */
export function chipClass(active: boolean): string {
  return cn(
    "inline-flex min-h-11 items-center rounded-full border px-4 text-sm whitespace-nowrap",
    active ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
  );
}

/** Skeleton rows for loading.tsx. */
export function ListSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="space-y-3">
      <div className="h-8 w-40 animate-pulse rounded bg-muted" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  );
}
