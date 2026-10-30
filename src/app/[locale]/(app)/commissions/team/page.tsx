import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { CommissionError } from "@/modules/commissions/components/commission-error";
import { MonthPicker } from "@/modules/commissions/components/month-picker";
import { formatEgp, formatMonth } from "@/modules/commissions/format";
import { cairoToday, commissionErrorCode, recentMonths, resolveMonth, sumSummary } from "@/modules/commissions/logic";
import { getSummary } from "@/modules/commissions/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "commissions.team" });
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * One row per employee for a month: an area manager sees the team, finance, the sales
 * director and the owner everyone (perf.commission.read scope, enforced by RLS).
 */
export default async function CommissionTeamPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: SearchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "perf.commission.read", "team")) return <Forbidden />;

  const sp = await searchParams;
  const t = await getTranslations("commissions");
  const format = await getFormatter();
  const lang = await getLocale();
  const today = cairoToday();
  const month = resolveMonth(sp.period, today);
  const summary = await getSummary(month);
  const totals = summary.ok ? sumSummary(summary.data) : null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href={`/commissions?period=${month}`} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("team.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{t("team.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("team.intro")}</p>
      </div>
      <MonthPicker month={month} months={recentMonths(today)} path="/commissions/team" />

      <Card className="space-y-3">
        <CardTitle>{formatMonth(format, month)}</CardTitle>
        {!summary.ok ? (
          <CommissionError code={commissionErrorCode(summary.error)} requestId={summary.error.requestId} />
        ) : summary.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("team.empty")}</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th scope="col">{t("team.employee")}</Th>
                <Th scope="col" className="text-end">
                  {t("statement.totals.earned")}
                </Th>
                <Th scope="col" className="text-end">
                  {t("statement.totals.clawedBack")}
                </Th>
                <Th scope="col" className="text-end">
                  {t("statement.totals.adjustments")}
                </Th>
                <Th scope="col" className="text-end">
                  {t("statement.totals.total")}
                </Th>
              </tr>
            </thead>
            <tbody>
              {summary.data.map((r) => (
                <tr key={r.employee_id}>
                  <Td>
                    <Link
                      href={`/commissions?period=${month}&employee=${r.employee_id}`}
                      className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
                    >
                      {(lang === "ar" ? r.employee_name_ar : null) ?? r.employee_name_en ?? r.employee_no ?? "—"}
                    </Link>
                  </Td>
                  <Td className="text-end tabular-nums whitespace-nowrap">{formatEgp(format, r.earned)}</Td>
                  <Td className="text-end tabular-nums whitespace-nowrap">{formatEgp(format, r.clawed_back)}</Td>
                  <Td className="text-end tabular-nums whitespace-nowrap">{formatEgp(format, r.adjustments)}</Td>
                  <Td className="text-end font-semibold tabular-nums whitespace-nowrap">{formatEgp(format, r.total)}</Td>
                </tr>
              ))}
            </tbody>
            {totals ? (
              <tfoot>
                <tr>
                  <Th scope="row">{t("team.totalRow")}</Th>
                  <Th className="text-end tabular-nums">{formatEgp(format, totals.earned)}</Th>
                  <Th className="text-end tabular-nums">{formatEgp(format, totals.clawed)}</Th>
                  <Th className="text-end tabular-nums">{formatEgp(format, totals.adjustments)}</Th>
                  <Th className="text-end tabular-nums">{formatEgp(format, totals.total)}</Th>
                </tr>
              </tfoot>
            ) : null}
          </Table>
        )}
      </Card>
    </div>
  );
}
