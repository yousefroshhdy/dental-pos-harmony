"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { completeTask } from "../actions";
import { FieldError } from "./field-error";

/**
 * Mark a task done with an outcome (api.complete_task; a replay of a done task
 * is a no-op). Folded inside <details> so lists stay compact.
 */
export function CompleteTaskForm({ taskId, title }: { taskId: string; title: string }) {
  const t = useTranslations("field.tasks");
  const [state, formAction, pending] = useActionState(completeTask, null);
  const inputId = useId();

  return (
    <details className="w-full sm:w-auto">
      <summary
        className={cn(buttonVariants({ variant: "outline" }), "w-full cursor-pointer list-none select-none sm:w-auto [&::-webkit-details-marker]:hidden")}
        aria-label={t("completeFor", { title })}
      >
        {t("complete")}
      </summary>
      <form action={formAction} className="mt-2 flex min-w-60 flex-col gap-2">
        <input type="hidden" name="task_id" value={taskId} />
        <Label htmlFor={inputId}>{t("outcomeLabel")}</Label>
        <Input id={inputId} name="outcome" required minLength={2} maxLength={1000} placeholder={t("outcomePlaceholder")} autoComplete="off" />
        <Button type="submit" disabled={pending}>
          {t("completeConfirm")}
        </Button>
        {state && !state.ok ? <FieldError code={state.code} messageKey={state.messageKey} requestId={state.requestId} /> : null}
      </form>
    </details>
  );
}
