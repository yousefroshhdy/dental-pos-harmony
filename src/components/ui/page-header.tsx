import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The top of a screen: one h1, an optional description, optional breadcrumb-like
 * `eyebrow` (e.g. a back link) and actions. Actions wrap under the title on phones.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div data-slot="page-header" className={cn("flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)} {...props}>
      <div className="min-w-0 space-y-1">
        {eyebrow ? <div className="text-sm text-muted-foreground">{eyebrow}</div> : null}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {description ? <p className="max-w-prose text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
