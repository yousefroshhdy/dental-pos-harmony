import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Empty, error or "not set up yet" state for a list or a card. Say what is missing
 * and, when there is one, the next action (`action`: a Link or Button). Pass an
 * icon element (lucide, aria-hidden) for a quick visual cue.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "neutral",
  compact = false,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "danger";
  /** Smaller padding, for use inside a card. */
  compact?: boolean;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center",
        compact ? "px-4 py-6" : "px-6 py-10",
        tone === "danger" && "border-destructive/40 bg-destructive/5",
        className,
      )}
      {...props}
    >
      {icon ? (
        <div
          className={cn(
            "mb-1 flex size-11 items-center justify-center rounded-full [&_svg]:size-5",
            tone === "danger" ? "bg-destructive/10 text-destructive" : "bg-secondary text-secondary-foreground",
          )}
        >
          {icon}
        </div>
      ) : null}
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-prose text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
