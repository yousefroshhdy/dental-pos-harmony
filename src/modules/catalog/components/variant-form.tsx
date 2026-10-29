"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Input } from "@/components/ui/primitives";
import { saveVariant } from "../actions";
import { formatAttributes } from "../logic";
import type { VariantRow } from "../types";
import { ActionForm, SubmitButton } from "./action-form";
import { Field, Textarea } from "./fields";

/** Add a variant (SKU) to a product, or edit one. The SKU is frozen by the DB once stock or orders exist. */
export function VariantForm({ productId, variant, newId }: { productId: string; variant?: VariantRow; newId?: string }) {
  const t = useTranslations("catalog.variant");
  const id = useId();
  const creating = !variant;

  return (
    <ActionForm
      action={saveVariant}
      success={creating ? t("added") : t("saved")}
      newIdField={creating ? "variant_id" : undefined}
      initialId={newId}
      resetOnSuccess={creating}
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      aria-label={creating ? t("addTitle") : t("editTitle", { sku: variant.sku })}
    >
      {variant ? <input type="hidden" name="variant_id" value={variant.id} /> : null}
      <input type="hidden" name="product_id" value={productId} />
      <Field id={`${id}-sku`} label={t("sku")} hint={creating ? t("skuHint") : t("skuFrozenHint")}>
        <Input
          id={`${id}-sku`}
          name="sku"
          required
          pattern="[A-Za-z0-9][A-Za-z0-9._\/\-]{1,63}"
          maxLength={64}
          defaultValue={variant?.sku}
          dir="ltr"
          autoComplete="off"
          placeholder="TEST-IMPL-001-3510"
          aria-describedby={`${id}-sku-hint`}
          className="uppercase"
        />
      </Field>
      <Field id={`${id}-name`} label={t("name")}>
        <Input id={`${id}-name`} name="name_en" required maxLength={160} defaultValue={variant?.name_en} dir="ltr" placeholder={t("namePlaceholder")} />
      </Field>
      <Field id={`${id}-barcode`} label={t("barcode")}>
        <Input id={`${id}-barcode`} name="barcode" pattern="[0-9A-Za-z\-]{4,64}" maxLength={64} defaultValue={variant?.barcode ?? ""} dir="ltr" autoComplete="off" />
      </Field>
      <Field id={`${id}-uom`} label={t("uom")}>
        <Input id={`${id}-uom`} name="uom" pattern="[a-z][a-z_]{0,19}" maxLength={20} defaultValue={variant?.uom ?? "unit"} dir="ltr" autoComplete="off" />
      </Field>
      <Field id={`${id}-reorder`} label={t("reorderPoint")} hint={t("reorderPointHint")}>
        <Input
          id={`${id}-reorder`}
          name="reorder_point"
          type="number"
          inputMode="numeric"
          min={0}
          max={1000000}
          step={1}
          defaultValue={variant?.reorder_point ?? 0}
          dir="ltr"
          aria-describedby={`${id}-reorder-hint`}
        />
      </Field>
      <Field id={`${id}-attributes`} label={t("attributes")} hint={t("attributesHint")} className="sm:col-span-2 lg:col-span-3">
        <Textarea
          id={`${id}-attributes`}
          name="attributes"
          rows={3}
          maxLength={6000}
          defaultValue={formatAttributes(variant?.attributes)}
          dir="ltr"
          placeholder={"diameter_mm=3.5\nlength_mm=10"}
          aria-describedby={`${id}-attributes-hint`}
        />
      </Field>
      <div className="sm:col-span-2 lg:col-span-3">
        <SubmitButton variant={creating ? "default" : "outline"}>{creating ? t("add") : t("save")}</SubmitButton>
      </div>
    </ActionForm>
  );
}
