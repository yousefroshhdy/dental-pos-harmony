"use client";

import { useActionState, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ActionResult, ActionState } from "../types";
import { ActionMessage } from "./action-message";

/**
 * A Server Action form whose fields are rendered by the (server) page as children. It adds the
 * submit button and the translated result line. With `trigger` the form folds into <details>
 * so long lists stay compact; it works without JS. Hidden fields only identify records: the
 * database decides whether the signed-in user may act on them.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  success,
  trigger,
  destructive = false,
  className,
  fieldsClassName,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionResult>;
  children: ReactNode;
  submitLabel: string;
  /** Shown after success; omit when the re-rendered page is feedback enough. */
  success?: string;
  /** Fold the form under a button with this label. */
  trigger?: string;
  destructive?: boolean;
  className?: string;
  fieldsClassName?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  const form = (
    <form action={formAction} className={cn("space-y-3", trigger ? "mt-2" : null, className)}>
      <div className={cn("grid gap-3", fieldsClassName)}>{children}</div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={pending} className="w-full sm:w-auto">
          {submitLabel}
        </Button>
        <ActionMessage state={state} success={success} className="flex-1" />
      </div>
    </form>
  );

  if (!trigger) return form;
  return (
    <details className="w-full">
      <summary
        className={cn(buttonVariants({ variant: "outline" }), "cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden")}
      >
        {trigger}
      </summary>
      {form}
    </details>
  );
}
