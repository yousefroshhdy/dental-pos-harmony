"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Input } from "@/components/ui/primitives";
import { assignCustomerPriceList } from "../actions";
import { ActionForm, SubmitButton } from "./action-form";
import { Field } from "./fields";

/** Give a customer (by customer number, within the user's CRM scope) this customer price list. */
export function AssignCustomerForm({ priceListId, today }: { priceListId: string; today: string }) {
  const t = useTranslations("catalog.customers");
  const id = useId();

  return (
    <ActionForm action={assignCustomerPriceList} success={t("assigned")} resetOnSuccess className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end" aria-label={t("assignTitle")}>
      <input type="hidden" name="price_list_id" value={priceListId} />
      <Field id={`${id}-customer`} label={t("customerNo")} hint={t("customerNoHint")}>
        <Input id={`${id}-customer`} name="customer_no" required maxLength={40} dir="ltr" autoComplete="off" placeholder="CUS-0000-000000" aria-describedby={`${id}-customer-hint`} className="uppercase" />
      </Field>
      <Field id={`${id}-from`} label={t("validFrom")}>
        <Input id={`${id}-from`} name="valid_from" type="date" required defaultValue={today} dir="ltr" />
      </Field>
      <Field id={`${id}-to`} label={t("validTo")}>
        <Input id={`${id}-to`} name="valid_to" type="date" dir="ltr" />
      </Field>
      <SubmitButton>{t("assign")}</SubmitButton>
    </ActionForm>
  );
}
