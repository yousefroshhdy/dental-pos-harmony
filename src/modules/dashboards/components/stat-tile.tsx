import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { formatKpi, formatPercent } from "../format";
import { accumulates, KPI_LINKS, kpiStatus, meterPercent, toNumber } from "../logic";
import type { KpiCode, KpiRow, KpiStatus } from "../types";

const STATUS_TONE: Record<KpiStatus, "success" | "warning" | "danger"> = { onTrack: "success", atRisk: "warning", behind: "danger" };
const STATUS_ICON = { onTrack: CircleCheck, atRisk: TriangleAlert, behind: CircleX } as const;

/**
 * One KPI: label, value, optional target meter with a status (icon + label, never
 * colour alone), the formula behind it and a link to the records it counts.
 * The meter's unfilled track is a lighter step of the same hue (dataviz guidance).
 */
export async function StatTile({ code, row, pace, secondary }: { code: KpiCode; row: KpiRow | undefined; pace: number; secondary?: string }) {
  const t = await getTranslations("dashboards");
  const format = await getFormatter();
  if (!row) return null;

  const status = kpiStatus(row, pace);
  const target = toNumber(row.target);
  const href = KPI_LINKS[code];
  const headingId = `kpi-${code}`;
  const Icon = status ? STATUS_ICON[status] : null;

  return (
    <article aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-4 shadow-sm">
      <h3 id={headingId} className="text-sm font-medium text-muted-foreground">
        {t(`kpi.${code}.name`)}
      </h3>
      <p className="text-2xl font-semibold tabular-nums">{formatKpi(format, row.unit, row.value)}</p>
      {secondary ? <p className="text-xs text-muted-foreground">{secondary}</p> : null}

      {target !== null && target > 0 ? (
        <div className="space-y-1.5">
          {row.higher_is_better ? (
            <div
              role="meter"
              aria-label={t("tile.progressLabel", { name: t(`kpi.${code}.name`) })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(meterPercent(row.value, row.target))}
              className="h-2 w-full overflow-hidden rounded-full bg-primary/15"
            >
              <div className="h-full rounded-full bg-primary" style={{ inlineSize: `${meterPercent(row.value, row.target)}%` }} />
            </div>
          ) : null}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>
              {t("tile.target", { target: formatKpi(format, row.unit, row.target) })}
              {row.achievement_pct !== null ? ` · ${formatPercent(format, row.achievement_pct)}` : ""}
            </span>
            {status && Icon ? (
              <Badge tone={STATUS_TONE[status]} className="gap-1">
                <Icon aria-hidden="true" className="size-3.5" />
                {t(`status.${status}`)}
              </Badge>
            ) : null}
          </p>
          {accumulates(row) && pace < 1 ? <p className="text-xs text-muted-foreground">{t("tile.paceNote")}</p> : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{row.is_point_in_time ? t("tile.asOfEnd") : t("tile.noTarget")}</p>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        <details className="text-xs">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-muted-foreground hover:text-foreground">
            {t("tile.howCalculated")}
          </summary>
          <p className="max-w-prose pb-2">{t(`kpi.${code}.definition`)}</p>
        </details>
        {href ? (
          <Link href={href} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
            {t("tile.openList")}
          </Link>
        ) : null}
      </div>
    </article>
  );
}
