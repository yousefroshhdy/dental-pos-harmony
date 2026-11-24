import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { BackLink } from "@/components/page-kit/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { TeamTable, type TeamRow } from "@/modules/commissions/components/team-table";
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
  const rows: TeamRow[] = (summary.ok ? summary.data : []).map((r) => ({
    employeeId: r.employee_id,
    name: (lang === "ar" ? r.employee_name_ar : null) ?? r.employee_name_en ?? r.employee_no ?? "—",
    href: `/commissions?period=${month}&employee=${r.employee_id}`,
    earned: formatEgp(format, r.earned),
    clawedBack: formatEgp(format, r.clawed_back),
    adjustments: formatEgp(format, r.adjustments),
    total: formatEgp(format, r.total),
    totalValue: Number(r.total ?? 0),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<BackLink href={`/commissions?period=${month}`}>{t("team.back")}</BackLink>}
        title={t("team.title")}
        description={t("team.intro")}
      />
      <MonthPicker month={month} months={recentMonths(today)} path="/commissions/team" />

      <section aria-labelledby="team-month" className="space-y-3">
        <h2 id="team-month" className="text-lg font-semibold">
          {formatMonth(format, month)}
        </h2>
        {totals && rows.length > 0 ? (
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(
              [
                ["earned", totals.earned],
                ["clawedBack", totals.clawed],
                ["adjustments", totals.adjustments],
                ["total", totals.total],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className="rounded-lg border bg-card p-3 shadow-sm">
                <dt className="text-xs text-muted-foreground">
                  {key === "total" ? t("team.totalRow") : t(`statement.totals.${key}`)}
                </dt>
                <dd className={key === "total" ? "mt-1 text-xl font-semibold tabular-nums" : "mt-1 text-lg tabular-nums"}>{formatEgp(format, value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <TeamTable rows={rows} error={summary.ok ? undefined : <CommissionError code={commissionErrorCode(summary.error)} requestId={summary.error.requestId} />} />
      </section>
    </div>
  );
}
