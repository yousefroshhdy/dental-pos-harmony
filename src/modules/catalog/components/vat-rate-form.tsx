"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Input } from "@/components/ui/primitives";
import { setProductVatRate } from "../actions";
import { ActionForm, SubmitButton } from "./action-form";

/**
 * The owner's VAT rate for one product (decision C; api.set_product_vat_rate,
 * owner only, audited). Show it to the owner only; the database refuses anyone else.
 */
export function VatRateForm({ productId, rate, label }: { productId: string; rate: number; label: string }) {
  const t = useTranslations("catalog.vat");
  const id = useId();
  return (
    <ActionForm action={setProductVatRate} success={t("saved")} className="flex flex-wrap items-end gap-2" messageClassName="w-full" aria-label={t("formLabel", { product: label })}>
      <input type="hidden" name="product_id" value={productId} />
      <div className="w-24 space-y-1">
        <label htmlFor={`${id}-rate`} className="text-xs font-medium">
          {t("rate")}
        </label>
        <Input id={`${id}-rate`} name="vat_rate_pct" defaultValue={String(rate)} inputMode="decimal" dir="ltr" required pattern="\d{1,3}(\.\d{1,2})?" />
      </div>
      <div className="min-w-40 flex-1 space-y-1">
        <label htmlFor={`${id}-reason`} className="text-xs font-medium">
          {t("reason")}
        </label>
        <Input id={`${id}-reason`} name="reason" maxLength={500} autoComplete="off" />
      </div>
      <SubmitButton variant="outline">{t("save")}</SubmitButton>
    </ActionForm>
  );
}
