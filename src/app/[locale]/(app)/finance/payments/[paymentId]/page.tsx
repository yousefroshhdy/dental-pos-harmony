import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Forbidden } from "@/components/forbidden";
import { PrinterIcon } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Alert, Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { hasReceipt } from "@/modules/finance/print";
import { BackLink, Field } from "@/modules/finance/components/bits";
import { FinanceError } from "@/modules/finance/components/finance-error";
import {
  AllocateForm,
  ConfirmPaymentForm,
  PaymentReasonForm,
  ReverseAllocationForm,
} from "@/modules/finance/components/payment-forms";
import { CAIRO_DATE, CAIRO_DATE_TIME, dateOnly } from "@/modules/finance/format";
import {
  allocationLimit,
  financeErrorCode,
  isUuid,
  localizedName,
  paymentActions,
  paymentStatusTone,
  receivedDaysBeforeRecording,
  toNumber,
} from "@/modules/finance/logic";
import { getPayment, listAllocationsForPayment, listOpenInvoices } from "@/modules/finance/queries";

type Params = Promise<{ locale: string; paymentId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.payment" });
  return { title: t("metaTitle") };
}

export default async function PaymentDetailPage({ params, searchParams }: { params: Params; searchParams: Promise<{ recorded?: string }> }) {
  const { locale, paymentId } = await params;
  setRequestLocale(locale);
  if (!isUuid(paymentId)) notFound();
  const ctx = await getUserContext();
  if (!can(ctx, "finance.payment.read") && !can(ctx, "finance.payment.record")) return <Forbidden />;

  const [payment, allocations] = await Promise.all([getPayment(paymentId), listAllocationsForPayment(paymentId)]);
  if (!payment.ok) return <FinanceError code={financeErrorCode(payment.error)} requestId={payment.error.requestId} />;
  if (!payment.data) notFound();

  const p = payment.data;
  const t = await getTranslations("finance");
  const format = await getFormatter();
  const money = (v: number | string | null) => format.number(toNumber(v), "egp");
  const actions = paymentActions(ctx, p);
  const recorded = Boolean((await searchParams).recorded);
  const open = actions.allocate ? await listOpenInvoices(p.customer_id) : null;
  const limit = allocationLimit(ctx);

  return (
    <div className="space-y-6 pb-6">
      <PageHeader
        eyebrow={<BackLink href="/finance/payments" label={t("payment.back")} />}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span dir="ltr">{p.payment_no}</span>
            <Badge tone={paymentStatusTone(p.status)} className="text-sm">
              {t(`paymentStatus.${p.status}`)}
            </Badge>
            <Badge className="text-sm">{t(`method.${p.method}`)}</Badge>
          </span>
        }
        description={p.customer_name ?? "—"}
        actions={
          hasReceipt(p) ? (
            <Link href={`/finance/payments/${p.id}/print`} className={buttonVariants({ variant: "outline" })}>
              <PrinterIcon aria-hidden="true" />
              {t("print.printReceipt")}
            </Link>
          ) : null
        }
      />

      {recorded ? (
        <Alert tone="success" role="status">
          {p.status === "pending_verification" ? t("payment.recordedPending") : t("payment.recordedConfirmed")}
        </Alert>
      ) : null}
      {p.status_reason ? <Alert tone="info">{t("payment.reason", { reason: p.status_reason })}</Alert> : null}

      <section aria-label={t("payment.summaryLabel")} className="grid grid-cols-3 gap-2">
        <Tile label={t("payment.amount")} value={money(p.amount)} strong />
        <Tile label={t("payment.allocated")} value={money(p.allocated)} />
        <Tile label={t("payment.unallocated")} value={money(p.unallocated)} warn={toNumber(p.unallocated) > 0} />
      </section>

      <Card className="grid gap-3 text-sm sm:grid-cols-3">
        <Field label={t("payment.method")} value={t(`method.${p.method}`)} />
        <Field label={t("payment.reference")} value={p.reference ?? "—"} dir="ltr" />
        {p.cheque_due_date ? <Field label={t("payment.chequeDueDate")} value={format.dateTime(dateOnly(p.cheque_due_date), CAIRO_DATE)} /> : null}
        <Field label={t("payment.receivedAt")} value={format.dateTime(new Date(p.received_at), CAIRO_DATE_TIME)} />
        <Field label={t("payment.collectedBy")} value={localizedName(locale, p.collected_by_name_en, p.collected_by_name_ar) || "—"} />
        {p.confirmed_at ? <Field label={t("payment.confirmedAt")} value={format.dateTime(new Date(p.confirmed_at), CAIRO_DATE_TIME)} /> : null}
      </Card>

      {actions.confirm || actions.reject || actions.reverse ? (
        <Card className="grid gap-3 sm:grid-cols-2" role="region" aria-label={t("payment.actions")}>
          <CardTitle className="text-base sm:col-span-2">{t("payment.actions")}</CardTitle>
          {actions.confirm ? (
            <ConfirmPaymentForm
              paymentId={p.id}
              locale={locale}
              receivedLabel={format.dateTime(new Date(p.received_at), CAIRO_DATE_TIME)}
              daysBeforeRecording={receivedDaysBeforeRecording(p.received_at, p.created_at)}
            />
          ) : null}
          {actions.reject ? <PaymentReasonForm paymentId={p.id} locale={locale} kind="reject" /> : null}
          {actions.reverse ? <PaymentReasonForm paymentId={p.id} locale={locale} kind="reverse" /> : null}
        </Card>
      ) : null}

      {actions.allocate && open ? (
        <section className="space-y-3" aria-labelledby="allocate">
          <CardTitle id="allocate">{t("allocate.title")}</CardTitle>
          {!open.ok ? (
            <FinanceError code={financeErrorCode(open.error)} requestId={open.error.requestId} />
          ) : (
            <AllocateForm
              paymentId={p.id}
              locale={locale}
              unallocated={toNumber(p.unallocated)}
              limit={limit ?? null}
              invoices={open.data.map((i) => ({
                id: i.id,
                invoice_no: i.invoice_no,
                due_date: i.due_date,
                issue_date: i.issue_date,
                open_amount: i.open_amount,
                label: `${i.invoice_no} · ${format.dateTime(dateOnly(i.due_date), CAIRO_DATE)}`,
                openLabel: money(i.open_amount),
              }))}
            />
          )}
        </section>
      ) : null}

      <section className="space-y-3" aria-labelledby="allocations">
        <CardTitle id="allocations">{t("payment.allocations")}</CardTitle>
        {!allocations.ok ? (
          <FinanceError code={financeErrorCode(allocations.error)} requestId={allocations.error.requestId} />
        ) : allocations.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("payment.noAllocations")}</p>
        ) : (
          <ul className="space-y-2">
            {allocations.data.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <Link href={`/finance/invoices/${a.invoice_id}`} className="min-h-11 content-center text-primary underline-offset-4 hover:underline" dir="ltr">
                  {a.invoice_no ?? t("payment.invoice")}
                </Link>
                <span className="text-muted-foreground">{format.dateTime(new Date(a.allocated_at), CAIRO_DATE_TIME)}</span>
                <span className={toNumber(a.amount) < 0 ? "font-medium text-destructive" : "font-medium"}>
                  {money(a.amount)}
                  {a.is_reversed ? <span className="ms-1 text-xs text-muted-foreground">({t("invoice.reversed")})</span> : null}
                </span>
                {toNumber(a.amount) > 0 && !a.is_reversed && can(ctx, "finance.payment.reverse") ? (
                  <ReverseAllocationForm allocationId={a.id} paymentId={p.id} locale={locale} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, strong = false, warn = false }: { label: string; value: string; strong?: boolean; warn?: boolean }) {
  return (
    <div className={cn("min-w-0 rounded-lg border bg-card p-3", warn && "border-warning/60 bg-warning/10")}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className={cn("truncate tabular-nums", strong ? "text-lg font-semibold" : "font-medium")}>{value}</div>
    </div>
  );
}
