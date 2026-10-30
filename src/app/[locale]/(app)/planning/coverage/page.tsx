import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, Badge, Label, Select } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { chipClass, Empty, Item, PageBody } from "@/modules/field/components/layout-bits";
import { localizedName } from "@/modules/field/logic";
import { FrequencyForm } from "@/modules/planning/components/frequency-form";
import { DAY_MEDIUM, MONTH_LONG, dayAsDate } from "@/modules/planning/format";
import { canPlan, canSeeCoverage, canSetFrequency, coveragePct, parseCoverageFilter, sortCoverage, sortEmployees } from "@/modules/planning/logic";
import { COVERAGE_LIMIT, listCoverage, listPlanningEmployees } from "@/modules/planning/queries";
import type { CoverageRow, PlanningEmployee } from "@/modules/planning/types";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "planning.coverage" });
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Coverage this month (api.v_coverage): per customer in my scope, the visit target from its class
 * vs completed visit-days, and overdue customers (never visited, or not within their interval)
 * first. Managers set the class here (api.set_visit_frequency) and jump to the plan.
 */
export default async function CoveragePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: SearchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canSeeCoverage(ctx)) return <Forbidden />;

  const sp = await searchParams;
  const t = await getTranslations("planning");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();
  const lang = await getLocale();

  const mayPlan = canPlan(ctx);
  const mayEdit = canSetFrequency(ctx);
  const filter = parseCoverageFilter(sp.show);

  // Reps to filter by: whoever I can plan for (a rep sees only their own customers anyway).
  const employeesResult = mayPlan ? await listPlanningEmployees() : null;
  const employees: PlanningEmployee[] = employeesResult?.ok ? sortEmployees(employeesResult.data, lang) : [];
  const wanted = typeof sp.employee === "string" ? sp.employee : undefined;
  const employeeId = employees.some((e) => e.id === wanted) ? wanted : undefined;

  const result = await listCoverage({ employeeId, filter });
  const rows = result.ok ? sortCoverage(result.data, lang) : [];
  const period = rows[0]?.period_start;

  const day = (d: string) => format.dateTime(dayAsDate(d), DAY_MEDIUM);
  const qs = (show: string) => `/planning/coverage?show=${show}${employeeId ? `&employee=${employeeId}` : ""}`;
  const repName = (r: CoverageRow) => (r.employee_id ? localizedName(lang, r.employee_name_en, r.employee_name_ar) : t("coverage.unassigned"));
  const overdueBadge = (r: CoverageRow) =>
    !r.is_overdue ? (
      <Badge tone="success">{t("coverage.onTrack")}</Badge>
    ) : r.last_visit_on === null ? (
      <Badge tone="danger">{t("coverage.neverVisited")}</Badge>
    ) : (
      <Badge tone="danger">{t("coverage.overdueBy", { count: r.overdue_days ?? 0 })}</Badge>
    );

  return (
    <PageBody>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("coverage.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {period ? t("coverage.subtitle", { month: format.dateTime(dayAsDate(period), MONTH_LONG) }) : t("coverage.subtitleNoPeriod")}
        </p>
      </div>

      <nav aria-label={t("coverage.filterLabel")} className="flex flex-wrap gap-2">
        <Link href={qs("overdue")} className={chipClass(filter === "overdue")} aria-current={filter === "overdue" ? "page" : undefined}>
          {t("coverage.showOverdue")}
        </Link>
        <Link href={qs("all")} className={chipClass(filter === "all")} aria-current={filter === "all" ? "page" : undefined}>
          {t("coverage.showAll")}
        </Link>
      </nav>

      {employees.length > 1 ? (
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="show" value={filter} />
          <div className="min-w-0 flex-1 space-y-1 sm:flex-none">
            <Label htmlFor="coverage-employee">{t("coverage.rep")}</Label>
            <Select id="coverage-employee" name="employee" defaultValue={employeeId ?? ""} className="w-full sm:w-72">
              <option value="">{t("coverage.allReps")}</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {localizedName(lang, e.full_name_en, e.full_name_ar)}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="outline">
            {t("week.show")}
          </Button>
        </form>
      ) : null}

      {!result.ok ? (
        <Alert>{tErrors(result.error.messageKey, { requestId: result.error.requestId ?? "—" })}</Alert>
      ) : rows.length === 0 ? (
        <Empty>{filter === "overdue" ? t("coverage.emptyOverdue") : t("coverage.empty")}</Empty>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {filter === "overdue" ? t("coverage.countOverdue", { count: rows.length }) : t("coverage.count", { count: rows.length })}
            {rows.length >= COVERAGE_LIMIT ? ` · ${t("coverage.limited", { limit: COVERAGE_LIMIT })}` : ""}
          </p>
          <ul className="grid gap-3 md:grid-cols-2">
            {rows.map((r) => (
              <Item key={r.customer_id} className={cn(r.is_overdue && "border-destructive/40")}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-medium">{r.customer_name}</h2>
                    <p className="text-xs text-muted-foreground">
                      {r.customer_no} · {repName(r)}
                    </p>
                  </div>
                  {overdueBadge(r)}
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">{t("coverage.class")}</dt>
                  <dd>
                    {t(`class.${r.visit_class}`)}
                    {r.class_is_default ? <span className="ms-1 text-xs text-muted-foreground">{t("coverage.defaultClass")}</span> : null}
                  </dd>
                  <dt className="text-muted-foreground">{t("coverage.lastVisit")}</dt>
                  <dd>{r.last_visit_on ? t("coverage.lastVisitValue", { date: day(r.last_visit_on), days: r.days_since_last_visit ?? 0 }) : t("coverage.never")}</dd>
                  <dt className="text-muted-foreground">{t("coverage.thisMonth")}</dt>
                  <dd>
                    {t("coverage.visitsOfTarget", { actual: r.actual_visits, target: r.target_visits })}
                    <span className="sr-only"> ({coveragePct(r)}%)</span>
                  </dd>
                  <dt className="text-muted-foreground">{t("coverage.nextPlanned")}</dt>
                  <dd>{r.next_planned_on ? day(r.next_planned_on) : t("coverage.notPlanned")}</dd>
                </dl>
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label={t("coverage.thisMonth")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={coveragePct(r)}
                >
                  <div className={cn("h-full", r.target_met ? "bg-success" : "bg-warning")} style={{ inlineSize: `${coveragePct(r)}%` }} />
                </div>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  {mayEdit ? <FrequencyForm customerId={r.customer_id} customerName={r.customer_name} current={r.visit_class} /> : <span />}
                  {mayPlan && r.employee_id && !r.next_planned_on ? (
                    <Link
                      href={`/planning?employee=${r.employee_id}&customer=${r.customer_id}#add-visit`}
                      className={buttonVariants({ variant: "outline", size: "sm", className: "min-h-11" })}
                    >
                      {t("coverage.plan")}
                    </Link>
                  ) : null}
                </div>
              </Item>
            ))}
          </ul>
        </>
      )}
    </PageBody>
  );
}
