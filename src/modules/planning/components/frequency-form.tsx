"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/primitives";
import { setVisitFrequency } from "../actions";
import { VISIT_CLASSES, type ActionState, type VisitClass } from "../types";
import { PlanningError } from "./planning-error";

/** Managers: set a customer's visit class (api.set_visit_frequency). */
export function FrequencyForm({ customerId, customerName, current }: { customerId: string; customerName: string; current: VisitClass }) {
  const t = useTranslations("planning.coverage");
  const tClass = useTranslations("planning.class");
  const id = useId();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(setVisitFrequency, null);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="customer_id" value={customerId} />
      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={id} className="sr-only">
            {t("classFor", { name: customerName })}
          </Label>
          <Select id={id} name="visit_class" defaultValue={current}>
            {VISIT_CLASSES.map((c) => (
              <option key={c} value={c}>
                {tClass(c)}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={pending} className="min-h-11">
          {pending ? t("saving") : t("saveClass")}
        </Button>
      </div>
      {state?.ok ? (
        <p role="status" className="text-xs text-success">
          {t("classSaved")}
        </p>
      ) : state ? (
        <PlanningError code={state.code} messageKey={state.messageKey} requestId={state.requestId} />
      ) : null}
    </form>
  );
}
