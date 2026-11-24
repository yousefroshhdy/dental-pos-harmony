import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { CalendarDaysIcon } from "lucide-react";
import { FilterChips } from "@/components/page-kit/filter-chips";
import { UrlSelectFilter } from "@/components/page-kit/url-select-filter";
import { buttonVariants } from "@/components/ui/button";
import { readTableParams } from "@/components/ui/data-table-params";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { PageBody } from "@/modules/field/components/layout-bits";
import { localizedName } from "@/modules/field/logic";
import { CoverageTable, type CoverageListRow } from "@/modules/planning/components/coverage-table";
import { DAY_MEDIUM, MONTH_LONG, dayAsDate } from "@/modules/planning/format";
import { canPlan, canSeeCoverage, canSetFrequency, coveragePct, parseCoverageFilter, sortEmployees } from "@/modules/planning/logic";
import { listCoveragePage, listPlanningEmployees } from "@/modules/planning/queries";
import { COVERAGE_TABLE } from "@/modules/planning/tables";
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

  const table = readTableParams(sp, COVERAGE_TABLE);
  const result = await listCoveragePage({
    employeeId,
    filter,
    offset: table.offset,
    pageSize: table.pageSize,
    sort: table.sorting[0],
    search: table.search,
  });
  const page = result.ok ? result.data.rows : [];
  const period = page[0]?.period_start;

  const day = (d: string) => format.dateTime(dayAsDate(d), DAY_MEDIUM);
  const repName = (r: CoverageRow) => (r.employee_id ? localizedName(lang, r.employee_name_en, r.employee_name_ar) : t("coverage.unassigned"));
  const rows: CoverageListRow[] = page.map((r) => ({
    customerId: r.customer_id,
    customerNo: r.customer_no,
    customerName: r.customer_name,
    rep: repName(r),
    visitClass: r.visit_class,
    classIsDefault: r.class_is_default,
    state: !r.is_overdue ? "onTrack" : r.last_visit_on === null ? "never" : "overdue",
    overdueDays: r.overdue_days ?? 0,
    lastVisit: r.last_visit_on ? t("coverage.lastVisitValue", { date: day(r.last_visit_on), days: r.days_since_last_visit ?? 0 }) : t("coverage.never"),
    lastVisitOn: r.last_visit_on,
    actual: r.actual_visits,
    target: r.target_visits,
    pct: coveragePct(r),
    targetMet: r.target_met,
    nextPlanned: r.next_planned_on ? day(r.next_planned_on) : null,
    planHref: mayPlan && r.employee_id && !r.next_planned_on ? `/planning?employee=${r.employee_id}&customer=${r.customer_id}#add-visit` : null,
  }));

  return (
    <PageBody>
      <PageHeader
        title={t("coverage.title")}
        description={
          period ? t("coverage.subtitle", { month: format.dateTime(dayAsDate(period), MONTH_LONG) }) : t("coverage.subtitleNoPeriod")
        }
        actions={
          mayPlan ? (
            <Link href="/planning" className={buttonVariants({ variant: "outline" })}>
              <CalendarDaysIcon aria-hidden="true" />
              {t("week.title")}
            </Link>
          ) : null
        }
      />

      <CoverageTable
        rows={rows}
        rowCount={result.ok ? result.data.total : 0}
        canEdit={mayEdit}
        overdueOnly={filter === "overdue"}
        error={result.ok ? undefined : <Alert>{tErrors(result.error.messageKey, { requestId: result.error.requestId ?? "—" })}</Alert>}
        filters={
          <>
            <FilterChips
              label={t("coverage.filterLabel")}
              pathname="/planning/coverage"
              params={sp}
              param="show"
              current={filter === "overdue" ? null : filter}
              options={[
                { value: null, label: t("coverage.showOverdue") },
                { value: "all", label: t("coverage.showAll") },
              ]}
            />
            {employees.length > 1 ? (
              <UrlSelectFilter
                label={t("coverage.rep")}
                param="employee"
                options={[
                  { value: "", label: t("coverage.allReps") },
                  ...employees.map((e) => ({ value: e.id, label: localizedName(lang, e.full_name_en, e.full_name_ar) })),
                ]}
              />
            ) : null}
          </>
        }
      />
    </PageBody>
  );
}
