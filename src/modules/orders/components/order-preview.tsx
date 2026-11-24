"use client";

import { useTranslations } from "next-intl";
import { Alert, Card, CardTitle } from "@/components/ui/primitives";
import type { OrderPreview } from "../types";
import { PricedLinesTable, PricedTotals } from "./order-pricing";

/** The server's pricing of the builder (api.preview_order): nothing here is computed on the device. */
export function OrderPreviewPanel({ preview }: { preview: OrderPreview }) {
  const t = useTranslations("orders.preview");
  const reasons = preview.approval?.reasons ?? [];
  return (
    <Card className="space-y-3" aria-live="polite">
      <CardTitle>{t("title")}</CardTitle>
      {preview.approval?.needed ? (
        <Alert tone="info" role="status" className="space-y-1">
          <p className="font-medium">{preview.approval.owner_required ? t("needsOwner") : t("needsApproval")}</p>
          <ul className="list-disc ps-5">
            {reasons.map((r) => (
              <li key={r}>{r.startsWith("free item") ? t("reasonFreeItem") : t("reasonDiscount")}</li>
            ))}
          </ul>
        </Alert>
      ) : (
        <p className="text-sm text-muted-foreground">{t("noApproval")}</p>
      )}
      <PricedLinesTable
        lines={preview.lines.map((l) => ({
          key: String(l.line_no),
          sku: l.sku,
          name: l.variant_name,
          quantity: l.quantity,
          is_bonus: l.is_bonus,
          offer_code: l.offer_code,
          list_price: l.list_price,
          applied_discount_pct: l.applied_discount_pct,
          line_subtotal: l.line_subtotal,
          line_discount: l.line_discount,
          invoice_discount_share: l.invoice_discount_share,
          requested_net_price: l.requested_net_price,
          tax_rate_pct: l.tax_rate_pct,
          line_tax: l.line_tax,
          line_total: l.line_total,
        }))}
      />
      <PricedTotals
        subtotal={preview.subtotal}
        discountTotal={preview.discount_total}
        taxTotal={preview.tax_total}
        total={preview.total}
        invoiceDiscount={preview.invoice_discount_total}
        lines={preview.lines}
        hint={t("hint")}
      />
    </Card>
  );
}
