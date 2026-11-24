import { useFormatter, useTranslations } from "next-intl";
import { Badge, Card, Table, Td, Th } from "@/components/ui/primitives";
import { PERCENT, QUANTITY } from "../format";
import { PRICES_INCLUDE_VAT, toNumber, vatGroups } from "../logic";

/**
 * Read-only pricing blocks shared by the order page and the builder's server
 * preview. Every amount comes from the database (api.v_order_lines /
 * api.preview_order); only the VAT-per-rate summary is grouped here, in cents.
 *
 * Works in server and client components (next-intl hooks are isomorphic).
 */

type Numeric = number | string;

export interface PricedLine {
  key: string;
  sku: string | null;
  name: string | null;
  quantity: number;
  is_bonus?: boolean;
  offer_code?: string | null;
  list_price: Numeric;
  applied_discount_pct: Numeric;
  line_subtotal: Numeric;
  line_discount: Numeric;
  invoice_discount_share?: Numeric;
  requested_net_price?: Numeric | null;
  tax_rate_pct: Numeric;
  line_tax: Numeric;
  line_total: Numeric;
  /** Extra cells (reserved / fulfilled) on the order page. */
  extra?: Numeric[];
}

/** Lines with list price, discount, net, VAT rate and amount, and a "Free / bonus" badge for free lines. */
export function PricedLinesTable({ lines, extraHeads = [] }: { lines: readonly PricedLine[]; extraHeads?: string[] }) {
  const t = useTranslations("orders.pricing");
  const format = useFormatter();
  const money = (v: Numeric | null | undefined) => format.number(toNumber(v), "egp");
  return (
    <Table>
      <thead>
        <tr>
          <Th>{t("product")}</Th>
          <Th className="text-end">{t("quantity")}</Th>
          <Th className="text-end">{t("unitPrice")}</Th>
          <Th className="text-end">{t("discount")}</Th>
          <Th className="text-end">{t("net")}</Th>
          <Th className="text-end">{t("vatRate")}</Th>
          <Th className="text-end">{t("vat")}</Th>
          <Th className="text-end">{t("lineTotal")}</Th>
          {extraHeads.map((h) => (
            <Th key={h} className="text-end">
              {h}
            </Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => {
          const pct = toNumber(l.applied_discount_pct);
          const net = toNumber(l.line_subtotal) - toNumber(l.line_discount);
          const share = toNumber(l.invoice_discount_share);
          return (
            <tr key={l.key}>
              <Td className="min-w-40">
                <span className="break-words">{l.name ?? "—"}</span>
                <span dir="ltr" className="block text-xs text-muted-foreground">
                  {l.sku}
                </span>
                <span className="mt-1 flex flex-wrap gap-1">
                  {l.is_bonus ? <Badge tone="success">{t("bonus")}</Badge> : null}
                  {l.offer_code ? (
                    <Badge tone="info">
                      {t("offer")} <span dir="ltr">{l.offer_code}</span>
                    </Badge>
                  ) : null}
                </span>
              </Td>
              <Td className="text-end">{format.number(l.quantity, QUANTITY)}</Td>
              <Td className="text-end whitespace-nowrap">{l.is_bonus ? t("free") : money(l.list_price)}</Td>
              <Td className="text-end whitespace-nowrap">
                {pct > 0 ? `${format.number(pct, PERCENT)}%` : "—"}
                {share > 0 ? <span className="block text-xs text-muted-foreground">{t("invoiceShare", { amount: money(share) })}</span> : null}
                {l.requested_net_price != null && toNumber(l.requested_net_price) > 0 ? (
                  <span className="block text-xs text-muted-foreground">{t("typedNet", { price: money(l.requested_net_price) })}</span>
                ) : null}
              </Td>
              <Td className="text-end whitespace-nowrap">{money(net)}</Td>
              <Td className="text-end whitespace-nowrap">{`${format.number(toNumber(l.tax_rate_pct), PERCENT)}%`}</Td>
              <Td className="text-end whitespace-nowrap">{money(l.line_tax)}</Td>
              <Td className="text-end whitespace-nowrap">{money(l.line_total)}</Td>
              {(l.extra ?? []).map((v, i) => (
                <Td key={i} className="text-end">
                  {format.number(toNumber(v), QUANTITY)}
                </Td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/** Totals with the VAT basis stated, VAT per rate, and the invoice discount when there is one. */
export function PricedTotals({
  subtotal,
  discountTotal,
  taxTotal,
  total,
  invoiceDiscount,
  lines,
  hint,
}: {
  subtotal: Numeric;
  discountTotal: Numeric;
  taxTotal: Numeric;
  total: Numeric;
  invoiceDiscount?: Numeric;
  lines: readonly Pick<PricedLine, "tax_rate_pct" | "line_subtotal" | "line_discount" | "line_tax" | "is_bonus">[];
  hint?: string;
}) {
  const t = useTranslations("orders.pricing");
  const format = useFormatter();
  const money = (v: Numeric | null | undefined) => format.number(toNumber(v), "egp");
  const groups = vatGroups(lines);
  return (
    <Card className="ms-auto max-w-sm space-y-1 text-sm">
      <p className="pb-1 text-xs font-medium">{PRICES_INCLUDE_VAT ? t("pricesIncludeVat") : t("pricesExcludeVat")}</p>
      <Row label={t("subtotal")} value={money(subtotal)} />
      <Row label={t("discountTotal")} value={money(discountTotal)} />
      {invoiceDiscount !== undefined && toNumber(invoiceDiscount) > 0 ? (
        <Row label={t("ofWhichInvoiceDiscount")} value={money(invoiceDiscount)} muted />
      ) : null}
      <Row label={t("net")} value={money(toNumber(subtotal) - toNumber(discountTotal))} />
      {groups.map((g) => (
        <Row
          key={g.rate}
          label={t("vatAtRate", { rate: format.number(g.rate, PERCENT), taxable: money(g.taxable) })}
          value={money(g.vat)}
          muted
        />
      ))}
      <Row label={t("vatTotal")} value={money(taxTotal)} />
      <Row label={t("total")} value={money(total)} strong />
      {hint ? <p className="pt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

function Row({ label, value, strong = false, muted = false }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div
      className={
        strong
          ? "flex justify-between gap-4 border-t pt-1 font-semibold"
          : muted
            ? "flex justify-between gap-4 text-xs text-muted-foreground"
            : "flex justify-between gap-4"
      }
    >
      <span>{label}</span>
      <span className="whitespace-nowrap">{value}</span>
    </div>
  );
}
