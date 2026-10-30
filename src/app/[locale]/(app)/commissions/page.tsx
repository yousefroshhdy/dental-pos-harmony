import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Alert, Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { CommissionError } from "@/modules/commissions/components/commission-error";
import { MonthPicker } from "@/modules/commissions/components/month-picker";
import { StatementLines, StatementTotals } from "@/modules/commissions/components/statement";
import { CAIRO_DATE_TIME, formatMonth } from "@/modules/commissions/format";
import { cairoToday, commissionErrorCode, displayStatus, recentMonths, resolveMonth, statusTone } from "@/modules/commissions/logic";
import { getPeriod, getStatement, getSummary, STATEMENT_LIMIT } from "@/modules/commissions/queries";
import { parseEmployeeParam } from "@/modules/commissions/schemas";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "commissions.statement" });
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Commission statement of one month: the caller's own, or (managers, finance) the
 * employee in `?employee=`. RLS decides what comes back; a statement outside the
 * caller's scope is simply empty.
 */
export default async function CommissionStatementPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: SearchParams }) {
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
  const isOwn = employeeId !== null && employeeId === ctx.employee?.id;
  const canSeeTeam = can(ctx, "perf.commission.read", "team");

  const header = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("statement.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("statement.intro")}</p>
      </div>
      {canSeeTeam ? (
        <Link href={`/commissions/team?period=${month}`} className={cn(buttonVariants({ variant: "outline" }), "w-full sm:w-auto")}>
          {t("statement.teamLink")}
        </Link>
      ) : null}
    </div>
  );

  if (!employeeId) {
    return (
      <div className="space-y-6">
        {header}
        <Alert tone="info">{t("statement.noEmployee")}</Alert>
      </div>
    );
  }

  const [lines, summary, period] = await Promise.all([getStatement(month, employeeId), getSummary(month, employeeId), getPeriod(month)]);
  const row = summary.ok ? (summary.data[0] ?? null) : null;
  const name = row ? ((lang === "ar" ? row.employee_name_ar : null) ?? row.employee_name_en) : null;
  const status = period.ok ? (period.data?.status ?? null) : null;

  return (
    <div className="space-y-6">
      {header}
      <MonthPicker month={month} months={recentMonths(today)} path="/commissions" extra={{ employee: requested ?? undefined }} />

      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>
            {isOwn || !name ? t("statement.monthTitle", { month: formatMonth(format, month) }) : t("statement.otherTitle", { name, month: formatMonth(format, month) })}
          </CardTitle>
          <Badge tone={statusTone(status)}>{t(`period.status.${displayStatus(status)}`)}</Badge>
        </div>
        {period.ok && period.data ? (
          <p className="text-xs text-muted-foreground">
            {period.data.is_frozen && period.data.closed_at
              ? t("period.closedAt", { at: format.dateTime(new Date(period.data.closed_at), CAIRO_DATE_TIME) })
              : t("period.closesAt", { at: format.dateTime(new Date(period.data.closes_at), CAIRO_DATE_TIME) })}
            {period.data.calculated_at
              ? ` · ${t("period.calculatedAt", { at: format.dateTime(new Date(period.data.calculated_at), CAIRO_DATE_TIME) })}`
              : null}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("period.notCalculated")}</p>
        )}
        {summary.ok ? <StatementTotals summary={row} /> : <CommissionError code={commissionErrorCode(summary.error)} requestId={summary.error.requestId} />}
      </Card>

      <section className="space-y-3" aria-labelledby="commission-lines">
        <h2 id="commission-lines" className="text-lg font-semibold">
          {t("statement.lines")}
        </h2>
        {lines.ok ? (
          <>
            <StatementLines lines={lines.data} canOpenInvoices={can(ctx, "finance.invoice.read")} />
            {lines.data.length >= STATEMENT_LIMIT ? <p className="text-xs text-muted-foreground">{t("statement.limited", { count: STATEMENT_LIMIT })}</p> : null}
          </>
        ) : (
          <CommissionError code={commissionErrorCode(lines.error)} requestId={lines.error.requestId} />
        )}
        <p className="text-xs text-muted-foreground">{t("statement.rules")}</p>
      </section>
    </div>
  );
}
