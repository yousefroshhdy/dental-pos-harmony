import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { FilterLinks } from "@/modules/finance/components/bits";
import { FinanceError } from "@/modules/finance/components/finance-error";
import { CAIRO_DATE_TIME } from "@/modules/finance/format";
import {
  financeErrorCode,
  localizedName,
  PAYMENT_FILTERS,
  parsePaymentFilter,
  parseUuid,
  paymentStatusTone,
  toNumber,
  withQuery,
  type PaymentFilter,
} from "@/modules/finance/logic";
import { LIST_LIMIT, listPayments } from "@/modules/finance/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.payments" });
  return { title: t("title") };
}

const FILTERS = Object.keys(PAYMENT_FILTERS) as PaymentFilter[];

export default async function PaymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string | string[]; customer?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "finance.payment.read")) return <Forbidden />;

  const sp = await searchParams;
  // Finance lands on the verification queue; everyone else on all their payments.
  const filter = parsePaymentFilter(sp.status, can(ctx, "finance.payment.confirm") ? "pending" : "all");
  const customerId = parseUuid(sp.customer);
  const t = await getTranslations("finance");
  const format = await getFormatter();
  const payments = await listPayments(filter, customerId);
  const money = (v: number | string) => format.number(toNumber(v), "egp");

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">{t("payments.title")}</h1>
        {can(ctx, "finance.payment.record") ? (
          <Link href={withQuery("/finance/payments/new", { customer: customerId })} className={buttonVariants()}>
            {t("payments.record")}
          </Link>
        ) : null}
      </div>

      <FilterLinks
        label={t("payments.filterLabel")}
        items={FILTERS.map((f) => ({
          key: f,
          href: withQuery("/finance/payments", { status: f, customer: customerId }),
          text: t(`payments.filters.${f}`),
          current: f === filter,
        }))}
      />

      {!payments.ok ? (
        <FinanceError code={financeErrorCode(payments.error)} requestId={payments.error.requestId} />
      ) : payments.data.length === 0 ? (
        <Card className="text-sm text-muted-foreground">{t("payments.empty")}</Card>
      ) : (
        <>
          <ul className="space-y-2">
            {payments.data.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/finance/payments/${p.id}`}
                  className="flex min-h-11 flex-col gap-1 rounded-lg border bg-card p-3 hover:bg-muted sm:flex-row sm:items-center sm:gap-4"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span dir="ltr" className="font-medium">
                        {p.payment_no}
                      </span>
                      <Badge tone={paymentStatusTone(p.status)}>{t(`paymentStatus.${p.status}`)}</Badge>
                      <Badge>{t(`method.${p.method}`)}</Badge>
                    </span>
                    <span className="truncate text-sm">{p.customer_name ?? "—"}</span>
                    <span className="text-xs text-muted-foreground">
                      {[localizedName(locale, p.collected_by_name_en, p.collected_by_name_ar), format.dateTime(new Date(p.received_at), CAIRO_DATE_TIME)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="flex flex-col text-sm whitespace-nowrap sm:text-end">
                    <span className="font-semibold">{money(p.amount)}</span>
                    {toNumber(p.unallocated) > 0 ? (
                      <span className="text-xs text-muted-foreground">{t("payments.unallocated", { amount: money(p.unallocated) })}</span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {payments.data.length >= LIST_LIMIT ? <p className="text-sm text-muted-foreground">{t("limited", { count: LIST_LIMIT })}</p> : null}
        </>
      )}
    </div>
  );
}
