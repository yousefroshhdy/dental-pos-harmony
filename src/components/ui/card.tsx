import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Card. Unlike upstream shadcn, the Card itself keeps the padding the pre-Phase-P
 * Card had (p-4, sm:p-6), so `<Card className="space-y-3">…</Card>` keeps working;
 * CardHeader / CardContent / CardFooter only arrange their children.
 */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card" className={cn("rounded-lg border bg-card p-4 text-card-foreground shadow-sm sm:p-6", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-wrap items-start justify-between gap-x-3 gap-y-1", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={cn("text-lg font-semibold", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

/** Top-end slot of a CardHeader (a link or a small button). */
export function CardAction({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-action" className={cn("ms-auto shrink-0", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("pt-3", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("flex flex-wrap items-center gap-2 pt-4", className)} {...props} />;
}
