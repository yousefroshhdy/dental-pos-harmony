import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Card } from "@/components/ui/primitives";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { BackLink } from "@/modules/finance/components/bits";
import { FinanceError } from "@/modules/finance/components/finance-error";
import { RecordPaymentForm } from "@/modules/finance/components/payment-forms";
import { financeErrorCode, parseUuid } from "@/modules/finance/logic";
import { listCustomers } from "@/modules/finance/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.record" });
  return { title: t("title") };
}

/** Record a payment received (cash or cheque in the field, transfers at the office). */
export default async function RecordPaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ customer?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "finance.payment.record")) return <Forbidden />;

  const t = await getTranslations("finance");
  const customers = await listCustomers();
  const preselected = parseUuid((await searchParams).customer);

  return (
    <div className="mx-auto max-w-xl space-y-4">
      {can(ctx, "finance.payment.read") ? <BackLink href="/finance/payments" label={t("record.back")} /> : null}
      <h1 className="text-2xl font-semibold">{t("record.title")}</h1>
      {!customers.ok ? (
        <FinanceError code={financeErrorCode(customers.error)} requestId={customers.error.requestId} />
      ) : (
        <Card>
          <RecordPaymentForm
            customers={customers.data}
            defaultCustomerId={preselected && customers.data.some((c) => c.id === preselected) ? preselected : null}
            locale={locale}
          />
        </Card>
      )}
    </div>
  );
}
