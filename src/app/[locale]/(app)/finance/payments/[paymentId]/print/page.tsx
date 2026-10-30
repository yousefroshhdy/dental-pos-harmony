import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Forbidden } from "@/components/forbidden";
import { Alert } from "@/components/ui/primitives";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { amountInWords } from "@/modules/finance/amount-words";
import { BackLink } from "@/modules/finance/components/bits";
import { FinanceError } from "@/modules/finance/components/finance-error";
import {
  AmountWords,
  CompanyBlock,
  DocField,
  PrintSheet,
  PrintStyles,
  PrintToolbar,
  TotalRow,
} from "@/modules/finance/components/print-document";
import { CAIRO_DATE, CAIRO_DATE_TIME, dateOnly } from "@/modules/finance/format";
import { financeErrorCode, isUuid, localizedName, toCents, toNumber } from "@/modules/finance/logic";
import { companyHeader, hasReceipt, parseDocLang } from "@/modules/finance/print";
import { getCompanyProfile, getPayment, listAllocationsForPayment } from "@/modules/finance/queries";

type Params = Promise<{ locale: string; paymentId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.print" });
  return { title: t("receiptMetaTitle") };
}

/**
 * Printable A4 receipt of a confirmed payment. Arabic (RTL) by default; ?lang=en in
 * English. Pending, bounced and reversed payments have no receipt.
 */
export default async function PaymentReceiptPage({ params, searchParams }: { params: Params; searchParams: Promise<{ lang?: string }> }) {
  const { locale, paymentId } = await params;
  setRequestLocale(locale);
  if (!isUuid(paymentId)) notFound();
  const ctx = await getUserContext();
  if (!can(ctx, "finance.payment.read") && !can(ctx, "finance.payment.record")) return <Forbidden />;
  const lang = parseDocLang((await searchParams).lang);

  const payment = await getPayment(paymentId);
  if (!payment.ok) return <FinanceError code={financeErrorCode(payment.error)} requestId={payment.error.requestId} />;
  if (!payment.data) notFound();
  const pay = payment.data;
  const ui = await getTranslations("finance.print");

  if (!hasReceipt(pay)) {
    return (
      <div className="space-y-4 pb-6">
        <BackLink href={`/finance/payments/${pay.id}`} label={ui("backToPayment")} />
        <Alert tone="info" role="status">
          {ui("receiptUnavailable")}
        </Alert>
      </div>
    );
  }

  const [allocations, company] = await Promise.all([listAllocationsForPayment(paymentId), getCompanyProfile()]);
  if (!allocations.ok) return <FinanceError code={financeErrorCode(allocations.error)} requestId={allocations.error.requestId} />;
  if (!company.ok) return <FinanceError code={financeErrorCode(company.error)} requestId={company.error.requestId} />;

  const t = await getTranslations({ locale: lang, namespace: "finance.print" });
  const tf = await getTranslations({ locale: lang, namespace: "finance" });
  const format = await getFormatter({ locale: lang });
  const money = (v: number | string | null) => format.number(toNumber(v), "egp");
  const header = companyHeader(company.data, lang);
  // Applications still in force: positive rows that were not reversed.
  const applied = allocations.data.filter((a) => toCents(a.amount) > 0 && !a.is_reversed);
  const collector = localizedName(lang, pay.collected_by_name_en, pay.collected_by_name_ar);

  return (
    <div className="pb-6">
      <PrintStyles />
      <PrintToolbar
        backHref={`/finance/payments/${pay.id}`}
        backLabel={ui("backToPayment")}
        basePath={`/finance/payments/${pay.id}/print`}
        lang={lang}
        labels={{ language: ui("language"), ar: ui("arabic"), en: ui("english"), print: ui("print") }}
      />
      <PrintSheet lang={lang} label={t("receiptTitle")}>
        <CompanyBlock
          company={header}
          labels={{ taxNo: t("taxNo"), commercialNo: t("commercialNo"), phone: t("phone") }}
          aside={
            <>
              <h1 className="text-xl font-bold">{t("receiptTitle")}</h1>
              <DocField label={t("receiptNo")} value={pay.payment_no} ltr />
              <DocField label={t("receivedAt")} value={format.dateTime(new Date(pay.received_at), CAIRO_DATE_TIME)} />
              {pay.confirmed_at ? <DocField label={t("confirmedAt")} value={format.dateTime(new Date(pay.confirmed_at), CAIRO_DATE_TIME)} /> : null}
            </>
          }
        />

        <section className="fin-doc-keep space-y-1" aria-labelledby="received-from">
          <h2 id="received-from" className="font-semibold text-neutral-600">
            {t("receivedFrom")}
          </h2>
          <p className="text-base font-semibold">{pay.customer_name ?? "—"}</p>
          {pay.customer_no ? <DocField label={t("customerNo")} value={pay.customer_no} ltr /> : null}
        </section>

        <section className="fin-doc-keep space-y-1 rounded border border-neutral-300 p-3" aria-label={t("amount")}>
          <TotalRow label={t("amount")} value={money(pay.amount)} strong />
          <DocField label={t("method")} value={tf(`method.${pay.method}`)} />
          {pay.reference ? <DocField label={t("reference")} value={pay.reference} ltr /> : null}
          {pay.cheque_due_date ? <DocField label={t("chequeDueDate")} value={format.dateTime(dateOnly(pay.cheque_due_date), CAIRO_DATE)} /> : null}
        </section>

        <AmountWords label={t("amountInWords")} words={amountInWords(pay.amount, lang)} />

        <section aria-labelledby="applied-to">
          <h2 id="applied-to" className="mb-1 font-semibold text-neutral-600">
            {t("appliedTo")}
          </h2>
          {applied.length === 0 ? (
            <p>{t("notApplied")}</p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-neutral-400 text-neutral-700">
                  <th scope="col" className="p-1 text-start">{t("invoiceNo")}</th>
                  <th scope="col" className="p-1 text-end">{t("appliedAmount")}</th>
                </tr>
              </thead>
              <tbody>
                {applied.map((a) => (
                  <tr key={a.id} className="border-b border-neutral-200">
                    <td className="p-1" dir="ltr">
                      {a.invoice_no ?? "—"}
                    </td>
                    <td className="p-1 text-end whitespace-nowrap">{money(a.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {toCents(pay.unallocated) > 0 ? (
            <p className="mt-2">
              {t("onAccount")}: <span className="font-medium">{money(pay.unallocated)}</span>
            </p>
          ) : null}
        </section>

        <div className="fin-doc-keep grid gap-8 pt-6 sm:grid-cols-2">
          <div>
            <p className="text-neutral-600">{t("collectedBy")}</p>
            <p className="font-medium">{collector || "—"}</p>
          </div>
          <div>
            <p className="text-neutral-600">{t("signature")}</p>
            <div className="mt-8 border-b border-neutral-500" aria-hidden />
          </div>
        </div>

        <footer className="space-y-1 border-t border-neutral-300 pt-3 text-xs text-neutral-600">
          <p>{t("receiptFooter")}</p>
          <p>{t("printedAt", { at: format.dateTime(new Date(), CAIRO_DATE_TIME) })}</p>
        </footer>
      </PrintSheet>
    </div>
  );
}
