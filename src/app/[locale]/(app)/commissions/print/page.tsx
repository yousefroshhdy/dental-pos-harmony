import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Alert } from "@/components/ui/primitives";
import { BackLink } from "@/components/page-kit/back-link";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { CommissionError } from "@/modules/commissions/components/commission-error";
import { StatementFunnel } from "@/modules/commissions/components/plan-parts";
import { CommissionPrintButton } from "@/modules/commissions/components/print-button";
import { CAIRO_DATE_TIME, formatDay, formatEgp, formatMonth, formatRate } from "@/modules/commissions/format";
import { cairoToday, commissionErrorCode, displayStatus, resolveMonth, sortLines } from "@/modules/commissions/logic";
import { getStatement, getStatementTotals, STATEMENT_LIMIT } from "@/modules/commissions/queries";
import { parseEmployeeParam } from "@/modules/commissions/schemas";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "commissions.print" });
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// The app shell (header, main padding) is shared; hide it for this page only, when printing.
const PRINT_CSS = `
@page { size: A4; margin: 12mm; }
@media print {
  html, body { background: #fff !important; }
  body header.sticky, body nav { display: none !important; }
  body main { max-width: none !important; padding: 0 !important; margin: 0 !important; }
  .cm-doc { border: 0 !important; box-shadow: none !important; padding: 0 !important; max-width: none !important; }
  .cm-doc tr, .cm-keep { page-break-inside: avoid; }
}
`;

/**
 * Printable rep statement of one month: collected cash → commissionable amount (excl. VAT)
 * → commission → clawbacks → net, then every line. Same scope as the statement page (RLS:
 * a rep their own, a manager the team, finance and the owner everyone).
 */
export default async function CommissionPrintPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: SearchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "perf.commission.read")) return <Forbidden />;

  const sp = await searchParams;
  const t = await getTranslations("commissions");
  const format = await getFormatter();
  const lang = await getLocale();
  const today = cairoToday();
  const month = resolveMonth(sp.period, today);
  const requested = parseEmployeeParam(sp.employee);
  const employeeId = requested ?? ctx.employee?.id ?? null;
  const back = `/commissions?period=${month}${requested ? `&employee=${requested}` : ""}`;

  const toolbar = (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
      <BackLink href={back}>{t("print.back")}</BackLink>
      <CommissionPrintButton label={t("print.print")} />
    </div>
  );

  if (!employeeId) {
    return (
      <div className="pb-6">
        {toolbar}
        <Alert tone="info">{t("statement.noEmployee")}</Alert>
      </div>
    );
  }

  const [totals, lines] = await Promise.all([getStatementTotals(month, employeeId), getStatement(month, employeeId)]);
  if (!totals.ok) return <CommissionError code={commissionErrorCode(totals.error)} requestId={totals.error.requestId} />;
  if (!lines.ok) return <CommissionError code={commissionErrorCode(lines.error)} requestId={lines.error.requestId} />;
  const row = totals.data;
  const name = row ? ((lang === "ar" ? row.employee_name_ar : null) ?? row.employee_name_en) : (ctx.employee?.full_name_en ?? null);
  const employeeNo = row?.employee_no ?? (employeeId === ctx.employee?.id ? ctx.employee.employee_no : null);
  const sorted = sortLines(lines.data);

  return (
    <div className="pb-6">
      <style>{PRINT_CSS}</style>
      {toolbar}
      <article
        aria-label={t("print.title")}
        className="cm-doc mx-auto w-full max-w-[210mm] space-y-6 rounded-md border bg-white p-4 text-sm text-neutral-900 shadow-sm sm:p-8 print:text-[11pt]"
      >
        <header className="cm-keep flex flex-wrap items-start justify-between gap-3 border-b pb-4">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">{t("print.heading")}</h1>
            <p>
              {name ?? "—"}
              {employeeNo ? (
                <span className="ms-1 text-neutral-600" dir="ltr">
                  ({employeeNo})
                </span>
              ) : null}
            </p>
          </div>
          <div className="space-y-1 text-end">
            <p className="font-medium">{formatMonth(format, month)}</p>
            <p className="text-xs text-neutral-600">{t(`period.status.${displayStatus(row?.period_status ?? null)}`)}</p>
            <p className="text-xs text-neutral-600">{t("print.printedAt", { at: format.dateTime(new Date(), CAIRO_DATE_TIME) })}</p>
          </div>
        </header>

        <section className="cm-keep space-y-2" aria-labelledby="print-summary">
          <h2 id="print-summary" className="font-semibold">
            {t("statement.funnelTitle")}
          </h2>
          <StatementFunnel totals={row} />
        </section>

        <section className="space-y-2" aria-labelledby="print-lines">
          <h2 id="print-lines" className="font-semibold">
            {t("statement.lines")}
          </h2>
          {sorted.length === 0 ? (
            <p className="text-neutral-600">{t("statement.empty")}</p>
          ) : (
            <div className="overflow-x-auto print:overflow-visible">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b text-start">
                    <th className="py-1 pe-2 text-start font-medium">{t("print.day")}</th>
                    <th className="py-1 pe-2 text-start font-medium">{t("print.kind")}</th>
                    <th className="py-1 pe-2 text-start font-medium">{t("print.document")}</th>
                    <th className="py-1 pe-2 text-end font-medium">{t("print.base")}</th>
                    <th className="py-1 pe-2 text-end font-medium">{t("print.rate")}</th>
                    <th className="py-1 text-end font-medium">{t("print.amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((l) => (
                    <tr key={`${l.line_type}-${l.id}`} className="border-b align-top">
                      <td className="py-1 pe-2 whitespace-nowrap">{formatDay(format, l.event_date)}</td>
                      <td className="py-1 pe-2">{t(`kind.${l.kind}`)}</td>
                      <td className="py-1 pe-2 break-words">
                        {l.line_type === "entry" ? (
                          <>
                            <span dir="ltr">{l.invoice_no ?? "—"}</span>
                            {l.customer_name ? ` · ${l.customer_name}` : null}
                            {l.sku ? (
                              <span className="ms-1" dir="ltr">
                                ({l.sku})
                              </span>
                            ) : null}
                          </>
                        ) : (
                          (l.reason ?? "—")
                        )}
                      </td>
                      <td className="py-1 pe-2 text-end tabular-nums">{l.line_type === "entry" ? formatEgp(format, l.base_amount) : "—"}</td>
                      <td className="py-1 pe-2 text-end tabular-nums">{l.line_type === "entry" ? formatRate(format, l.rate_pct) : "—"}</td>
                      <td className="py-1 text-end tabular-nums">{formatEgp(format, l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {lines.data.length >= STATEMENT_LIMIT ? <p className="text-xs text-neutral-600">{t("statement.limited", { count: STATEMENT_LIMIT })}</p> : null}
        </section>
        <p className="cm-keep text-xs text-neutral-600">{t("statement.rules")}</p>
      </article>
    </div>
  );
}
