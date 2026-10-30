"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { addPlannedVisit } from "../actions";
import type { ActionState, VisitClass } from "../types";
import { PlanningError } from "./planning-error";

export interface CustomerOption {
  id: string;
  label: string;
  visitClass: VisitClass;
}

/**
 * Plan one visit (api.plan_visits with a single item). The client ref is generated on the device
 * once per visit and re-sent on a retry, so a double tap plans once; it changes after a success.
 */
export function AddVisitForm({
  employeeId,
  customers,
  defaultDate,
  minDate,
  defaultCustomerId,
}: {
  employeeId: string;
  customers: CustomerOption[];
  defaultDate: string;
  minDate: string;
  defaultCustomerId?: string;
}) {
  const t = useTranslations("planning.add");
  const tClass = useTranslations("planning.class");
  const ids = { customer: useId(), date: useId() };
  const clientRef = useRef<string | null>(null);

  const [state, formAction, pending] = useActionState(async (prev: ActionState, form: FormData) => {
    clientRef.current ??= crypto.randomUUID();
    form.set("client_ref", clientRef.current);
    const result = await addPlannedVisit(prev, form);
    if (result.ok) clientRef.current = null; // the next visit gets a new key
    return result;
  }, null);

  if (customers.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("noCustomers")}</p>;
  }

  const preselected = customers.some((c) => c.id === defaultCustomerId) ? defaultCustomerId : undefined;

  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
      <input type="hidden" name="employee_id" value={employeeId} />
      <div className="space-y-1">
        <Label htmlFor={ids.customer}>{t("customer")}</Label>
        <Select id={ids.customer} name="customer_id" required defaultValue={preselected ?? ""} className="w-full">
          <option value="" disabled>
            {t("chooseCustomer")}
          </option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} · {tClass(c.visitClass)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.date}>{t("date")}</Label>
        <Input id={ids.date} name="date" type="date" required min={minDate} defaultValue={defaultDate} />
      </div>
      <Button type="submit" disabled={pending} className="w-full sm:w-auto">
        {pending ? t("adding") : t("submit")}
      </Button>
      <div className="sm:col-span-3" aria-live="polite">
        {state?.ok ? (
          <Alert tone="success" role="status">
            {t("added")}
          </Alert>
        ) : state ? (
          <PlanningError code={state.code} messageKey={state.messageKey} requestId={state.requestId} />
        ) : null}
      </div>
    </form>
  );
}
