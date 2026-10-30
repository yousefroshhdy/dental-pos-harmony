"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { updateCollectionTask } from "../actions";
import { COLLECTION_NOTE_REQUIRED } from "../logic";
import type { CollectionAction } from "../types";
import { FinanceActionMessage } from "./finance-error";

/**
 * Update a collection task: promise to pay (date, optional amount), reopen a broken
 * promise, escalate, mark collected, or close. Folded in <details>; works without JS
 * except for showing the promise fields only for "promise".
 */
export function CollectionTaskForm({
  taskId,
  locale,
  actions,
  today,
}: {
  taskId: string;
  locale: string;
  actions: CollectionAction[];
  /** Cairo business day, YYYY-MM-DD (min promise date). */
  today: string;
}) {
  const t = useTranslations("finance.collections");
  const [state, formAction, pending] = useActionState(updateCollectionTask, null);
  const [action, setAction] = useState<CollectionAction>(actions[0] ?? "promise");
  const ids = { action: useId(), date: useId(), amount: useId(), note: useId() };
  if (actions.length === 0) return null;
  const noteRequired = COLLECTION_NOTE_REQUIRED.includes(action);

  return (
    <details className="min-w-0">
      <summary className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-11 cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden")}>
        {t("update")}
      </summary>
      <form action={formAction} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="task_id" value={taskId} />
        <input type="hidden" name="locale" value={locale} />
        <Label htmlFor={ids.action}>{t("action")}</Label>
        <Select id={ids.action} name="action" value={action} onChange={(e) => setAction(e.target.value as CollectionAction)} className="w-full">
          {actions.map((a) => (
            <option key={a} value={a}>
              {t(`actions.${a}`)}
            </option>
          ))}
        </Select>
        {action === "promise" ? (
          <>
            <Label htmlFor={ids.date}>{t("promisedDate")}</Label>
            <Input id={ids.date} name="promised_date" type="date" min={today} required />
            <Label htmlFor={ids.amount}>{t("promisedAmount")}</Label>
            <Input id={ids.amount} name="promised_amount" inputMode="decimal" autoComplete="off" placeholder="0.00" />
          </>
        ) : null}
        <Label htmlFor={ids.note}>{noteRequired ? t("noteRequired") : t("note")}</Label>
        <Input id={ids.note} name="note" maxLength={1000} autoComplete="off" required={noteRequired} />
        <Button type="submit" disabled={pending}>
          {t("save")}
        </Button>
        <FinanceActionMessage state={state} />
      </form>
    </details>
  );
}
