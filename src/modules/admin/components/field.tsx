import type { ReactNode } from "react";
import { Label } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/** Label + control + optional hint, for the admin forms (server-renderable). */
export function Field({
  id,
  label,
  hint,
  optionalLabel,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  /** e.g. "(optional)"; shown after the label. */
  optionalLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={id}>
        {label}
        {optionalLabel ? <span className="ms-1 text-muted-foreground">({optionalLabel})</span> : null}
      </Label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
