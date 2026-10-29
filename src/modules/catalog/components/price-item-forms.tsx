"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Input, Label } from "@/components/ui/primitives";
import { setPriceItem } from "../actions";
import { ActionForm, SubmitButton } from "./action-form";
import { Field } from "./fields";

const PRICE_PATTERN = "[0-9]{1,12}([.][0-9]{1,2})?";

/** Add a price for a SKU (picked from the sellable SKUs) at a quantity tier. */
export function AddPriceItemForm({ priceListId, skus }: { priceListId: string; skus: { sku: string; name_en: string }[] }) {
  const t = useTranslations("catalog.items");
  const id = useId();

  return (
    <ActionForm action={setPriceItem} success={t("added")} resetOnSuccess className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end" aria-label={t("addTitle")}>
      <input type="hidden" name="price_list_id" value={priceListId} />
      <Field id={`${id}-sku`} label={t("sku")}>
        <Input id={`${id}-sku`} name="sku" required list={`${id}-skus`} maxLength={64} dir="ltr" autoComplete="off" className="uppercase" />
        <datalist id={`${id}-skus`}>
          {skus.map((s) => (
            <option key={s.sku} value={s.sku}>
              {s.name_en}
            </option>
          ))}
        </datalist>
      </Field>
      <Field id={`${id}-price`} label={t("unitPrice")}>
        <Input id={`${id}-price`} name="unit_price" required inputMode="decimal" pattern={PRICE_PATTERN} dir="ltr" placeholder="0.00" autoComplete="off" />
      </Field>
      <Field id={`${id}-qty`} label={t("minQty")}>
        <Input id={`${id}-qty`} name="min_qty" type="number" inputMode="numeric" min={1} max={100000} step={1} defaultValue={1} dir="ltr" />
      </Field>
      <SubmitButton>{t("add")}</SubmitButton>
    </ActionForm>
  );
}

/** Change one existing price (the new price applies to orders saved or submitted from now on). */
export function EditPriceItemForm({
  priceListId,
  variantId,
  minQty,
  unitPrice,
  sku,
}: {
  priceListId: string;
  variantId: string;
  minQty: number;
  unitPrice: string;
  sku: string;
}) {
  const t = useTranslations("catalog.items");
  const id = useId();

  return (
    <ActionForm action={setPriceItem} success={t("saved")} className="flex flex-wrap items-center gap-2" messageClassName="basis-full" aria-label={t("editTitle", { sku, qty: minQty })}>
      <input type="hidden" name="price_list_id" value={priceListId} />
      <input type="hidden" name="variant_id" value={variantId} />
      <input type="hidden" name="min_qty" value={String(minQty)} />
      <Label htmlFor={`${id}-price`} className="sr-only">
        {t("unitPriceFor", { sku, qty: minQty })}
      </Label>
      <Input id={`${id}-price`} name="unit_price" required inputMode="decimal" pattern={PRICE_PATTERN} defaultValue={unitPrice} dir="ltr" className="w-32" autoComplete="off" />
      <SubmitButton variant="outline">{t("save")}</SubmitButton>
    </ActionForm>
  );
}
