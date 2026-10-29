import type { ComponentProps, ReactNode } from "react";
import { Label } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/**
 * Small form primitives used only by the catalogue screens (the shared kit has no
 * textarea or checkbox yet). Same look as src/components/ui/primitives.tsx.
 */

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

/** Checkbox with a 44px tap target and its label. */
export function CheckboxField({ id, label, hint, ...props }: ComponentProps<"input"> & { id: string; label: string; hint?: string }) {
  return (
    <div className="flex min-h-11 items-start gap-3">
      <input id={id} type="checkbox" className="mt-1 size-5 shrink-0 accent-primary" aria-describedby={hint ? `${id}-hint` : undefined} {...props} />
      <div>
        <Label htmlFor={id}>{label}</Label>
        {hint ? (
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Label + control + optional hint, stacked. */
export function Field({ id, label, hint, children, className }: { id: string; label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** On phones the primary action sticks to the bottom of the screen; inline from sm up. */
export function FormActions({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 border-t bg-card/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:items-center sm:border-0 sm:bg-transparent sm:p-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
