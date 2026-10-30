import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Badge, Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { formatKpi, formatPercent } from "../format";
import { KPI_UNIT, kpiStatus, periodHref, type TeamMember } from "../logic";
import type { KpiCode, KpiStatus, Period } from "../types";

const STATUS_TONE: Record<KpiStatus, "success" | "warning" | "danger"> = { onTrack: "success", atRisk: "warning", behind: "danger" };

/**
 * Team table: one row per measured employee in the caller's scope (api.kpi_team),
 * the same KPIs as the tiles. A name opens the dashboard filtered to that person.
 * Booked-sales status is shown as a labelled badge (status is never colour alone).
 */
export async function TeamTable({ members, period, pace }: { members: readonly TeamMember[]; period: Period; pace: number }) {
  const t = await getTranslations("dashboards");
  const format = await getFormatter();
  const locale = await getLocale();
  const cell = (m: TeamMember, code: KpiCode) => formatKpi(format, KPI_UNIT[code], m.kpis[code]?.value ?? null);

  return (
    <Card className="space-y-3">
      <CardTitle>{t("team.title")}</CardTitle>
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("team.empty")}</p>
      ) : (
        <Table>
          <caption className="sr-only">{t("team.caption")}</caption>
          <thead>
            <tr>
              <Th scope="col">{t("team.employee")}</Th>
              <Th scope="col" className="text-end">
                {t("team.visits")}
              </Th>
              <Th scope="col" className="text-end">
                {t("kpi.VISITS_VERIFIED_PCT.short")}
              </Th>
              <Th scope="col" className="text-end">
                {t("kpi.ORDERS_BOOKED.short")}
              </Th>
              <Th scope="col" className="text-end">
                {t("kpi.BOOKED_SALES.short")}
              </Th>
              <Th scope="col">{t("team.vsTarget")}</Th>
              <Th scope="col" className="text-end">
                {t("kpi.CASH_COLLECTED.short")}
              </Th>
              <Th scope="col" className="text-end">
                {t("kpi.AR_OVERDUE.short")}
              </Th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const booked = m.kpis.BOOKED_SALES;
              const status = booked
                ? kpiStatus({ unit: "egp", is_point_in_time: false, higher_is_better: true, value: booked.value, target: booked.target }, pace)
                : null;
              return (
                <tr key={m.employee_id}>
                  <Th scope="row" className="bg-transparent font-normal">
                    <Link
                      href={periodHref(period, { employee: m.employee_id })}
                      className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
                    >
                      {(locale === "ar" ? m.full_name_ar : null) ?? m.full_name_en}
                    </Link>
                  </Th>
                  <Td className="text-end tabular-nums whitespace-nowrap">
                    {t("team.visitsOfPlanned", { completed: cell(m, "VISITS_COMPLETED"), planned: cell(m, "VISITS_PLANNED") })}
                  </Td>
                  <Td className="text-end tabular-nums">{cell(m, "VISITS_VERIFIED_PCT")}</Td>
                  <Td className="text-end tabular-nums">{cell(m, "ORDERS_BOOKED")}</Td>
                  <Td className="text-end tabular-nums whitespace-nowrap">{cell(m, "BOOKED_SALES")}</Td>
                  <Td className="whitespace-nowrap">
                    {status ? (
                      <Badge tone={STATUS_TONE[status]}>
                        {t(`status.${status}`)} · {formatPercent(format, booked?.achievement_pct)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("tile.noTarget")}</span>
                    )}
                  </Td>
                  <Td className="text-end tabular-nums whitespace-nowrap">{cell(m, "CASH_COLLECTED")}</Td>
                  <Td className="text-end tabular-nums whitespace-nowrap">{cell(m, "AR_OVERDUE")}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
