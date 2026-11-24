import { CalendarCheck, ChevronLeft, ChevronRight, CircleAlert, Inbox, MapPinCheck, Sparkles, Users } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import type { AppError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { workflowLabel } from "@/modules/approvals/components/request-view";
import { formatKpi, formatPercent } from "@/modules/dashboards/format";
import { byCode, KPI_LINKS, pivotTeam, toNumber } from "@/modules/dashboards/logic";
import { getKpiSummary, getKpiTeam, getPendingForMe } from "@/modules/dashboards/queries";
import type { KpiCode, Period } from "@/modules/dashboards/types";
import { pipelineByStage, receiptsSummary } from "../logic";
import { getAgingTotals, listOpenOpportunities, listPlanToday, listReceiptsToday, listVisitsToday } from "../queries";

const LATN = { numberingSystem: "latn" } as const;
const CAIRO_TIME = { hour: "numeric", minute: "2-digit", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/** A home card: heading, optional "open the list" link, body. */
export async function HomeSection({
  title,
  href,
  icon,
  className,
  children,
}: {
  title: string;
  href?: string;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const t = await getTranslations("home");
  const locale = await getLocale();
  const Chevron = locale === "ar" ? ChevronLeft : ChevronRight;
  return (
    <section className={cn("flex min-w-0 flex-col rounded-lg border bg-card p-4 shadow-sm", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          {icon ? (
            <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-md bg-secondary text-secondary-foreground [&_svg]:size-4">
              {icon}
            </span>
          ) : null}
          {title}
        </h2>
        {href ? (
          <Link href={href} className="inline-flex min-h-11 min-w-11 items-center justify-center gap-0.5 text-sm text-primary underline-offset-4 hover:underline">
            {t("open")}
            <Chevron aria-hidden="true" className="size-4" />
          </Link>
        ) : null}
      </div>
      <div className="flex-1">{children}</div>
    </section>
  );
}

/** A failed read: says so, never shows a zero in its place. */
export async function HomeError({ error }: { error: AppError }) {
  const t = await getTranslations("home");
  return (
    <EmptyState
      compact
      tone="danger"
      icon={<CircleAlert aria-hidden="true" />}
      title={t("error.title")}
      description={error.requestId ? t("error.bodyWithRef", { requestId: error.requestId }) : t("error.body")}
    />
  );
}

// ---------------------------------------------------------------------------
// KPI strip (api.kpi_summary through the dashboards module)
// ---------------------------------------------------------------------------

export async function KpiStrip({ codes, period, title }: { codes: readonly KpiCode[]; period: Period; title: string }) {
  const t = await getTranslations("home");
  const td = await getTranslations("dashboards");
  const format = await getFormatter();
  const summary = await getKpiSummary(period);

  return (
    <section aria-labelledby="home-kpis" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="home-kpis" className="text-base font-semibold">
          {title}
        </h2>
        <Link href="/dashboard" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("kpis.openDashboard")}
        </Link>
      </div>
      {!summary.ok ? (
        <HomeError error={summary.error} />
      ) : (
        (() => {
          const rows = byCode(summary.data);
          const shown = codes.filter((c) => rows[c]);
          if (shown.length === 0) return <EmptyState compact title={t("kpis.empty")} description={t("kpis.emptyHint")} />;
          return (
            <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {shown.map((code) => {
                const row = rows[code]!;
                const target = toNumber(row.target);
                const href = KPI_LINKS[code];
                const body = (
                  <>
                    <p className="text-xs font-medium text-muted-foreground">{td(`kpi.${code}.short`)}</p>
                    <p className="mt-1 text-xl font-semibold tabular-nums">{formatKpi(format, row.unit, row.value)}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                      {target !== null && target > 0
                        ? t("kpis.ofTarget", { target: formatKpi(format, row.unit, row.target), pct: formatPercent(format, row.achievement_pct) })
                        : row.is_point_in_time
                          ? t("kpis.now")
                          : t("kpis.noTarget")}
                    </p>
                  </>
                );
                return (
                  <li key={code}>
                    {href ? (
                      <Link href={href} className="block h-full rounded-lg border bg-card p-3 shadow-xs transition-colors hover:bg-muted/40">
                        {body}
                      </Link>
                    ) : (
                      <div className="h-full rounded-lg border bg-card p-3 shadow-xs">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          );
        })()
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Approvals waiting for the caller (api.v_approval_requests)
// ---------------------------------------------------------------------------

export async function ApprovalsCard() {
  const t = await getTranslations("home");
  const ta = await getTranslations("approvals");
  const format = await getFormatter();
  const pending = await getPendingForMe();
  return (
    <HomeSection title={t("approvals.title")} href="/approvals" icon={<Inbox />}>
      {!pending.ok ? (
        <HomeError error={pending.error} />
      ) : pending.data.length === 0 ? (
        <EmptyState compact title={t("approvals.empty")} />
      ) : (
        <ul className="divide-y">
          {pending.data.map((r) => (
            <li key={r.request_id}>
              <Link href={`/approvals/${r.request_id}`} className="flex min-h-11 items-center justify-between gap-3 py-2 hover:text-primary">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{workflowLabel(ta, r.workflow_code, r.workflow_name)}</span>
                  {r.customer_name ? <span className="block truncate text-xs text-muted-foreground">{r.customer_name}</span> : null}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {format.dateTime(new Date(r.created_at), { day: "numeric", month: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </HomeSection>
  );
}

// ---------------------------------------------------------------------------
// Team activity today (api.kpi_team)
// ---------------------------------------------------------------------------

export async function TeamActivityCard({ today, href }: { today: Period; href: string }) {
  const t = await getTranslations("home");
  const format = await getFormatter();
  const locale = await getLocale();
  const team = await getKpiTeam(today);
  const members = team.ok ? pivotTeam(team.data) : [];
  const count = (v: unknown) => {
    const n = toNumber(v as never);
    return n === null ? "—" : format.number(n, LATN);
  };

  return (
    <HomeSection title={t("team.title")} href={href} icon={<Users />}>
      {!team.ok ? (
        <HomeError error={team.error} />
      ) : members.length === 0 ? (
        <EmptyState compact title={t("team.empty")} />
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">{t("team.caption")}</caption>
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="pb-2 text-start font-medium">
                {t("team.member")}
              </th>
              <th scope="col" className="pb-2 text-end font-medium">
                {t("team.visits")}
              </th>
              <th scope="col" className="pb-2 text-end font-medium">
                {t("team.orders")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {members.slice(0, 10).map((m) => (
              <tr key={m.employee_id}>
                <td className="max-w-0 truncate py-2">{(locale === "ar" ? m.full_name_ar : null) ?? m.full_name_en}</td>
                <td className="py-2 text-end tabular-nums">
                  {t("team.visitsValue", { done: count(m.kpis.VISITS_COMPLETED?.value), planned: count(m.kpis.VISITS_PLANNED?.value) })}
                </td>
                <td className="py-2 text-end tabular-nums">{count(m.kpis.ORDERS_BOOKED?.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </HomeSection>
  );
}

// ---------------------------------------------------------------------------
// Pipeline (api.v_opportunities)
// ---------------------------------------------------------------------------

export async function PipelineCard() {
  const t = await getTranslations("home");
  const format = await getFormatter();
  const result = await listOpenOpportunities();
  const stages = result.ok ? pipelineByStage(result.data) : [];
  const total = stages.reduce((n, s) => n + s.count, 0);
  const max = Math.max(1, ...stages.map((s) => s.count));

  return (
    <HomeSection title={t("pipeline.title")} href="/opportunities" icon={<Sparkles />}>
      {!result.ok ? (
        <HomeError error={result.error} />
      ) : total === 0 ? (
        <EmptyState compact title={t("pipeline.empty")} />
      ) : (
        <ul className="space-y-2.5">
          {stages.map((s) => (
            <li key={s.stage} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span>{t(`pipeline.stages.${s.stage}`)}</span>
                <span className="text-muted-foreground tabular-nums">
                  {t("pipeline.stageValue", { count: s.count, value: format.number(s.value, "egp") })}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-primary/12" aria-hidden="true">
                <div className="h-full rounded-full bg-primary" style={{ inlineSize: `${(s.count / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </HomeSection>
  );
}

// ---------------------------------------------------------------------------
// Finance: receipts today, aging (api.v_payments, api.v_ar_aging_totals)
// ---------------------------------------------------------------------------

export async function ReceiptsTodayCard() {
  const t = await getTranslations("home");
  const format = await getFormatter();
  const result = await listReceiptsToday();
  const summary = result.ok ? receiptsSummary(result.data) : null;

  return (
    <HomeSection title={t("receipts.title")} href="/finance/payments" icon={<CalendarCheck />}>
      {!result.ok ? (
        <HomeError error={result.error} />
      ) : !summary || summary.count === 0 ? (
        <EmptyState compact title={t("receipts.empty")} />
      ) : (
        <div className="space-y-2">
          <p className="text-2xl font-semibold tabular-nums">{format.number(summary.total, "egp")}</p>
          <p className="text-sm text-muted-foreground">{t("receipts.count", { count: summary.count })}</p>
          {summary.pending > 0 ? (
            <Badge tone="warning">{t("receipts.pending", { count: summary.pending })}</Badge>
          ) : null}
        </div>
      )}
    </HomeSection>
  );
}

const BUCKETS = ["current_amount", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;

export async function AgingCard() {
  const t = await getTranslations("home");
  const format = await getFormatter();
  const result = await getAgingTotals();
  const totals = result.ok ? result.data : null;
  const open = toNumber(totals?.total_open ?? null) ?? 0;

  return (
    <HomeSection title={t("aging.title")} href="/finance/aging" icon={<CircleAlert />}>
      {!result.ok ? (
        <HomeError error={result.error} />
      ) : !totals || open === 0 ? (
        <EmptyState compact title={t("aging.empty")} />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-2xl font-semibold tabular-nums">{format.number(open, "egp")}</p>
            <p className="text-sm text-destructive tabular-nums">
              {t("aging.overdue", { amount: format.number(toNumber(totals.overdue_amount) ?? 0, "egp") })}
            </p>
          </div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
            {BUCKETS.map((b) => (
              <div key={b} className="contents">
                <dt className="text-muted-foreground">{t(`aging.buckets.${b}`)}</dt>
                <dd className="text-end tabular-nums">{format.number(toNumber(totals[b]) ?? 0, "egp")}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">{t("aging.customers", { count: totals.customers })}</p>
        </div>
      )}
    </HomeSection>
  );
}

// ---------------------------------------------------------------------------
// Rep: today's plan, visits today, leads (api.v_my_today, api.v_visits)
// ---------------------------------------------------------------------------

export async function PlanTodayCard() {
  const t = await getTranslations("home");
  const format = await getFormatter();
  const result = await listPlanToday();

  return (
    <HomeSection title={t("plan.title")} href="/today" icon={<CalendarCheck />}>
      {!result.ok ? (
        <HomeError error={result.error} />
      ) : result.data.length === 0 ? (
        <EmptyState
          compact
          title={t("plan.empty")}
          action={
            <Link href="/planning" className={buttonVariants({ variant: "outline", size: "sm" })}>
              {t("plan.planDay")}
            </Link>
          }
        />
      ) : (
        <ol className="divide-y">
          {result.data.map((item, i) => (
            <li key={item.item_id}>
              <Link href={item.customer_id ? `/customers/${item.customer_id}` : "/today"} className="flex min-h-11 items-center gap-3 py-2 hover:text-primary">
                <span
                  aria-hidden="true"
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground tabular-nums"
                >
                  {format.number(i + 1, LATN)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.customer_name ?? item.title}</span>
                {item.status === "in_progress" ? (
                  <Badge tone="info">{t("plan.inProgress")}</Badge>
                ) : item.due_at ? (
                  <span className="text-xs text-muted-foreground tabular-nums">{format.dateTime(new Date(item.due_at), CAIRO_TIME)}</span>
                ) : null}
              </Link>
            </li>
          ))}
        </ol>
      )}
    </HomeSection>
  );
}

export async function VisitsTodayCard({ employeeId }: { employeeId: string | null }) {
  const t = await getTranslations("home");
  const format = await getFormatter();
  if (!employeeId) {
    return (
      <HomeSection title={t("visits.title")} href="/visits" icon={<MapPinCheck />}>
        <EmptyState compact title={t("visits.noEmployee")} />
      </HomeSection>
    );
  }
  const result = await listVisitsToday(employeeId);

  return (
    <HomeSection title={t("visits.title")} href="/visits" icon={<MapPinCheck />}>
      {!result.ok ? (
        <HomeError error={result.error} />
      ) : result.data.length === 0 ? (
        <EmptyState compact title={t("visits.empty")} />
      ) : (
        <ul className="divide-y">
          {result.data.map((v) => (
            <li key={v.id}>
              <Link href={`/visits/${v.id}`} className="flex min-h-11 items-center justify-between gap-3 py-2 hover:text-primary">
                <span className="min-w-0 truncate text-sm font-medium">{v.customer_name ?? "—"}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {v.check_in_at ? (
                    <span className="text-xs text-muted-foreground tabular-nums">{format.dateTime(new Date(v.check_in_at), CAIRO_TIME)}</span>
                  ) : null}
                  <Badge tone={v.status === "completed" ? "success" : "info"}>{t(v.status === "completed" ? "visits.done" : "visits.open")}</Badge>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </HomeSection>
  );
}

/** Leads near the rep (Phase P step 4, another module): a pointer until that screen lands. */
export async function LeadsCard() {
  const t = await getTranslations("home");
  return (
    <HomeSection title={t("leads.title")} icon={<Sparkles />}>
      <EmptyState
        compact
        title={t("leads.body")}
        action={
          <Link href="/leads" className={buttonVariants({ variant: "outline", size: "sm" })}>
            {t("leads.open")}
          </Link>
        }
      />
    </HomeSection>
  );
}
