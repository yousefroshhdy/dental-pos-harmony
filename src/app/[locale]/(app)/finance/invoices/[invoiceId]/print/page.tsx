import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Forbidden } from "@/components/forbidden";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { amountInWords } from "@/modules/finance/amount-words";
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
import { CAIRO_DATE, CAIRO_DATE_TIME, dateOnly, PERCENT, QUANTITY } from "@/modules/finance/format";
import { financeErrorCode, isUuid, toNumber } from "@/modules/finance/logic";
import { companyHeader, nonZero, parseDocLang, vatSummary } from "@/modules/finance/print";
import { getCompanyProfile, getInvoice, getInvoicePrintParty, listInvoiceLines } from "@/modules/finance/queries";

type Params = Promise<{ locale: string; invoiceId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.print" });
  return { title: t("invoiceMetaTitle") };
}

/**
 * Printable A4 tax invoice. Arabic (RTL) by default; ?lang=en prints it in English.
 * Every figure is read from api.v_invoices / api.v_invoice_lines; nothing is recomputed
 * except the per-rate VAT summary and the amount in words.
 */
export default async function InvoicePrintPage({ params, searchParams }: { params: Params; searchParams: Promise<{ lang?: string }> }) {
  const { locale, invoiceId } = await params;
  setRequestLocale(locale);
  if (!isUuid(invoiceId)) notFound();
  const ctx = await getUserContext();
  if (!can(ctx, "finance.invoice.read")) return <Forbidden />;
  const lang = parseDocLang((await searchParams).lang);

  const [invoice, lines, party, company] = await Promise.all([
    getInvoice(invoiceId),
    listInvoiceLines(invoiceId),
    getInvoicePrintParty(invoiceId),
    getCompanyProfile(),
  ]);
  if (!invoice.ok) return <FinanceError code={financeErrorCode(invoice.error)} requestId={invoice.error.requestId} />;
  if (!invoice.data) notFound();
  if (!lines.ok) return <FinanceError code={financeErrorCode(lines.error)} requestId={lines.error.requestId} />;
  if (!party.ok) return <FinanceError code={financeErrorCode(party.error)} requestId={party.error.requestId} />;
  if (!company.ok) return <FinanceError code={financeErrorCode(company.error)} requestId={company.error.requestId} />;

  const inv = invoice.data;
  const ui = await getTranslations("finance.print");
  const t = await getTranslations({ locale: lang, namespace: "finance.print" });
  const tf = await getTranslations({ locale: lang, namespace: "finance" });
  const format = await getFormatter({ locale: lang });
  const money = (v: number | string | null) => format.number(toNumber(v), "egp");
  const header = companyHeader(company.data, lang);
  const p = party.data;
  const vat = vatSummary(lines.data);
  const address = [p?.address_line, p?.city, lang === "ar" ? p?.governorate_name_ar : p?.governorate_name_en].filter(Boolean).join(lang === "ar" ? "، " : ", ");
  const customerNo = p?.customer_no ?? inv.customer_no;
  const showSettlement = nonZero(inv.allocated) || nonZero(inv.credited) || nonZero(inv.written_off);

  return (
    <div className="pb-6">
      <PrintStyles />
      <PrintToolbar
        backHref={`/finance/invoices/${inv.id}`}
        backLabel={ui("backToInvoice")}
        basePath={`/finance/invoices/${inv.id}/print`}
        lang={lang}
        labels={{ language: ui("language"), ar: ui("arabic"), en: ui("english"), print: ui("print") }}
      />
      <PrintSheet lang={lang} label={t("invoiceTitle")}>
        <CompanyBlock
          company={header}
          labels={{ taxNo: t("taxNo"), commercialNo: t("commercialNo"), phone: t("phone") }}
          aside={
            <>
              <h1 className="text-xl font-bold">{t("invoiceTitle")}</h1>
              <DocField label={t("invoiceNo")} value={inv.invoice_no} ltr />
              <DocField label={t("issueDate")} value={format.dateTime(dateOnly(inv.issue_date), CAIRO_DATE)} />
              <DocField label={t("dueDate")} value={format.dateTime(dateOnly(inv.due_date), CAIRO_DATE)} />
              {inv.order_no ? <DocField label={t("orderNo")} value={inv.order_no} ltr /> : null}
              {inv.status !== "issued" ? <DocField label={t("status")} value={tf(`invoiceStatus.${inv.status}`)} /> : null}
              {inv.eta_uuid ? <DocField label={t("etaUuid")} value={inv.eta_uuid} ltr /> : null}
            </>
          }
        />

        <section className="fin-doc-keep space-y-0.5" aria-labelledby="bill-to">
          <h2 id="bill-to" className="font-semibold text-neutral-600">
            {t("billTo")}
          </h2>
          <p className="text-base font-semibold">{p?.customer_name ?? inv.customer_name ?? "—"}</p>
          {customerNo ? <DocField label={t("customerNo")} value={customerNo} ltr /> : null}
          {address ? <p>{address}</p> : null}
          {p?.phone_primary ? <DocField label={t("phone")} value={p.phone_primary} ltr /> : null}
          {p?.tax_registration_no ? <DocField label={t("taxNo")} value={p.tax_registration_no} ltr /> : null}
          {p?.commercial_reg_no ? <DocField label={t("commercialNo")} value={p.commercial_reg_no} ltr /> : null}
        </section>

        <div className="fin-doc-scroll overflow-x-auto">
          <table className="w-full border-collapse text-start">
            <thead>
              <tr className="border-b-2 border-neutral-400 text-neutral-700">
                <th scope="col" className="p-1 text-start">#</th>
                <th scope="col" className="p-1 text-start">{t("item")}</th>
                <th scope="col" className="p-1 text-end">{t("qty")}</th>
                <th scope="col" className="p-1 text-end">{t("unitPrice")}</th>
                <th scope="col" className="p-1 text-end">{t("discount")}</th>
                <th scope="col" className="p-1 text-end">{t("vatRate")}</th>
                <th scope="col" className="p-1 text-end">{t("vat")}</th>
                <th scope="col" className="p-1 text-end">{t("lineTotal")}</th>
              </tr>
            </thead>
            <tbody>
              {lines.data.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-2 text-center text-neutral-600">
                    {t("noLines")}
                  </td>
                </tr>
              ) : (
                lines.data.map((l, i) => (
                  <tr key={l.invoice_item_id} className="border-b border-neutral-200 align-top">
                    <td className="p-1">{format.number(i + 1, QUANTITY)}</td>
                    <td className="p-1">
                      <span dir="ltr" className="font-medium">
                        {l.sku ?? "—"}
                      </span>
                      <span className="block text-xs text-neutral-600">{l.description}</span>
                    </td>
                    <td className="p-1 text-end">{format.number(l.quantity, QUANTITY)}</td>
                    <td className="p-1 text-end whitespace-nowrap">{money(l.unit_price)}</td>
                    <td className="p-1 text-end whitespace-nowrap">{money(l.discount)}</td>
                    <td className="p-1 text-end">{format.number(toNumber(l.tax_rate_pct), PERCENT)}%</td>
                    <td className="p-1 text-end whitespace-nowrap">{money(l.tax_amount)}</td>
                    <td className="p-1 text-end font-medium whitespace-nowrap">{money(l.line_total)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="fin-doc-keep flex flex-col gap-4 sm:flex-row sm:justify-between">
          <section className="sm:w-1/2" aria-labelledby="vat-summary">
            <h2 id="vat-summary" className="mb-1 font-semibold text-neutral-600">
              {t("vatSummary")}
            </h2>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-neutral-400 text-neutral-700">
                  <th scope="col" className="p-1 text-start">{t("vatRate")}</th>
                  <th scope="col" className="p-1 text-end">{t("taxable")}</th>
                  <th scope="col" className="p-1 text-end">{t("vat")}</th>
                </tr>
              </thead>
              <tbody>
                {vat.map((g) => (
                  <tr key={g.rate} className="border-b border-neutral-200">
                    <td className="p-1">{format.number(g.rate, PERCENT)}%</td>
                    <td className="p-1 text-end whitespace-nowrap">{money(g.taxable)}</td>
                    <td className="p-1 text-end whitespace-nowrap">{money(g.vat)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="space-y-1 sm:w-5/12" aria-label={t("totals")}>
            <TotalRow label={t("subtotal")} value={money(inv.subtotal)} />
            <TotalRow label={t("discount")} value={`− ${money(inv.discount_total)}`} />
            <TotalRow label={t("vat")} value={money(inv.tax_total)} />
            <TotalRow label={t("total")} value={money(inv.total)} strong />
            {showSettlement ? (
              <>
                {nonZero(inv.allocated) ? <TotalRow label={t("paid")} value={`− ${money(inv.allocated)}`} /> : null}
                {nonZero(inv.credited) ? <TotalRow label={t("credited")} value={`− ${money(inv.credited)}`} /> : null}
                {nonZero(inv.written_off) ? <TotalRow label={t("writtenOff")} value={`− ${money(inv.written_off)}`} /> : null}
                <TotalRow label={t("balanceDue")} value={money(inv.open_amount)} strong />
              </>
            ) : null}
          </section>
        </div>

        <AmountWords label={t("amountInWords")} words={amountInWords(inv.total, lang)} />

        <footer className="space-y-1 border-t border-neutral-300 pt-3 text-xs text-neutral-600">
          <p>{t("invoiceFooter")}</p>
          <p>{t("printedAt", { at: format.dateTime(new Date(), CAIRO_DATE_TIME) })}</p>
        </footer>
      </PrintSheet>
    </div>
  );
}
