import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Status badge. `variant` is the shadcn name; `tone` is the name the screens written
 * before Phase P use (neutral, success, warning, danger, info) and stays supported.
 * Never rely on colour alone: the text says the status.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        neutral: "border-transparent bg-muted text-muted-foreground",
        success: "border-transparent bg-success/15 text-success-text",
        warning: "border-transparent bg-warning/20 text-foreground",
        danger: "border-transparent bg-destructive/15 text-danger-text",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        info: "border-transparent bg-primary/15 text-primary",
        highlight: "border-transparent bg-highlight/25 text-foreground",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export type BadgeProps = ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    /** Pre-Phase-P alias of `variant`. */
    tone?: BadgeTone;
    asChild?: boolean;
  };

export function Badge({ className, variant, tone, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot : "span";
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant: variant ?? tone }), className)} {...props} />;
}

export { badgeVariants };
