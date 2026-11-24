import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { TargetIcon } from "lucide-react";
import { BackLink } from "@/components/page-kit/back-link";
import { FormSheet } from "@/components/page-kit/form-sheet";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { DashboardError } from "@/modules/dashboards/components/dashboard-error";
import { TargetForm } from "@/modules/dashboards/components/target-form";
import { formatDay, formatKpi } from "@/modules/dashboards/format";
import { cairoToday, dashboardErrorCode, monthRange, TARGETABLE_CODES } from "@/modules/dashboards/logic";
import { listTargets, listTargetSubjects, TARGET_LIST_LIMIT } from "@/modules/dashboards/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboards.targets" });
  return { title: t("title") };
}

/**
 * KPI targets (perf.target.manage). The dashboard shows achievement against them;
 * api.set_kpi_target checks the scope of each subject in Postgres.
 */
export default async function TargetsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "perf.target.manage")) return <Forbidden />;

  const t = await getTranslations("dashboards");
  const format = await getFormatter();
  const lang = await getLocale();
  const pick = (en: string | null, ar: string | null) => (lang === "ar" ? ar : null) ?? en ?? "—";
  const [targets, subjects] = await Promise.all([listTargets(), listTargetSubjects()]);
  const month = monthRange(cairoToday());

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<BackLink href="/dashboard">{t("targets.back")}</BackLink>}
        title={t("targets.title")}
        description={t("targets.intro")}
        actions={
          <FormSheet trigger={t("targets.new")} title={t("targets.new")} description={t("targets.latestWins")} closeLabel={t("targets.close")}>
            {subjects.ok ? (
              <TargetForm
                targetId={crypto.randomUUID()}
                kpis={TARGETABLE_CODES.map((code) => ({ id: code, label: t(`kpi.${code}.name`) }))}
                employees={subjects.data.employees.map((o) => ({ id: o.id, label: pick(o.label_en, o.label_ar) }))}
                roles={subjects.data.roles.map((o) => ({ id: o.id, label: pick(o.label_en, o.label_ar) }))}
                territories={subjects.data.territories.map((o) => ({ id: o.id, label: pick(o.label_en, o.label_ar) }))}
                defaultStart={month.from}
                defaultEnd={month.to}
              />
            ) : (
              <DashboardError code={dashboardErrorCode(subjects.error)} requestId={subjects.error.requestId} />
            )}
          </FormSheet>
        }
      />

      <Card className="space-y-3">
        <CardTitle>{t("targets.list")}</CardTitle>
        {!targets.ok ? (
          <DashboardError code={dashboardErrorCode(targets.error)} requestId={targets.error.requestId} />
        ) : targets.data.length === 0 ? (
          <EmptyState compact icon={<TargetIcon aria-hidden="true" />} title={t("targets.empty")} />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th scope="col">{t("targets.kpi")}</Th>
                  <Th scope="col">{t("targets.subject")}</Th>
                  <Th scope="col">{t("targets.period")}</Th>
                  <Th scope="col" className="text-end">
                    {t("targets.value")}
                  </Th>
                </tr>
              </thead>
              <tbody>
                {targets.data.map((row) => (
                  <tr key={row.id}>
                    <Td>{t(`kpi.${row.kpi_code}.name`)}</Td>
                    <Td>
                      {row.employee_id
                        ? pick(row.employee_name_en, row.employee_name_ar)
                        : row.role_id
                          ? t("targets.roleSubject", { name: pick(row.role_name_en, row.role_name_ar) })
                          : t("targets.territorySubject", { name: pick(row.territory_name_en, row.territory_name_ar) })}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {formatDay(format, row.period_start, "short")} – {formatDay(format, row.period_end, "short")}
                    </Td>
                    <Td className="text-end tabular-nums whitespace-nowrap">{formatKpi(format, row.unit, row.target_value)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="text-xs text-muted-foreground">{t("targets.latestWins")}</p>
            {targets.data.length >= TARGET_LIST_LIMIT ? (
              <p className="text-xs text-muted-foreground">{t("targets.limited", { count: TARGET_LIST_LIMIT })}</p>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
