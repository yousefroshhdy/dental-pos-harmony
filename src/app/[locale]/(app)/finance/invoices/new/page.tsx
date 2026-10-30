import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Alert, Badge, Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { BackLink, Field } from "@/modules/finance/components/bits";
import { FinanceError } from "@/modules/finance/components/finance-error";
import { IssueInvoiceForm } from "@/modules/finance/components/invoice-forms";
import { CAIRO_DATE, dateOnly, PERCENT, QUANTITY } from "@/modules/finance/format";
import { financeErrorCode, localizedName, parseUuid, toNumber } from "@/modules/finance/logic";
import { getInvoiceableOrder, listInvoiceableLines, listInvoiceableOrders, listInvoicesForOrder } from "@/modules/finance/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.issue" });
  return { title: t("title") };
}

/**
 * Issue an invoice from a fulfilled order (?order=<id>), or pick one from the queue of
 * orders with fulfilled, not yet invoiced quantity. Amounts are computed by api.issue_invoice.
 */
export default async function IssueInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ order?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "finance.invoice.issue")) return <Forbidden />;

  const t = await getTranslations("finance");
  const format = await getFormatter();
  const money = (v: number | string) => format.number(toNumber(v), "egp");
  const orderId = parseUuid((await searchParams).order);

  if (!orderId) {
    const queue = await listInvoiceableOrders();
    return (
      <div className="space-y-4">
        <BackLink href="/finance/invoices" label={t("issue.back")} />
        <h1 className="text-2xl font-semibold">{t("issue.queueTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("issue.queueHelp")}</p>
        {!queue.ok ? (
          <FinanceError code={financeErrorCode(queue.error)} requestId={queue.error.requestId} />
        ) : queue.data.length === 0 ? (
          <Card className="text-sm text-muted-foreground">{t("issue.queueEmpty")}</Card>
        ) : (
          <ul className="space-y-2">
            {queue.data.map((o) => (
              <li key={o.order_id}>
                <Link
                  href={`/finance/invoices/new?order=${o.order_id}`}
                  className="flex min-h-11 flex-col gap-1 rounded-lg border bg-card p-3 hover:bg-muted sm:flex-row sm:items-center sm:gap-4"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span dir="ltr" className="font-medium">
                        {o.order_no ?? "—"}
                      </span>
                      <Badge tone={o.status === "fulfilled" ? "success" : "warning"}>{t(`issue.orderStatus.${o.status}`)}</Badge>
                    </span>
                    <span className="truncate text-sm">{o.customer_name ?? "—"}</span>
                    <span className="text-xs text-muted-foreground">
                      {[localizedName(locale, o.employee_name_en, o.employee_name_ar), t("issue.uninvoiced", { count: o.uninvoiced_qty })]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="text-sm font-semibold whitespace-nowrap sm:text-end">{money(o.order_total)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const [order, lines, issued] = await Promise.all([getInvoiceableOrder(orderId), listInvoiceableLines(orderId), listInvoicesForOrder(orderId)]);
  if (!order.ok) return <FinanceError code={financeErrorCode(order.error)} requestId={order.error.requestId} />;
  if (!lines.ok) return <FinanceError code={financeErrorCode(lines.error)} requestId={lines.error.requestId} />;
  const previous = issued.ok ? issued.data : [];

  return (
    <div className="space-y-6 pb-6">
      <BackLink href="/finance/invoices/new" label={t("issue.backToQueue")} />
      <h1 className="text-2xl font-semibold">{t("issue.title")}</h1>

      {!order.data ? (
        <Alert tone="info" className="space-y-2">
          <p>{t("issue.nothingToInvoice")}</p>
          <Link href={`/orders/${orderId}`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
            {t("issue.openOrder")}
          </Link>
        </Alert>
      ) : (
        <>
          <Card className="grid gap-3 text-sm sm:grid-cols-2">
            <Field label={t("issue.order")} value={order.data.order_no ?? "—"} dir="ltr" />
            <Field label={t("issue.customer")} value={order.data.customer_name ?? "—"} />
            <Field label={t("issue.rep")} value={localizedName(locale, order.data.employee_name_en, order.data.employee_name_ar) || "—"} />
            <Field label={t("issue.terms")} value={t("issue.days", { count: order.data.payment_terms_days })} />
          </Card>

          <section className="space-y-3" aria-labelledby="invoice-preview">
            <CardTitle id="invoice-preview">{t("issue.linesTitle")}</CardTitle>
            <Table>
              <thead>
                <tr>
                  <Th>{t("lines.sku")}</Th>
                  <Th className="text-end">{t("issue.fulfilled")}</Th>
                  <Th className="text-end">{t("issue.alreadyInvoiced")}</Th>
                  <Th className="text-end">{t("issue.toInvoice")}</Th>
                  <Th className="text-end">{t("lines.unitPrice")}</Th>
                  <Th className="text-end">{t("lines.discountPct")}</Th>
                  <Th className="text-end">{t("lines.vatPct")}</Th>
                </tr>
              </thead>
              <tbody>
                {lines.data.map((l) => (
                  <tr key={l.order_item_id}>
                    <Td>
                      <span dir="ltr" className="font-medium">
                        {l.sku ?? "—"}
                      </span>
                      <span className="block text-xs text-muted-foreground">{l.variant_name}</span>
                    </Td>
                    <Td className="text-end">{format.number(l.fulfilled_qty, QUANTITY)}</Td>
                    <Td className="text-end">{format.number(l.invoiced_qty, QUANTITY)}</Td>
                    <Td className="text-end font-semibold">{format.number(l.uninvoiced_qty, QUANTITY)}</Td>
                    <Td className="text-end whitespace-nowrap">{money(l.list_price)}</Td>
                    <Td className="text-end">{format.number(toNumber(l.applied_discount_pct), PERCENT)}%</Td>
                    <Td className="text-end">{format.number(toNumber(l.tax_rate_pct), PERCENT)}%</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="text-sm text-muted-foreground">{t("issue.serverComputes")}</p>
          </section>

          <div className="sticky bottom-0 z-10 -mx-4 border-t bg-card p-3 sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
            <IssueInvoiceForm orderId={orderId} locale={locale} />
          </div>
        </>
      )}

      {previous.length > 0 ? (
        <section className="space-y-2" aria-labelledby="previous-invoices">
          <CardTitle id="previous-invoices">{t("issue.previous")}</CardTitle>
          <ul className="space-y-2">
            {previous.map((inv) => (
              <li key={inv.id}>
                <Link href={`/finance/invoices/${inv.id}`} className="flex min-h-11 items-center justify-between gap-2 rounded-lg border bg-card p-3 hover:bg-muted">
                  <span dir="ltr" className="font-medium">
                    {inv.invoice_no}
                  </span>
                  <span className="text-sm text-muted-foreground">{format.dateTime(dateOnly(inv.issue_date), CAIRO_DATE)}</span>
                  <span className="text-sm font-semibold">{money(inv.total)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
