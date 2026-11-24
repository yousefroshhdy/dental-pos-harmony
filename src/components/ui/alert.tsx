import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const alertVariants = cva("rounded-md border px-3 py-2 text-sm", {
  variants: {
    tone: {
      danger: "border-destructive/40 bg-destructive/10",
      info: "border-primary/40 bg-primary/10",
      success: "border-success/40 bg-success/10",
      warning: "border-warning/60 bg-warning/10",
    },
  },
  defaultVariants: { tone: "danger" },
});

/**
 * Inline message. role="alert" by default (as before Phase P); pass role="status"
 * for non-urgent information so screen readers don't interrupt.
 */
export function Alert({ tone, className, ...props }: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div role="alert" data-slot="alert" className={cn(alertVariants({ tone }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="alert-title" className={cn("font-medium", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("text-muted-foreground", className)} {...props} />;
}

export { alertVariants };
