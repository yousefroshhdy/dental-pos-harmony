import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { BreakdownTable } from "@/modules/dashboards/components/breakdown-table";
import { DashboardError } from "@/modules/dashboards/components/dashboard-error";
import { OverdueCustomers, PendingApprovals } from "@/modules/dashboards/components/lists";
import { PeriodPicker } from "@/modules/dashboards/components/period-picker";
import { StatTile } from "@/modules/dashboards/components/stat-tile";
import { TeamTable } from "@/modules/dashboards/components/team-table";
import { formatDay, formatKpi } from "@/modules/dashboards/format";
import {
  BRAND_CODES,
  byCode,
  cairoToday,
  dashboardErrorCode,
  dashboardScope,
  elapsedFraction,
  KPI_UNIT,
  periodHref,
  pivotBreakdown,
  pivotTeam,
  resolvePeriod,
  TERRITORY_CODES,
  TILE_GROUPS,
} from "@/modules/dashboards/logic";
import {
  getKpiBreakdown,
  getKpiSummary,
  getKpiTeam,
  getOverdueCustomers,
  getPendingForMe,
} from "@/modules/dashboards/queries";
import { parseEmployeeParam } from "@/modules/dashboards/schemas";
import type { KpiCode } from "@/modules/dashboards/types";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboards" });
  return { title: t("pageTitle") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const GROUPS = ["field", "sales", "cash", "operations"] as const;

/**
 * Role dashboard. Postgres decides whose numbers come back (perf.kpi.read scope):
 * a rep gets their own, an area manager the team, the director and owner the company.
 * This page only picks the layout from the same grant.
 */
export default async function DashboardPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: SearchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  const scope = dashboardScope(ctx);
  if (!scope || !can(ctx, "perf.kpi.read")) return <Forbidden />;

  const sp = await searchParams;
  const t = await getTranslations("dashboards");
  const format = await getFormatter();
  const lang = await getLocale();
  const today = cairoToday();
  const period = resolvePeriod(sp, today);
  const employeeId = scope === "own" ? null : parseEmployeeParam(sp.employee);
  const pace = elapsedFraction(period, today);
  const asOf = period.to < today ? period.to : today;
  const company = scope === "all" && !employeeId;

  const [summary, team, territory, brand, overdue, pending] = await Promise.all([
    getKpiSummary(period, employeeId),
    scope === "own" ? null : getKpiTeam(period),
    company ? getKpiBreakdown(period, "territory") : null,
    company ? getKpiBreakdown(period, "brand") : null,
    getOverdueCustomers(asOf, employeeId),
    scope !== "own" && can(ctx, "wf.approval.read") ? getPendingForMe() : null,
  ]);

  const members = team?.ok ? pivotTeam(team.data) : [];
  const filtered = employeeId ? members.find((m) => m.employee_id === employeeId) : undefined;
  const filteredName = filtered ? ((lang === "ar" ? filtered.full_name_ar : null) ?? filtered.full_name_en) : null;
  const rows = summary.ok ? byCode(summary.data) : {};

  const secondary = (code: KpiCode): string | undefined => {
    if (code === "VISITS_COMPLETED" && rows.VISITS_PLANNED) {
      return t("tile.planned", { planned: formatKpi(format, "count", rows.VISITS_PLANNED.value) });
    }
    if (code === "AR_OPEN" || code === "AR_OVERDUE") return t("tile.asOf", { day: formatDay(format, asOf) });
    if (code === "STOCK_ALERTS" && rows.STOCK_ALERTS?.detail) {
      const d = rows.STOCK_ALERTS.detail as { below_reorder?: number; expiring_lots?: number };
      return t("tile.stockDetail", { reorder: d.below_reorder ?? 0, expiring: d.expiring_lots ?? 0 });
    }
    if (code === "PENDING_APPROVALS" || code === "STOCK_ALERTS") return t("tile.live");
    return undefined;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{t(`title.${scope}`)}</h1>
          <p className="text-sm text-muted-foreground">{t(`subtitle.${scope}`)}</p>
        </div>
        {can(ctx, "perf.target.manage") ? (
          <Link href="/dashboard/targets" className={buttonVariants({ variant: "outline" })}>
            {t("targets.manage")}
          </Link>
        ) : null}
      </div>

      <PeriodPicker period={period} employeeId={employeeId} />
      {period.invalid ? <Alert tone="info">{t("period.invalid")}</Alert> : null}
      {employeeId ? (
        <Alert tone="info" role="status" className="flex flex-wrap items-center justify-between gap-2">
          <span>{filteredName ? t("filter.showing", { name: filteredName }) : t("filter.showingOne")}</span>
          <Link href={periodHref(period)} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
            {t("filter.clear")}
          </Link>
        </Alert>
      ) : null}

      {!summary.ok ? (
        <DashboardError code={dashboardErrorCode(summary.error)} requestId={summary.error.requestId} />
      ) : (
        GROUPS.map((group) => {
          const codes = TILE_GROUPS[group].filter((c) => rows[c]);
          if (codes.length === 0) return null;
          return (
            <section key={group} aria-labelledby={`group-${group}`} className="space-y-3">
              <h2 id={`group-${group}`} className="text-lg font-semibold">
                {t(`groups.${group}`)}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {codes.map((code) => (
                  <StatTile key={code} code={code} row={rows[code]} pace={pace} secondary={secondary(code)} />
                ))}
              </div>
            </section>
          );
        })
      )}

      {team ? (
        team.ok ? (
          <TeamTable members={members} period={period} pace={pace} />
        ) : (
          <DashboardError code={dashboardErrorCode(team.error)} requestId={team.error.requestId} />
        )
      ) : null}

      {territory ? (
        territory.ok ? (
          <BreakdownTable
            title={t("breakdown.territoryTitle")}
            dimensionLabel={t("breakdown.territory")}
            entries={pivotBreakdown(territory.data)}
            columns={TERRITORY_CODES.map((code) => ({ code, unit: KPI_UNIT[code] }))}
            barCode="BOOKED_SALES"
            emptyText={t("breakdown.empty")}
          />
        ) : (
          <DashboardError code={dashboardErrorCode(territory.error)} requestId={territory.error.requestId} />
        )
      ) : null}
      {territory?.ok ? <p className="-mt-4 text-xs text-muted-foreground">{t("breakdown.territoryNote")}</p> : null}

      {brand ? (
        brand.ok ? (
          <BreakdownTable
            title={t("breakdown.brandTitle")}
            dimensionLabel={t("breakdown.brand")}
            entries={pivotBreakdown(brand.data)}
            columns={BRAND_CODES.map((code) => ({ code, unit: KPI_UNIT[code] }))}
            barCode="BOOKED_SALES"
            emptyText={t("breakdown.empty")}
          />
        ) : (
          <DashboardError code={dashboardErrorCode(brand.error)} requestId={brand.error.requestId} />
        )
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {overdue.ok ? (
          <OverdueCustomers rows={overdue.data} title={t(scope === "own" ? "overdue.titleMine" : "overdue.title")} />
        ) : (
          <DashboardError code={dashboardErrorCode(overdue.error)} requestId={overdue.error.requestId} />
        )}
        {pending ? (
          pending.ok ? (
            <PendingApprovals rows={pending.data} />
          ) : (
            <DashboardError code={dashboardErrorCode(pending.error)} requestId={pending.error.requestId} />
          )
        ) : null}
      </div>
    </div>
  );
}
