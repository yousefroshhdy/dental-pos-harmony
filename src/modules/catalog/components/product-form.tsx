"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import { Input, Select } from "@/components/ui/primitives";
import { saveProduct } from "../actions";
import { localizedName } from "../logic";
import type { BrandRow, CategoryRow, ProductRow } from "../types";
import { ActionForm, SubmitButton } from "./action-form";
import { CheckboxField, Field, FormActions, Textarea } from "./fields";

/**
 * Create (redirects to the new product) or edit a product's master data.
 * Status and VAT are not edited here: status has its own buttons, VAT follows D-12.
 */
export function ProductForm({
  product,
  newId,
  brands,
  categories,
}: {
  product?: ProductRow;
  /** Client-generated id for a new product (idempotent create). */
  newId?: string;
  brands: BrandRow[];
  categories: CategoryRow[];
}) {
  const t = useTranslations("catalog.product");
  const locale = useLocale();
  const id = useId();
  const creating = !product;

  return (
    <ActionForm action={saveProduct} success={creating ? undefined : t("saved")} className="grid gap-4 sm:grid-cols-2" aria-label={creating ? t("newTitle") : t("editTitle")}>
      <input type="hidden" name="product_id" value={product?.id ?? newId} />
      <input type="hidden" name="mode" value={creating ? "create" : "update"} />
      <input type="hidden" name="locale" value={locale} />

      <Field id={`${id}-code`} label={t("code")} hint={t("codeHint")}>
        <Input
          id={`${id}-code`}
          name="code"
          required
          pattern="[A-Za-z0-9][A-Za-z0-9._\-]{1,39}"
          maxLength={40}
          defaultValue={product?.code}
          dir="ltr"
          autoComplete="off"
          placeholder="TEST-IMPL-001"
          aria-describedby={`${id}-code-hint`}
          className="uppercase"
        />
      </Field>
      <Field id={`${id}-brand`} label={t("brand")}>
        <Select id={`${id}-brand`} name="brand_id" required defaultValue={product?.brand_id ?? ""} className="w-full">
          <option value="" disabled>
            {t("choose")}
          </option>
          {brands
            .filter((b) => b.is_active || b.id === product?.brand_id)
            .map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
        </Select>
      </Field>
      <Field id={`${id}-name-en`} label={t("nameEn")}>
        <Input id={`${id}-name-en`} name="name_en" required minLength={2} maxLength={160} defaultValue={product?.name_en} dir="ltr" placeholder={t("namePlaceholder")} />
      </Field>
      <Field id={`${id}-name-ar`} label={t("nameAr")}>
        <Input id={`${id}-name-ar`} name="name_ar" maxLength={160} defaultValue={product?.name_ar ?? ""} dir="rtl" />
      </Field>
      <Field id={`${id}-category`} label={t("category")}>
        <Select id={`${id}-category`} name="category_id" required defaultValue={product?.category_id ?? ""} className="w-full">
          <option value="" disabled>
            {t("choose")}
          </option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {localizedName(locale, c.name_en, c.name_ar)}
            </option>
          ))}
        </Select>
      </Field>
      {creating ? (
        <Field id={`${id}-status`} label={t("initialStatus")}>
          <Select id={`${id}-status`} name="status" defaultValue="active" className="w-full">
            <option value="active">{t("status.active")}</option>
            <option value="draft">{t("status.draft")}</option>
          </Select>
        </Field>
      ) : null}
      <Field id={`${id}-description`} label={t("description")} className="sm:col-span-2">
        <Textarea id={`${id}-description`} name="description" maxLength={2000} defaultValue={product?.description ?? ""} rows={3} />
      </Field>
      <fieldset className="space-y-1 sm:col-span-2">
        <legend className="mb-1 text-sm font-medium">{t("tracking")}</legend>
        <CheckboxField id={`${id}-lot`} name="is_lot_tracked" label={t("lotTracked")} hint={t("lotTrackedHint")} defaultChecked={product?.is_lot_tracked ?? true} />
        <CheckboxField id={`${id}-expiry`} name="is_expiry_tracked" label={t("expiryTracked")} defaultChecked={product?.is_expiry_tracked ?? false} />
        <CheckboxField id={`${id}-serial`} name="is_serial_tracked" label={t("serialTracked")} defaultChecked={product?.is_serial_tracked ?? false} />
      </fieldset>
      <p className="text-xs text-muted-foreground sm:col-span-2">{creating ? t("vatNoteNew") : t("vatNote", { rate: Number(product?.tax_rate_pct ?? 0) })}</p>
      <FormActions className="sm:col-span-2">
        <SubmitButton>{creating ? t("create") : t("save")}</SubmitButton>
      </FormActions>
    </ActionForm>
  );
}
