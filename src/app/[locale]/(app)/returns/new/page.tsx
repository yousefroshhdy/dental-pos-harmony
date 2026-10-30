import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Alert, Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { BackLink, Field } from "@/modules/returns/components/bits";
import { RequestReturnForm } from "@/modules/returns/components/return-forms";
import { ReturnsError } from "@/modules/returns/components/returns-error";
import { CAIRO_DATE, CAIRO_DATE_TIME, dateOnly } from "@/modules/returns/format";
import { isUuid, orderAcceptsReturns, RETURN_PERMISSIONS, returnableRows, returnErrorCode, toNumber } from "@/modules/returns/logic";
import { getReturnOrder, listReturnableLines, listReturnableOrders, listReturns } from "@/modules/returns/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "returns.request" });
  return { title: t("title") };
}

export default async function NewReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ order?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, RETURN_PERMISSIONS.request)) return <Forbidden />;

  const raw = (await searchParams).order;
  const orderId = Array.isArray(raw) ? raw[0] : raw;
  const t = await getTranslations("returns");
  const format = await getFormatter();

  // Step 1: no order chosen yet → delivered orders the user can see.
  if (!isUuid(orderId)) {
    const orders = await listReturnableOrders();
    return (
      <div className="space-y-4">
        <BackLink href="/returns" label={t("request.back")} />
        <h1 className="text-2xl font-semibold">{t("request.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("request.pickOrder")}</p>
        {!orders.ok ? (
          <ReturnsError code={returnErrorCode(orders.error)} requestId={orders.error.requestId} />
        ) : orders.data.length === 0 ? (
          <Card className="text-sm text-muted-foreground">{t("request.noOrders")}</Card>
        ) : (
          <ul className="space-y-2">
            {orders.data.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/returns/new?order=${o.id}`}
                  className="flex min-h-11 flex-col gap-1 rounded-lg border bg-card p-3 hover:bg-muted sm:flex-row sm:items-center sm:gap-4"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span dir="ltr" className="font-medium">
                      {o.order_no ?? "—"}
                    </span>
                    <span className="truncate text-sm">{o.customer_name ?? "—"}</span>
                    <span className="text-xs text-muted-foreground">
                      {format.dateTime(new Date(o.submitted_at ?? o.created_at), CAIRO_DATE_TIME)}
                    </span>
                  </span>
                  <span className="text-sm font-semibold whitespace-nowrap sm:text-end">{format.number(toNumber(o.total), "egp")}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // Step 2: the order's returnable lines.
  const [order, lines, existing] = await Promise.all([getReturnOrder(orderId), listReturnableLines(orderId), listReturns("open", orderId)]);
  if (!order.ok) return <ReturnsError code={returnErrorCode(order.error)} requestId={order.error.requestId} />;
  if (!order.data) return <ReturnsError code="NOT_FOUND" />;
  if (!lines.ok) return <ReturnsError code={returnErrorCode(lines.error)} requestId={lines.error.requestId} />;

  const o = order.data;
  const rows = returnableRows(lines.data);
  const openReturns = existing.ok ? existing.data : [];
  const notInvoiced = lines.data.some((l) => l.delivered_qty > l.invoiced_qty);

  return (
    <div className="space-y-4 pb-6">
      <BackLink href={`/orders/${o.id}`} label={t("request.backToOrder")} />
      <h1 className="text-2xl font-semibold">{t("request.title")}</h1>

      <Card className="grid gap-3 text-sm sm:grid-cols-3">
        <Field label={t("detail.order")} value={<span dir="ltr">{o.order_no ?? "—"}</span>} />
        <Field label={t("detail.customer")} value={o.customer_name ?? "—"} />
        <Field label={t("detail.orderTotal")} value={format.number(toNumber(o.total), "egp")} />
      </Card>

      {openReturns.length > 0 ? (
        <Alert tone="info" role="status" className="space-y-1">
          <p>{t("request.openReturns")}</p>
          <ul className="flex flex-wrap gap-2">
            {openReturns.map((r) => (
              <li key={r.id}>
                <Link href={`/returns/${r.id}`} className="inline-flex min-h-11 items-center gap-2 text-primary underline-offset-4 hover:underline">
                  <span dir="ltr">{r.return_no}</span>
                  <Badge>{t(`status.${r.status}`)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {!orderAcceptsReturns(o.status) ? (
        <Alert tone="info">{t("request.orderNotReturnable")}</Alert>
      ) : rows.length === 0 ? (
        <Card className="text-sm text-muted-foreground">{t("request.nothingReturnable")}</Card>
      ) : (
        <section className="space-y-3" aria-labelledby="return-lines">
          <CardTitle id="return-lines">{t("request.lines")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("request.help")}</p>
          <RequestReturnForm
            orderId={o.id}
            locale={locale}
            rows={rows.map((r) => ({
              order_item_id: r.order_item_id,
              lot_id: r.lot_id,
              returnable_qty: r.returnable_qty,
              label: [r.sku, r.variant_name].filter(Boolean).join(" — ") || "—",
              lotLabel: r.expiry_date
                ? t("request.lotExpiry", { lot: r.lot_no ?? "—", date: format.dateTime(dateOnly(r.expiry_date), CAIRO_DATE) })
                : t("request.lot", { lot: r.lot_no ?? "—" }),
            }))}
          />
        </section>
      )}
      {notInvoiced ? <p className="text-xs text-muted-foreground">{t("request.invoicedOnly")}</p> : null}
    </div>
  );
}
