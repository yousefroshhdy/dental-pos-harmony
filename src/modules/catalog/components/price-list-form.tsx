"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import { Input, Select } from "@/components/ui/primitives";
import { savePriceList } from "../actions";
import type { PriceListRow } from "../types";
import { ActionForm, SubmitButton } from "./action-form";
import { CheckboxField, Field, FormActions } from "./fields";

/**
 * Create (redirects to the list) or edit a price list. The kind is fixed after
 * creation; the DEFAULT list stays standard, active and open-ended (DB rules).
 */
export function PriceListForm({ list, newId, today }: { list?: PriceListRow; newId?: string; today: string }) {
  const t = useTranslations("catalog.priceList");
  const locale = useLocale();
  const id = useId();
  const creating = !list;

  return (
    <ActionForm action={savePriceList} success={creating ? undefined : t("saved")} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label={creating ? t("newTitle") : t("editTitle")}>
      <input type="hidden" name="price_list_id" value={list?.id ?? newId} />
      <input type="hidden" name="mode" value={creating ? "create" : "update"} />
      <input type="hidden" name="locale" value={locale} />
      {list ? <input type="hidden" name="kind" value={list.kind} /> : null}

      <Field id={`${id}-code`} label={t("code")} hint={t("codeHint")}>
        <Input
          id={`${id}-code`}
          name="code"
          required
          pattern="[A-Za-z0-9][A-Za-z0-9._\-]{1,39}"
          maxLength={40}
          defaultValue={list?.code}
          readOnly={list?.is_default}
          dir="ltr"
          autoComplete="off"
          placeholder="TEST-VIP"
          aria-describedby={`${id}-code-hint`}
          className="uppercase"
        />
      </Field>
      <Field id={`${id}-name`} label={t("name")}>
        <Input id={`${id}-name`} name="name" required minLength={2} maxLength={120} defaultValue={list?.name} placeholder={t("namePlaceholder")} />
      </Field>
      <Field id={`${id}-kind`} label={t("kind")} hint={creating ? t("kindHint") : t("kindFixed")}>
        {creating ? (
          <Select id={`${id}-kind`} name="kind" defaultValue="standard" className="w-full" aria-describedby={`${id}-kind-hint`}>
            <option value="standard">{t("kinds.standard")}</option>
            <option value="customer">{t("kinds.customer")}</option>
            <option value="promotional">{t("kinds.promotional")}</option>
          </Select>
        ) : (
          <Input id={`${id}-kind`} value={t(`kinds.${list.kind}`)} readOnly aria-describedby={`${id}-kind-hint`} />
        )}
      </Field>
      <Field id={`${id}-priority`} label={t("priority")} hint={t("priorityHint")}>
        <Input
          id={`${id}-priority`}
          name="priority"
          type="number"
          inputMode="numeric"
          required
          min={1}
          max={1000}
          step={1}
          defaultValue={list?.priority ?? 100}
          dir="ltr"
          aria-describedby={`${id}-priority-hint`}
        />
      </Field>
      <Field id={`${id}-from`} label={t("validFrom")}>
        <Input id={`${id}-from`} name="valid_from" type="date" required defaultValue={list?.valid_from ?? today} dir="ltr" />
      </Field>
      <Field id={`${id}-to`} label={t("validTo")} hint={t("validToHint")}>
        <Input
          id={`${id}-to`}
          name="valid_to"
          type="date"
          defaultValue={list?.valid_to ?? ""}
          readOnly={list?.is_default}
          dir="ltr"
          aria-describedby={`${id}-to-hint`}
        />
      </Field>
      {list?.is_default ? (
        <>
          <input type="hidden" name="is_active" value="on" />
          <p className="text-sm text-muted-foreground sm:col-span-2 lg:col-span-3">{t("defaultNote")}</p>
        </>
      ) : (
        <CheckboxField id={`${id}-active`} name="is_active" label={t("active")} hint={t("activeHint")} defaultChecked={list?.is_active ?? true} />
      )}
      <FormActions className="sm:col-span-2 lg:col-span-3">
        <SubmitButton>{creating ? t("create") : t("save")}</SubmitButton>
      </FormActions>
    </ActionForm>
  );
}
