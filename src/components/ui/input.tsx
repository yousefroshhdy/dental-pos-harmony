import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Text input. 44 px tall; 16 px text on phones so iOS does not zoom on focus. */
export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 text-base shadow-xs transition-colors outline-none placeholder:text-muted-foreground file:me-3 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/30 sm:text-sm",
        className,
      )}
      {...props}
    />
  );
}
