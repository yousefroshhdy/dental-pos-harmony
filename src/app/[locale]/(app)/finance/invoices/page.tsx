import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { FinanceError } from "@/modules/finance/components/finance-error";
import { InvoicesTable } from "@/modules/finance/components/finance-tables";
import { invoiceList } from "@/modules/finance/lists";
import { financeErrorCode, parseBucket, parseInvoiceFilter, parseUuid } from "@/modules/finance/logic";
import { listCustomers, listInvoicesPage } from "@/modules/finance/queries";
import { pageRequest } from "@/modules/orders/kit/paging";
import { ExportCsvButton } from "@/modules/reports/components/export-csv-button";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.invoices" });
  return { title: t("title") };
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function InvoicesPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "finance.invoice.read")) return <Forbidden />;

  const sp = await searchParams;
  const bucket = parseBucket(sp.bucket);
  const filter = bucket ? "open" : parseInvoiceFilter(sp.status);
  const customerId = parseUuid(sp.customer);
  const t = await getTranslations("finance");
  const [invoices, customers] = await Promise.all([listInvoicesPage({ filter, customerId, bucket }, pageRequest(sp, invoiceList(filter))), listCustomers()]);
  const customerOptions = (customers.ok ? customers.data : []).map((c) => ({ value: c.id, label: c.display_name, description: c.customer_no ?? undefined, keywords: c.customer_no ? [c.customer_no] : [] }));

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("invoices.title")}
        description={t("invoices.intro")}
        actions={
          <>
            {can(ctx, "finance.invoice.issue") ? (
              <Link href="/finance/invoices/new" className={buttonVariants()}>
                {t("invoices.toInvoice")}
              </Link>
            ) : null}
            <ExportCsvButton ctx={ctx} kind="invoices" filters={{ status: filter, bucket, customer: customerId }} label={t("invoices.export")} />
          </>
        }
      />
      <InvoicesTable
        rows={invoices.ok ? invoices.data.rows : []}
        total={invoices.ok ? invoices.data.total : 0}
        filter={filter}
        bucket={bucket}
        customerId={customerId}
        customers={customerOptions}
        error={invoices.ok ? undefined : <FinanceError code={financeErrorCode(invoices.error)} requestId={invoices.error.requestId} />}
      />
    </div>
  );
}
