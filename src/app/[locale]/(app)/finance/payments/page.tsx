import type { Metadata } from "next";
import { PlusIcon } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { FinanceError } from "@/modules/finance/components/finance-error";
import { PaymentsTable } from "@/modules/finance/components/finance-tables";
import { PAYMENT_LIST } from "@/modules/finance/lists";
import { financeErrorCode, parsePaymentFilter, parseUuid, withQuery } from "@/modules/finance/logic";
import { listCustomers, listPaymentsPage } from "@/modules/finance/queries";
import { pageRequest } from "@/modules/orders/kit/paging";
import { ExportCsvButton } from "@/modules/reports/components/export-csv-button";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.payments" });
  return { title: t("title") };
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function PaymentsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "finance.payment.read")) return <Forbidden />;

  const sp = await searchParams;
  // Finance lands on the verification queue; everyone else on all their payments.
  const defaultFilter = can(ctx, "finance.payment.confirm") ? "pending" : "all";
  const filter = parsePaymentFilter(sp.status, defaultFilter);
  const customerId = parseUuid(sp.customer);
  const t = await getTranslations("finance");
  const [payments, customers] = await Promise.all([listPaymentsPage(filter, customerId, pageRequest(sp, PAYMENT_LIST)), listCustomers()]);
  const customerOptions = (customers.ok ? customers.data : []).map((c) => ({ value: c.id, label: c.display_name, description: c.customer_no ?? undefined, keywords: c.customer_no ? [c.customer_no] : [] }));
  const record = can(ctx, "finance.payment.record") ? (
    <Link href={withQuery("/finance/payments/new", { customer: customerId })} className={buttonVariants()}>
      <PlusIcon aria-hidden="true" />
      {t("payments.record")}
    </Link>
  ) : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("payments.title")}
        description={t("payments.intro")}
        actions={
          <>
            <ExportCsvButton ctx={ctx} kind="payments" filters={{ status: filter, customer: customerId }} label={t("payments.export")} />
            {record}
          </>
        }
      />
      <PaymentsTable
        rows={payments.ok ? payments.data.rows : []}
        total={payments.ok ? payments.data.total : 0}
        filter={filter}
        defaultFilter={defaultFilter}
        customerId={customerId}
        customers={customerOptions}
        error={payments.ok ? undefined : <FinanceError code={financeErrorCode(payments.error)} requestId={payments.error.requestId} />}
        emptyAction={record}
      />
    </div>
  );
}
