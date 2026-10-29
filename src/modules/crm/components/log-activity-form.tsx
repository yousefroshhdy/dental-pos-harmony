"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import { logActivity } from "../actions";
import { MANUAL_ACTIVITY_TYPES, type FormResultState } from "../types";
import { CrmActionMessage } from "./crm-error";
import { Textarea } from "./textarea";

/** Log a call, WhatsApp, email, meeting or note on the customer's timeline. */
export function LogActivityForm({ customerId, maxLocal }: { customerId: string; maxLocal: string }) {
  const t = useTranslations("crm.activity");
  const tType = useTranslations("crm.activityType");
  const [state, formAction, pending] = useActionState<FormResultState, FormData>(logActivity, null);
  const uid = useId();
  const failed = state && !state.ok ? state : null;
  const invalid = new Set(failed?.invalidFields ?? []);
  const values = failed?.values ?? {};

  return (
    // React resets the form after each submit; after a failure, refill what was typed.
    <form key={JSON.stringify(state)} action={formAction} className="space-y-3">
      <input type="hidden" name="customer_id" value={customerId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${uid}-type`}>{t("type")}</Label>
          <Select id={`${uid}-type`} name="type" defaultValue={values.type ?? "call"} className="w-full">
            {MANUAL_ACTIVITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {tType(type)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${uid}-at`}>
            {t("occurredAt")} <span className="text-muted-foreground">({t("optionalNow")})</span>
          </Label>
          <Input
            id={`${uid}-at`}
            name="occurred_at"
            type="datetime-local"
            max={maxLocal}
            defaultValue={values.occurred_at ?? ""}
            dir="ltr"
            aria-invalid={invalid.has("occurred_at") || undefined}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${uid}-summary`}>{t("summary")}</Label>
        <Textarea
          id={`${uid}-summary`}
          name="summary"
          required
          minLength={2}
          maxLength={2000}
          defaultValue={values.summary ?? ""}
          placeholder={t("summaryPlaceholder")}
          aria-invalid={invalid.has("summary") || undefined}
        />
      </div>
      <Button type="submit" disabled={pending} className="w-full sm:w-auto">
        {t("submit")}
      </Button>
      <CrmActionMessage state={state} success={t("saved")} />
    </form>
  );
}
