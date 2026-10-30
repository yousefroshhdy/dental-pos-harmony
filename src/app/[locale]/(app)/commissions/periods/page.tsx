import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { CommissionError } from "@/modules/commissions/components/commission-error";
import { ClosePeriodForm, RecalculateForm } from "@/modules/commissions/components/period-actions";
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
  const rows = periodRows(list, today);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("periods.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("periods.intro")}</p>
      </div>

      {!periods.ok ? (
        <CommissionError code={commissionErrorCode(periods.error)} requestId={periods.error.requestId} />
      ) : (
        <>
          {closable ? (
            <Card className="space-y-3 border-warning/60">
              <CardTitle>{t("periods.closeTitle", { month: formatMonth(format, closable) })}</CardTitle>
              <p className="text-sm text-muted-foreground">{t("periods.closeHint")}</p>
              <ClosePeriodForm period={closable} label={formatMonth(format, closable)} />
            </Card>
          ) : null}

          <ul className="space-y-3" aria-label={t("periods.list")}>
            {rows.map((row) => {
              const key = monthOf(row.period_start);
              const label = formatMonth(format, key);
              const missing = "missing" in row;
              const status = missing ? null : row.status;
              return (
                <li key={key}>
                  <Card className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-base font-semibold">
                        <Link href={`/commissions/team?period=${key}`} className="text-primary underline-offset-4 hover:underline">
                          {label}
                        </Link>
                      </h2>
                      <Badge tone={statusTone(status)}>{t(`period.status.${displayStatus(status)}`)}</Badge>
                    </div>
                    {missing ? (
                      <p className="text-sm text-muted-foreground">{t("period.notCalculated")}</p>
                    ) : (
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                        <div>
                          <dt className="text-xs text-muted-foreground">{t("periods.entries")}</dt>
                          <dd className="tabular-nums">{formatEgp(format, row.entries_total)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">{t("statement.totals.adjustments")}</dt>
                          <dd className="tabular-nums">{formatEgp(format, row.adjustments_total)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">{t("statement.totals.total")}</dt>
                          <dd className="font-semibold tabular-nums">{formatEgp(format, row.total)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">{t("periods.employees")}</dt>
                          <dd className="tabular-nums">{format.number(row.employee_count, { numberingSystem: "latn" })}</dd>
                        </div>
                      </dl>
                    )}
                    {!missing ? (
                      <p className="text-xs text-muted-foreground">
                        {row.is_frozen && row.closed_at
                          ? t("period.closedAt", { at: format.dateTime(new Date(row.closed_at), CAIRO_DATE_TIME) })
                          : t("period.closesAt", { at: format.dateTime(new Date(row.closes_at), CAIRO_DATE_TIME) })}
                      </p>
                    ) : null}
                    {recalculable.has(key) ? <RecalculateForm period={key} label={label} /> : null}
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {periods.ok && periods.data.length >= PERIOD_LIMIT ? (
        <p className="text-xs text-muted-foreground">{t("periods.limited", { count: PERIOD_LIMIT })}</p>
      ) : null}
    </div>
  );
}
