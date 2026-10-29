import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Multi-line input styled like the shared Input (no shared Textarea primitive exists yet). */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "flex min-h-24 w-full rounded-md border bg-card px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:text-sm",
        className,
      )}
      {...props}
    />
  );
}
