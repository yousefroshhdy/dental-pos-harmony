"use client";

import { useActionState, useId } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { ActionResult, ActionState } from "../types";
import { ActionMessage } from "./action-message";

/**
 * A row action that needs a reason (suspend, reactivate, revoke). The form is
 * folded inside <details> so tables stay compact, and it works without JS.
 * Hidden fields only identify the record; the database decides whether the
 * signed-in user may act on it.
 */
export function ReasonActionForm({
  action,
  fields,
  trigger,
  confirm,
  reasonLabel,
  reasonPlaceholder,
  destructive = false,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionResult>;
  fields: Record<string, string>;
  trigger: string;
  confirm: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  destructive?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const inputId = useId();

  return (
    <details>
      <summary className={cn(buttonVariants({ variant: "outline" }), "cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden")}>
        {trigger}
      </summary>
      <form action={formAction} className="mt-2 flex min-w-60 flex-col gap-2">
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Label htmlFor={inputId}>{reasonLabel}</Label>
        <Input id={inputId} name="reason" required minLength={3} maxLength={500} placeholder={reasonPlaceholder} autoComplete="off" />
        <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={pending}>
          {confirm}
        </Button>
        <ActionMessage state={state} />
      </form>
    </details>
  );
}
