import { getFormatter, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";
import { localizedName } from "../logic";
import { CAIRO_DATE_TIME } from "../format";
import { ACTIVITY_TYPES, type ActivityType, type TimelineRow } from "../types";

const TONE: Partial<Record<ActivityType, "neutral" | "success" | "warning" | "danger" | "info">> = {
  visit: "info",
  order: "success",
  invoice: "success",
  payment: "success",
  stage_change: "warning",
  assignment: "warning",
};

/**
 * The customer's unified timeline (api.v_customer_timeline), newest first.
 * Summaries written by the system are stored in English; they are shown as-is.
 */
export async function Timeline({ rows, locale }: { rows: TimelineRow[]; locale: string }) {
  const t = await getTranslations("crm.timeline");
  const tType = await getTranslations("crm.activityType");
  const format = await getFormatter();

  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t("empty")}</p>;

  return (
    <ol className="space-y-3 border-s ps-4">
      {rows.map((row) => {
        const who = localizedName(locale, row.employee_name_en, row.employee_name_ar);
        const type = (ACTIVITY_TYPES as readonly string[]).includes(row.type) ? row.type : null;
        return (
          <li key={row.id} className="relative space-y-1">
            <span aria-hidden className="absolute -start-[1.3rem] top-1.5 size-2 rounded-full bg-primary" />
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge tone={type ? (TONE[type] ?? "neutral") : "neutral"}>{type ? tType(type) : row.type}</Badge>
              <time dateTime={row.occurred_at}>{format.dateTime(new Date(row.occurred_at), CAIRO_DATE_TIME)}</time>
              {who ? <span>· {who}</span> : null}
            </div>
            {row.summary ? <p className="text-sm break-words whitespace-pre-line">{row.summary}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
