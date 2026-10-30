"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import { createDelegation, revokeDelegation } from "../actions";
import { localizedName } from "../logic";
import type { PersonRow } from "../types";
import { ActionMessage } from "./action-message";
import { ReasonField } from "./reason-field";

export interface WorkflowOption {
  code: string;
  label: string;
}

/**
 * Out-of-office delegation. Times are Cairo time. "On behalf of" appears only
 * for managers whose wf.delegation.manage covers other people; the database
 * re-checks that scope and refuses delegating someone else's approvals to
 * yourself. The client_ref makes a double submit create one delegation.
 */
export function DelegationForm({
  clientRef,
  me,
  people,
  onBehalfOf,
  workflows,
  defaultFrom,
  defaultTo,
  locale,
}: {
  clientRef: string;
  me: string | null;
  people: PersonRow[];
  /** People (other than me) whose delegations I manage. */
  onBehalfOf: PersonRow[];
  workflows: WorkflowOption[];
  defaultFrom: string;
  defaultTo: string;
  locale: string;
}) {
  const t = useTranslations("workflow.delegations.form");
  const [state, formAction, pending] = useActionState(createDelegation, null);
  const id = useId();
  const person = (p: PersonRow) => `${localizedName(locale, p.full_name_en, p.full_name_ar)} · ${p.job_title ?? p.employee_no}`;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="client_ref" value={clientRef} />
      {onBehalfOf.length > 0 ? (
        <div className="space-y-1">
          <Label htmlFor={`${id}-from`}>{t("from")}</Label>
          <Select id={`${id}-from`} name="from_employee_id" defaultValue="" className="w-full">
            <option value="">{t("fromMe")}</option>
            {onBehalfOf.map((p) => (
              <option key={p.employee_id} value={p.employee_id}>
                {person(p)}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor={`${id}-to`}>{t("to")}</Label>
        <Select id={`${id}-to`} name="to_employee_id" required defaultValue="" className="w-full">
          <option value="" disabled>
            {t("choose")}
          </option>
          {people
            .filter((p) => p.employee_id !== me)
            .map((p) => (
              <option key={p.employee_id} value={p.employee_id}>
                {person(p)}
              </option>
            ))}
        </Select>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-start`}>{t("start")}</Label>
          <Input id={`${id}-start`} name="valid_from" type="datetime-local" defaultValue={defaultFrom} dir="ltr" />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-end`}>{t("end")}</Label>
          <Input id={`${id}-end`} name="valid_to" type="datetime-local" required defaultValue={defaultTo} dir="ltr" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("windowHint")}</p>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("workflows")}</legend>
        <p className="text-xs text-muted-foreground">{t("workflowsHint")}</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {workflows.map((w) => (
            <label key={w.code} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="workflow_codes" value={w.code} className="size-5" />
              {w.label}
            </label>
          ))}
        </div>
      </fieldset>
      <ReasonField required={false} />
      <ActionMessage state={state} success={t("created")} />
      <div className="sticky bottom-0 -mx-4 border-t bg-card px-4 py-3 sm:static sm:mx-0 sm:border-0 sm:px-0 sm:py-0">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

/** End a delegation now (the delegator, the delegate, a manager in scope, or a workflow admin). */
export function EndDelegationForm({ delegationId }: { delegationId: string }) {
  const t = useTranslations("workflow.delegations");
  const [state, formAction, pending] = useActionState(revokeDelegation, null);

  return (
    <details>
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center rounded-md border px-4 text-sm font-medium select-none hover:bg-muted [&::-webkit-details-marker]:hidden">
        {t("end")}
      </summary>
      <form action={formAction} className="mt-2 flex min-w-60 flex-col gap-2">
        <input type="hidden" name="delegation_id" value={delegationId} />
        <ReasonField required={false} />
        <Button type="submit" variant="destructive" disabled={pending}>
          {t("endConfirm")}
        </Button>
        <ActionMessage state={state} />
      </form>
    </details>
  );
}
