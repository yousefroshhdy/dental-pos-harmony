import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge, Card, Label, Select } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { FilterLinks } from "@/modules/finance/components/bits";
import { FinanceError } from "@/modules/finance/components/finance-error";
import { CAIRO_DATE, dateOnly } from "@/modules/finance/format";
import {
  financeErrorCode,
  INVOICE_FILTERS,
  invoiceStatusTone,
  parseBucket,
  parseInvoiceFilter,
  parseUuid,
  toNumber,
  withQuery,
  type InvoiceFilter,
} from "@/modules/finance/logic";
import { LIST_LIMIT, listCustomers, listInvoices } from "@/modules/finance/queries";
import { ExportCsvButton } from "@/modules/reports/components/export-csv-button";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.invoices" });
  return { title: t("title") };
}

const FILTERS = Object.keys(INVOICE_FILTERS) as InvoiceFilter[];
type SearchParams = Promise<{ status?: string | string[]; customer?: string | string[]; bucket?: string | string[] }>;

export default async function InvoicesPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: SearchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "finance.invoice.read")) return <Forbidden />;

  const sp = await searchParams;
  const bucket = parseBucket(sp.bucket);
  const filter = bucket ? "open" : parseInvoiceFilter(sp.status);
  const customerId = parseUuid(sp.customer);
  const t = await getTranslations("finance");
  const format = await getFormatter();
  const [invoices, customers] = await Promise.all([listInvoices({ filter, customerId, bucket }), listCustomers()]);
  const money = (v: number | string) => format.number(toNumber(v), "egp");
  const customerOptions = customers.ok ? customers.data : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">{t("invoices.title")}</h1>
        <div className="flex flex-wrap gap-2">
          <ExportCsvButton ctx={ctx} kind="invoices" filters={{ status: filter, bucket, customer: customerId }} label={t("invoices.export")} />
          {can(ctx, "finance.invoice.issue") ? (
            <Link href="/finance/invoices/new" className={buttonVariants()}>
              {t("invoices.toInvoice")}
            </Link>
          ) : null}
        </div>
      </div>

      <FilterLinks
        label={t("invoices.filterLabel")}
        items={FILTERS.map((f) => ({
          key: f,
          href: withQuery("/finance/invoices", { status: f === "open" ? null : f, customer: customerId }),
          text: t(`invoices.filters.${f}`),
          current: f === filter && !bucket,
        }))}
      />

      <form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-end">
        {filter !== "open" ? <input type="hidden" name="status" value={filter} /> : null}
        {bucket ? <input type="hidden" name="bucket" value={bucket} /> : null}
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="invoice-customer">{t("invoices.customer")}</Label>
          <Select id="invoice-customer" name="customer" defaultValue={customerId ?? ""} className="w-full">
            <option value="">{t("invoices.allCustomers")}</option>
            {customerOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name} ({c.customer_no})
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline">
          {t("invoices.apply")}
        </Button>
      </form>

      {bucket ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="info">{t(`aging.buckets.${bucket}`)}</Badge>
          <Link href={withQuery("/finance/invoices", { customer: customerId })} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
            {t("invoices.clearBucket")}
          </Link>
        </p>
      ) : null}

      {!invoices.ok ? (
        <FinanceError code={financeErrorCode(invoices.error)} requestId={invoices.error.requestId} />
      ) : invoices.data.length === 0 ? (
        <Card className="text-sm text-muted-foreground">{t("invoices.empty")}</Card>
      ) : (
        <>
          <ul className="space-y-2">
            {invoices.data.map((inv) => (
              <li key={inv.id}>
                <Link
                  href={`/finance/invoices/${inv.id}`}
                  className="flex min-h-11 flex-col gap-1 rounded-lg border bg-card p-3 hover:bg-muted sm:flex-row sm:items-center sm:gap-4"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span dir="ltr" className="font-medium">
                        {inv.invoice_no}
                      </span>
                      <Badge tone={invoiceStatusTone(inv.status, inv.is_overdue)}>
                        {inv.is_overdue ? t("invoices.overdueDays", { count: inv.days_overdue }) : t(`invoiceStatus.${inv.status}`)}
                      </Badge>
                    </span>
                    <span className="truncate text-sm">{inv.customer_name ?? "—"}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("invoices.due", { date: format.dateTime(dateOnly(inv.due_date), CAIRO_DATE) })}
                    </span>
                  </span>
                  <span className="flex flex-col text-sm whitespace-nowrap sm:text-end">
                    <span className="font-semibold">{money(inv.total)}</span>
                    {toNumber(inv.open_amount) > 0 ? (
                      <span className="text-xs text-muted-foreground">{t("invoices.openAmount", { amount: money(inv.open_amount) })}</span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {invoices.data.length >= LIST_LIMIT ? <p className="text-sm text-muted-foreground">{t("limited", { count: LIST_LIMIT })}</p> : null}
        </>
      )}
    </div>
  );
}
