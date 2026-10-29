"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { createTask } from "../actions";
import { TASK_KINDS, type ActionState } from "../types";
import { FieldError } from "./field-error";

/**
 * New task for the caller (api.create_task). A client ref is generated on the
 * device once per task and re-sent on a retry, so a double tap or a resend
 * after a lost response creates one task, not two.
 */
export function CreateTaskForm({
  defaultDueLocal,
  customer,
}: {
  /** "YYYY-MM-DDTHH:mm" in Cairo time. */
  defaultDueLocal: string;
  customer: { id: string; name: string } | null;
}) {
  const t = useTranslations("field.tasks");
  const tKind = useTranslations("field.taskKind");
  const ids = { title: useId(), due: useId(), kind: useId() };
  const clientRef = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const [state, formAction, pending] = useActionState(async (prev: ActionState, form: FormData) => {
    clientRef.current ??= crypto.randomUUID();
    form.set("client_ref", clientRef.current);
    const result = await createTask(prev, form);
    if (result.ok) {
      clientRef.current = null; // the next task gets a new key
      formRef.current?.reset();
    }
    return result;
  }, null);

  return (
    <form ref={formRef} action={formAction} className="grid gap-3 sm:grid-cols-2">
      {customer ? <input type="hidden" name="customer_id" value={customer.id} /> : null}
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor={ids.title}>{t("titleLabel")}</Label>
        <Input id={ids.title} name="title" required minLength={2} maxLength={200} placeholder={t("titlePlaceholder")} autoComplete="off" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.due}>{t("dueLabel")}</Label>
        <Input id={ids.due} name="due_local" type="datetime-local" required defaultValue={defaultDueLocal} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.kind}>{t("kindLabel")}</Label>
        <Select id={ids.kind} name="kind" defaultValue="follow_up" className="w-full">
          {TASK_KINDS.map((k) => (
            <option key={k} value={k}>
              {tKind(k)}
            </option>
          ))}
        </Select>
      </div>
      {customer ? <p className="text-sm text-muted-foreground sm:col-span-2">{t("forCustomer", { name: customer.name })}</p> : null}
      <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {t("create")}
        </Button>
        {state?.ok ? (
          <Alert tone="success" role="status" className="flex-1">
            {t("created")}
          </Alert>
        ) : state ? (
          <FieldError code={state.code} messageKey={state.messageKey} requestId={state.requestId} className="flex-1" />
        ) : null}
      </div>
    </form>
  );
}
