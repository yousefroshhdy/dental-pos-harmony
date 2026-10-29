"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import { Input, Select } from "@/components/ui/primitives";
import { createPromotion } from "../actions";
import { localizedName } from "../logic";
import type { BrandRow, CategoryRow } from "../types";
import { ActionForm, SubmitButton } from "./action-form";
import { Field, FormActions } from "./fields";

/**
 * New promotion (an automatic % discount). Leave every target empty for all products
 * and customers. Promotions are never edited: end one and create another.
 */
export function PromotionForm({
  newId,
  today,
  brands,
  categories,
  skus,
}: {
  newId: string;
  today: string;
  brands: BrandRow[];
  categories: CategoryRow[];
  skus: { sku: string; name_en: string }[];
}) {
  const t = useTranslations("catalog.promotions");
  const locale = useLocale();
  const id = useId();

  return (
    <ActionForm
      action={createPromotion}
      success={t("created")}
      newIdField="promotion_id"
      initialId={newId}
      resetOnSuccess
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      aria-label={t("newTitle")}
    >
      <Field id={`${id}-name`} label={t("name")} className="sm:col-span-2 lg:col-span-1">
        <Input id={`${id}-name`} name="name" required minLength={2} maxLength={120} placeholder={t("namePlaceholder")} />
      </Field>
      <Field id={`${id}-pct`} label={t("discountPct")} hint={t("discountPctHint")}>
        <Input
          id={`${id}-pct`}
          name="discount_pct"
          required
          inputMode="decimal"
          pattern="[0-9]{1,3}([.][0-9]{1,2})?"
          dir="ltr"
          placeholder="5"
          autoComplete="off"
          aria-describedby={`${id}-pct-hint`}
        />
      </Field>
      <Field id={`${id}-minqty`} label={t("minQty")}>
        <Input id={`${id}-minqty`} name="min_qty" type="number" inputMode="numeric" min={1} max={100000} step={1} defaultValue={1} dir="ltr" />
      </Field>
      <Field id={`${id}-from`} label={t("validFrom")}>
        <Input id={`${id}-from`} name="valid_from" type="date" required defaultValue={today} dir="ltr" />
      </Field>
      <Field id={`${id}-to`} label={t("validTo")} hint={t("validToHint")}>
        <Input id={`${id}-to`} name="valid_to" type="date" min={today} dir="ltr" aria-describedby={`${id}-to-hint`} />
      </Field>
      <Field id={`${id}-priority`} label={t("priority")}>
        <Input id={`${id}-priority`} name="priority" type="number" inputMode="numeric" min={1} max={1000} step={1} defaultValue={100} dir="ltr" />
      </Field>

      <fieldset className="grid gap-4 sm:col-span-2 sm:grid-cols-2 lg:col-span-3 lg:grid-cols-4">
        <legend className="mb-2 text-sm font-medium">{t("targets")}</legend>
        <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">{t("targetsHint")}</p>
        <Field id={`${id}-brand`} label={t("brand")}>
          <Select id={`${id}-brand`} name="brand_id" defaultValue="" className="w-full">
            <option value="">{t("any")}</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`${id}-category`} label={t("category")}>
          <Select id={`${id}-category`} name="category_id" defaultValue="" className="w-full">
            <option value="">{t("any")}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {localizedName(locale, c.name_en, c.name_ar)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`${id}-sku`} label={t("sku")}>
          <Input id={`${id}-sku`} name="sku" list={`${id}-skus`} maxLength={64} dir="ltr" autoComplete="off" placeholder={t("any")} className="uppercase" />
          <datalist id={`${id}-skus`}>
            {skus.map((s) => (
              <option key={s.sku} value={s.sku}>
                {s.name_en}
              </option>
            ))}
          </datalist>
        </Field>
        <Field id={`${id}-customer`} label={t("customerNo")}>
          <Input id={`${id}-customer`} name="customer_no" maxLength={40} dir="ltr" autoComplete="off" placeholder={t("any")} className="uppercase" />
        </Field>
      </fieldset>

      <FormActions className="sm:col-span-2 lg:col-span-3">
        <SubmitButton>{t("create")}</SubmitButton>
      </FormActions>
    </ActionForm>
  );
}
