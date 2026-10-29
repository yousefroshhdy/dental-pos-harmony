"use client";

import { useActionState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ActionResult, ActionState } from "../types";
import { InventoryActionMessage } from "./inventory-error";

/**
 * A stock-moving action behind a confirmation step (post a receipt, ship or
 * receive a transfer). Folded inside <details> so lists stay compact; works
 * without JS. Hidden fields only identify the record; the database decides.
 */
export function ConfirmActionForm({
  action,
  fields,
  trigger,
  confirm,
  hint,
  success,
  primary = false,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionResult>;
  fields: Record<string, string>;
  trigger: string;
  confirm: string;
  hint?: string;
  success?: string;
  primary?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  if (state?.ok) return <InventoryActionMessage state={state} success={success} />;

  return (
    <details className="w-full sm:w-auto">
      <summary
        className={cn(
          buttonVariants({ variant: primary ? "default" : "outline" }),
          "w-full cursor-pointer list-none select-none sm:w-auto [&::-webkit-details-marker]:hidden",
        )}
      >
        {trigger}
      </summary>
      <form action={formAction} className="mt-2 flex min-w-60 flex-col gap-2">
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
        <Button type="submit" disabled={pending}>
          {confirm}
        </Button>
        <InventoryActionMessage state={state} />
      </form>
    </details>
  );
}
