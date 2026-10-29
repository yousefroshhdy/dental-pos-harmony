"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { createOpportunity } from "../actions";
import type { CustomerFormState } from "../types";
import { CrmErrorMessage } from "./crm-error";

/**
 * New opportunity for one customer. It starts in "new" and the database adds a
 * follow-up task in three days. The expected value is the rep's estimate only.
 */
export function OpportunityForm({ customerId, locale, minDate }: { customerId: string; locale: "ar" | "en"; minDate: string }) {
  const t = useTranslations("crm.opportunityForm");
  const [state, formAction, pending] = useActionState<CustomerFormState, FormData>(createOpportunity, null);
  const values = state?.values ?? {};
  const invalid = new Set(state?.invalidFields ?? []);

  return (
    <form key={JSON.stringify(state)} action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="customer_id" value={customerId} />
      <input type="hidden" name="locale" value={locale} />
      {state ? <CrmErrorMessage failure={state} /> : null}

      <div className="space-y-2">
        <Label htmlFor="opp-title">{t("title")}</Label>
        <Input
          id="opp-title"
          name="title"
          required
          minLength={2}
          maxLength={200}
          defaultValue={values.title ?? ""}
          placeholder={t("titlePlaceholder")}
          autoComplete="off"
          aria-invalid={invalid.has("title") || undefined}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="opp-value">
            {t("expectedValue")} <span className="text-muted-foreground">({t("optional")})</span>
          </Label>
          <Input
            id="opp-value"
            name="expected_value"
            inputMode="decimal"
            dir="ltr"
            defaultValue={values.expected_value ?? ""}
            autoComplete="off"
            aria-describedby="opp-value-hint"
            aria-invalid={invalid.has("expected_value") || undefined}
          />
          <p id="opp-value-hint" className="text-xs text-muted-foreground">
            {t("expectedValueHint")}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="opp-close">
            {t("expectedCloseDate")} <span className="text-muted-foreground">({t("optional")})</span>
          </Label>
          <Input
            id="opp-close"
            name="expected_close_date"
            type="date"
            min={minDate}
            dir="ltr"
            defaultValue={values.expected_close_date ?? ""}
            aria-invalid={invalid.has("expected_close_date") || undefined}
          />
        </div>
      </div>
      <div className="sticky bottom-0 z-[1] -mx-4 flex gap-2 border-t bg-card/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0">
        <Button type="submit" disabled={pending} className="flex-1 sm:flex-none">
          {t("submit")}
        </Button>
        <Link href={`/customers/${customerId}`} className={buttonVariants({ variant: "outline" })}>
          {t("cancel")}
        </Link>
      </div>
    </form>
  );
}
