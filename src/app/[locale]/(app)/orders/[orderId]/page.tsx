import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Alert, Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { approveOrder, cancelOrder, fulfilOrder, rejectOrder, reserveOrder, submitOrder } from "@/modules/orders/actions";
import { CommandForm, FulfilForm, OnlineOnlyCommandForm, ReasonForm, ReserveForm } from "@/modules/orders/components/order-action-forms";
import { OrderError } from "@/modules/orders/components/order-error";
import { PricedLinesTable, PricedTotals } from "@/modules/orders/components/order-pricing";
import { CAIRO_DATE_TIME } from "@/modules/orders/format";
import {
  approvalReasons,
  availableActions,
  describeHistoryReason,
  localizedName,
  type HistoryReason,
  orderErrorCode,
  statusTone,
  toNumber,
  warehouseOptions,
} from "@/modules/orders/logic";
import { getOrder, listOrderHistory, listOrderLines, stockForVariants } from "@/modules/orders/queries";

type Params = Promise<{ locale: string; orderId: string }>;
type SearchParams = Promise<{ saved?: string; submitted?: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "orders.detail" });
  return { title: t("metaTitle") };
}

export default async function OrderDetailPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locale, orderId } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(orderId).success) notFound();

  const ctx = await getUserContext();
  if (!can(ctx, "sales.order.read")) return <Forbidden />;

  const [order, lines, history] = await Promise.all([getOrder(orderId), listOrderLines(orderId), listOrderHistory(orderId)]);
  if (!order.ok) return <OrderError code={orderErrorCode(order.error)} requestId={order.error.requestId} />;
  if (!order.data) notFound();
  if (!lines.ok) return <OrderError code={orderErrorCode(lines.error)} requestId={lines.error.requestId} />;

  const o = order.data;
  const t = await getTranslations("orders");
  const format = await getFormatter();
  const sp = await searchParams;
  const actions = availableActions(ctx, o, lines.data);
  const historyRows = history.ok ? history.data : [];
  const reasons = o.status === "pending_approval" ? approvalReasons(historyRows) : [];
  const isDraft = o.status === "draft";
  const showStock = lines.data.some((l) => l.reserved_qty > 0 || l.fulfilled_qty > 0);

  const warehouses = actions.reserve
    ? await stockForVariants([...new Set(lines.data.map((l) => l.variant_id))]).then((r) =>
        r.ok
          ? warehouseOptions(r.data, lines.data).map((w) => ({
              value: w.id,
              label: `${w.code} — ${w.name} · ${w.coversAll ? t("detail.coversAll") : t("detail.shortLines", { count: w.shortLines })}`,
            }))
          : [],
      )
    : [];

  const anyAction =
    actions.edit || actions.submit || actions.approve || actions.reject || actions.reserve || actions.fulfil || actions.cancel !== null;

  return (
    <div className="space-y-6 pb-6">
      <div className="space-y-2">
        <Link href="/orders" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("detail.back")}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">
            <span dir="ltr">{o.order_no ?? t("draftNo")}</span>
          </h1>
          <Badge tone={statusTone(o.status)}>{t(`status.${o.status}`)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{[o.customer_name, o.employee_name].filter(Boolean).join(" · ")}</p>
      </div>

      {/* Outcome of the last step, read back from the database (never from the URL). */}
      {sp.submitted && o.status === "submitted" ? (
        <Alert tone="success" role="status">
          {t("detail.submittedOk")}
        </Alert>
      ) : null}
      {sp.saved && isDraft ? (
        <Alert tone="info" role="status">
          {t("detail.savedOk")}
        </Alert>
      ) : null}
      {o.status === "pending_approval" ? (
        <Alert tone="info" role="status" className="space-y-2">
          <p className="font-medium">{t("detail.pendingTitle")}</p>
          {reasons.length > 0 ? (
            <ul className="list-disc ps-5">
              {reasons.map((r) => (
                <li key={r}>{t(`reasons.${r}`)}</li>
              ))}
            </ul>
          ) : (
            <p>{t("detail.pendingBody")}</p>
          )}
          {o.pending_approval_request_id ? (
            <Link href={`/approvals/${o.pending_approval_request_id}`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
              {t("detail.openApproval")}
            </Link>
          ) : null}
        </Alert>
      ) : null}
      {actions.cancelPending ? (
        <Alert tone="info" role="status" className="space-y-2">
          <p>{t("detail.cancelPending")}</p>
          {o.pending_approval_request_id ? (
            <Link href={`/approvals/${o.pending_approval_request_id}`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
              {t("detail.openApproval")}
            </Link>
          ) : null}
        </Alert>
      ) : null}

      <Card className="grid gap-3 text-sm sm:grid-cols-2">
        <Field label={t("detail.customer")} value={o.customer_name ?? "—"} />
        <Field label={t("detail.rep")} value={o.employee_name ?? "—"} />
        <Field label={t("detail.createdAt")} value={format.dateTime(new Date(o.created_at), CAIRO_DATE_TIME)} />
        <Field label={t("detail.submittedAt")} value={o.submitted_at ? format.dateTime(new Date(o.submitted_at), CAIRO_DATE_TIME) : "—"} />
        <Field label={t("detail.paymentTerms")} value={t("detail.days", { count: o.payment_terms_days })} />
        {o.notes ? <Field label={t("detail.notes")} value={o.notes} /> : null}
      </Card>

      <section className="space-y-3" aria-labelledby="order-lines">
        <CardTitle id="order-lines">{t("detail.lines")}</CardTitle>
        {lines.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("detail.noLines")}</p>
        ) : (
          <PricedLinesTable
            lines={lines.data.map((l) => ({
              key: l.order_item_id,
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
              extra: showStock ? [l.reserved_qty, l.fulfilled_qty] : undefined,
            }))}
            extraHeads={showStock ? [t("detail.reserved"), t("detail.fulfilled")] : []}
          />
        )}

        <PricedTotals
          subtotal={o.subtotal}
          discountTotal={o.discount_total}
          taxTotal={o.tax_total}
          total={o.total}
          invoiceDiscount={lines.data.reduce((sum, l) => sum + toNumber(l.invoice_discount_share), 0)}
          lines={lines.data}
          hint={isDraft ? t("detail.indicativeHint") : t("detail.serverPricedHint")}
        />
      </section>

      {["fulfilled", "partially_fulfilled", "invoiced"].includes(o.status) && can(ctx, "finance.invoice.issue") ? (
        <div>
          <Link href={`/finance/invoices/new?order=${o.id}`} className={buttonVariants({ variant: "outline" })}>
            {t("detail.issueInvoice")}
          </Link>
        </div>
      ) : null}
      {["partially_fulfilled", "fulfilled", "invoiced", "closed"].includes(o.status) && can(ctx, "sales.return.request") ? (
        <div>
          <Link href={`/returns/new?order=${o.id}`} className={buttonVariants({ variant: "outline" })}>
            {t("detail.requestReturn")}
          </Link>
        </div>
      ) : null}

      {anyAction ? (
        <Card className="space-y-4">
          <CardTitle>{t("detail.actions")}</CardTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            {actions.submit ? (
              <OnlineOnlyCommandForm
                action={submitOrder}
                orderId={o.id}
                locale={locale}
                label={t("actions.submit")}
                offlineHint={t("offline.submitOffline")}
              />
            ) : null}
            {actions.edit ? (
              <Link href={`/orders/${o.id}/edit`} className={buttonVariants({ variant: "outline" })}>
                {t("actions.edit")}
              </Link>
            ) : null}
            {actions.approve ? (
              <CommandForm action={approveOrder} orderId={o.id} locale={locale} label={t("actions.approve")} success={t("actions.approved")} />
            ) : null}
            {actions.reject ? (
              <ReasonForm
                action={rejectOrder}
                orderId={o.id}
                locale={locale}
                trigger={t("actions.reject")}
                confirm={t("actions.rejectConfirm")}
                reasonLabel={t("actions.reason")}
                reasonPlaceholder={t("actions.reasonPlaceholder")}
              />
            ) : null}
            {actions.reserve ? (
              <ReserveForm
                action={reserveOrder}
                orderId={o.id}
                locale={locale}
                warehouses={warehouses}
                label={t("actions.reserve")}
                warehouseLabel={t("actions.warehouse")}
                selectLabel={t("actions.selectWarehouse")}
                emptyLabel={t("actions.noStock")}
              />
            ) : null}
            {actions.fulfil ? <FulfilForm action={fulfilOrder} orderId={o.id} locale={locale} label={t("actions.fulfil")} /> : null}
            {actions.cancel ? (
              <ReasonForm
                action={cancelOrder}
                orderId={o.id}
                locale={locale}
                trigger={actions.cancel === "request" ? t("actions.requestCancel") : t("actions.cancel")}
                confirm={actions.cancel === "request" ? t("actions.requestCancelConfirm") : t("actions.cancelConfirm")}
                reasonLabel={t("actions.reason")}
                reasonPlaceholder={t("actions.reasonPlaceholder")}
                requestedSuccess={t("actions.cancelRequested")}
              />
            ) : null}
          </div>
        </Card>
      ) : null}

      <section className="space-y-3" aria-labelledby="order-history">
        <CardTitle id="order-history">{t("detail.history")}</CardTitle>
        {!history.ok ? (
          <OrderError code={orderErrorCode(history.error)} requestId={history.error.requestId} />
        ) : historyRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("detail.noHistory")}</p>
        ) : (
          <ol className="space-y-2">
            {historyRows.map((h) => (
              <li key={h.id} className="rounded-md border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={statusTone(h.to_status)}>{t(`status.${h.to_status}`)}</Badge>
                  <span className="text-xs text-muted-foreground">{format.dateTime(new Date(h.changed_at), CAIRO_DATE_TIME)}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {h.is_mine ? t("detail.byYou") : localizedName(locale, h.changed_by_name_en, h.changed_by_name_ar) || t("detail.bySystem")}
                </p>
                <HistoryReasonText reason={describeHistoryReason(h)} t={t} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function HistoryReasonText({ reason, t }: { reason: HistoryReason; t: (key: string) => string }) {
  let text: string;
  switch (reason.kind) {
    case "none":
      return null;
    case "draftCreated":
    case "accepted":
    case "approvalDecision":
      text = t(`historyReason.${reason.kind}`);
      break;
    case "approvalReasons":
      text = reason.reasons.map((r) => t(`reasons.${r}`)).join(" · ");
      break;
    default:
      text = reason.text;
  }
  return <p className="mt-1 break-words">{text}</p>;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="break-words">{value}</p>
    </div>
  );
}
