import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardTitle } from "@/components/ui/primitives";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { CommissionError } from "@/modules/commissions/components/commission-error";
import { PeriodsTable, type PeriodListRow } from "@/modules/commissions/components/commission-tables";
import { ClosePeriodForm } from "@/modules/commissions/components/period-actions";
import { CAIRO_DATE_TIME, formatEgp, formatMonth } from "@/modules/commissions/format";
import {
  cairoToday,
  closableMonth,
  commissionErrorCode,
  displayStatus,
  monthOf,
  periodRows,
  recalculableMonths,
  statusTone,
} from "@/modules/commissions/logic";
import { listPeriods, PERIOD_LIMIT } from "@/modules/commissions/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "commissions.periods" });
  return { title: t("title") };
}

/**
 * Commission months (perf.commission.calculate, finance by default): status, close date
 * and totals; recalculate an open month; close the oldest open month once it has ended.
 * The nightly cron closes a month by itself on day 6 of the next month.
 */
export default async function CommissionPeriodsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "perf.commission.calculate", "all")) return <Forbidden />;

  const t = await getTranslations("commissions");
  const format = await getFormatter();
  const today = cairoToday();
  const periods = await listPeriods();
  const list = periods.ok ? periods.data : [];
  const closable = closableMonth(list, today);
  const recalculable = new Set(recalculableMonths(list, today));
  const tableRows: PeriodListRow[] = periodRows(list, today).map((row) => {
    const key = monthOf(row.period_start);
    const missing = "missing" in row;
    const status = missing ? null : row.status;
    return {
      key,
      label: formatMonth(format, key),
      status: displayStatus(status),
      statusTone: statusTone(status),
      entries: missing ? null : formatEgp(format, row.entries_total),
      adjustments: missing ? null : formatEgp(format, row.adjustments_total),
      total: missing ? null : formatEgp(format, row.total),
      employees: missing ? null : format.number(row.employee_count, { numberingSystem: "latn" }),
      closing: missing
        ? null
        : row.is_frozen && row.closed_at
          ? t("period.closedAt", { at: format.dateTime(new Date(row.closed_at), CAIRO_DATE_TIME) })
          : t("period.closesAt", { at: format.dateTime(new Date(row.closes_at), CAIRO_DATE_TIME) }),
      recalculable: recalculable.has(key),
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader title={t("periods.title")} description={t("periods.intro")} />

      {periods.ok && closable ? (
        <Card className="space-y-3 border-warning/60">
          <CardTitle>{t("periods.closeTitle", { month: formatMonth(format, closable) })}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("periods.closeHint")}</p>
          <ClosePeriodForm period={closable} label={formatMonth(format, closable)} />
        </Card>
      ) : null}

      <PeriodsTable
        rows={periods.ok ? tableRows : []}
        error={periods.ok ? undefined : <CommissionError code={commissionErrorCode(periods.error)} requestId={periods.error.requestId} />}
      />
      {periods.ok && periods.data.length >= PERIOD_LIMIT ? (
        <p className="text-xs text-muted-foreground">{t("periods.limited", { count: PERIOD_LIMIT })}</p>
      ) : null}
    </div>
  );
}
