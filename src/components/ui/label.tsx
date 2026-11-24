import * as LabelPrimitive from "@radix-ui/react-label";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Radix label. No "use client" so server components can render it, as they did
 * with the Label in primitives.tsx (Radix ships its own client boundary).
 */
export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn("text-sm font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-50", className)}
      {...props}
    />
  );
}
