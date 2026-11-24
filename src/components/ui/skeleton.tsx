import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Loading placeholder. Decorative: pair it with a status text for screen readers. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="skeleton" aria-hidden="true" className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)} {...props} />;
}

/** A list-shaped loading state: `rows` bars plus a hidden "loading" status. */
export function SkeletonList({ rows = 3, label, className }: { rows?: number; label: string; className?: string }) {
  return (
    <div role="status" className={cn("space-y-2", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}
