import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading state of the redesigned list and detail pages: a header,
 * a filter row and table-like bars (cards on phones), with a status text that
 * screen readers announce. Motion stops under prefers-reduced-motion.
 */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-4">
      <span className="sr-only">{label}</span>
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-11 w-full sm:w-64" />
        <Skeleton className="h-11 w-32" />
        <Skeleton className="h-11 w-32" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-16 w-full md:h-11" />
        ))}
      </div>
    </div>
  );
}
