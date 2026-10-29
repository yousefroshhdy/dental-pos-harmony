import { getFormatter, getTranslations } from "next-intl/server";
import { Badge, Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { CAIRO_DATE_TIME, LATN_NUMBER } from "../format";
import {
  headlineFact,
  isOverdue,
  localizedName,
  requestFacts,
  requestTitle,
  statusTone,
  visitStatusKey,
  waitingFor,
  workflowLabelKey,
  type Fact,
} from "../logic";
import type { ApprovalRequestRow } from "../types";

/** Server-side presentation pieces shared by the inbox and the detail page. */

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Format = Awaited<ReturnType<typeof getFormatter>>;

export function workflowLabel(t: Translate, code: string, fallbackName: string): string {
  const key = workflowLabelKey(code);
  return key ? t(`workflows.${key}`) : fallbackName;
}

export function factText(fact: Fact, t: Translate, format: Format): string {
  const n = typeof fact.value === "number" ? fact.value : Number(fact.value);
  switch (fact.kind) {
    case "money":
      return format.number(n, "egp");
    case "percent":
      return t("units.percent", { value: format.number(n, LATN_NUMBER) });
    case "units":
      return t("units.units", { value: format.number(n, LATN_NUMBER) });
    case "signedUnits":
      return t("units.units", { value: `${n > 0 ? "+" : ""}${format.number(n, LATN_NUMBER)}` });
    case "meters":
      return t("units.meters", { value: format.number(Math.round(n), LATN_NUMBER) });
    case "visitStatus": {
      const key = visitStatusKey(fact.value);
      return key ? t(`visitStatus.${key}`) : String(fact.value);
    }
    case "flag":
      return t(`facts.${fact.key}`);
    default:
      return String(fact.value);
  }
}

/** "Waiting 3 hours" for pending requests; "Decided <date>" otherwise. */
export function waitingText(row: Pick<ApprovalRequestRow, "status" | "stage_started_at" | "decided_at">, now: Date, t: Translate, format: Format) {
  if (row.status !== "pending") {
    return row.decided_at ? t("card.decidedAt", { date: format.dateTime(new Date(row.decided_at), CAIRO_DATE_TIME) }) : null;
  }
  const w = waitingFor(row.stage_started_at, now);
  return t(`card.waiting.${w.unit}`, { count: w.count });
}

export async function FactList({ facts }: { facts: Fact[] }) {
  const t = await getTranslations("approvals");
  const format = await getFormatter();
  const flags = facts.filter((f) => f.kind === "flag");
  const values = facts.filter((f) => f.kind !== "flag");
  return (
    <div className="space-y-3">
      {flags.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {flags.map((f) => (
            <Badge key={f.key} tone="warning">
              {factText(f, t, format)}
            </Badge>
          ))}
        </div>
      ) : null}
      {values.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("detail.noFacts")}</p>
      ) : (
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {values.map((f) => (
            <div key={f.key} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{t(`facts.${f.key}`)}</dt>
              <dd className={cn("break-words", f.kind === "text" ? "" : "font-medium")}>
                {f.kind === "text" ? factText(f, t, format) : <span dir="ltr">{factText(f, t, format)}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** One request in the inbox list. */
export async function RequestCard({ row, locale, now }: { row: ApprovalRequestRow; locale: string; now: Date }) {
  const t = await getTranslations("approvals");
  const format = await getFormatter();
  const facts = requestFacts(row, locale);
  const headline = headlineFact(facts);
  const title = requestTitle(row) ?? workflowLabel(t, row.workflow_code, row.workflow_name);
  const requester = localizedName(locale, row.requester_name_en, row.requester_name_ar) || t("unknownPerson");
  const overdue = row.status === "pending" && isOverdue(row.stage_started_at, now);
  const stage = row.stage_count ? t("card.stageOf", { stage: row.current_stage, count: row.stage_count }) : t("card.stage", { stage: row.current_stage });

  return (
    <Card className="space-y-2 p-4 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 font-medium break-words">
          <Link href={`/approvals/${row.request_id}`} className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">
            {title}
          </Link>
        </h3>
        <Badge tone={statusTone(row.status)} className="shrink-0">
          {t(`status.${row.status}`)}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("card.requestedBy", { name: requester })}
        {row.status === "pending" ? <> · {stage}</> : null}
      </p>
      {headline ? (
        <p className="text-sm">
          <span className="text-muted-foreground">{t(`facts.${headline.key}`)}: </span>
          <span dir="ltr" className="font-medium">
            {factText(headline, t, format)}
          </span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={cn(overdue ? "font-medium text-destructive" : "text-muted-foreground")}>{waitingText(row, now, t, format)}</span>
        {overdue ? <Badge tone="danger">{t("card.overdue")}</Badge> : null}
        {row.decided_by_me && row.my_decision ? (
          <Badge tone={row.my_decision === "approved" ? "success" : "danger"}>{t(`card.myDecision.${row.my_decision}`)}</Badge>
        ) : null}
      </div>
    </Card>
  );
}
