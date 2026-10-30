import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, Badge, Card, CardTitle, Label, Select } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { BottomActions, Empty, PageBody } from "@/modules/field/components/layout-bits";
import { localizedName } from "@/modules/field/logic";
import { AddVisitForm } from "@/modules/planning/components/add-visit-form";
import { UnplanButton } from "@/modules/planning/components/unplan-button";
import { DAY_MEDIUM, DAY_SHORT, dayAsDate } from "@/modules/planning/format";
import {
  addDays,
  canPlan,
  defaultPlanDay,
  groupByDay,
  monthOf,
  parseDay,
  pickEmployee,
  planningErrorCode,
  sortEmployees,
  visibleDays,
  weekDayName,
  weekStartOf,
} from "@/modules/planning/logic";
import { getPlanningSettings, listPlan, listPlanningCustomers, listPlanningEmployees } from "@/modules/planning/queries";
import type { PlanRow } from "@/modules/planning/types";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "planning.week" });
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const STATUS_TONE = { planned: "info", in_progress: "warning", completed: "success", missed: "danger" } as const;

/**
 * The week plan (api.v_visit_plan) for me, or for a team member when I plan for a team
 * (api.v_planning_employees). Add a visit (api.plan_visits) or remove a planned one
 * (api.unplan_visit); Postgres re-checks scope, assignment and dates on every change.
 */
export default async function PlanningWeekPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: SearchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canPlan(ctx)) return <Forbidden />;

  const sp = await searchParams;
  const t = await getTranslations("planning");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();
  const lang = await getLocale();

  const [settingsResult, employeesResult] = await Promise.all([getPlanningSettings(), listPlanningEmployees()]);
  const loadError = !settingsResult.ok ? settingsResult.error : !employeesResult.ok ? employeesResult.error : null;
  if (loadError || !settingsResult.ok || !employeesResult.ok) {
    const own = planningErrorCode(loadError?.code);
    return (
      <PageBody>
        <h1 className="text-2xl font-semibold">{t("week.title")}</h1>
        <Alert>{own ? t(`errors.${own}`) : tErrors(loadError?.messageKey ?? "UNKNOWN", { requestId: loadError?.requestId ?? "—" })}</Alert>
      </PageBody>
    );
  }

  const settings = settingsResult.data;
  const today = settings.today;
  const employees = sortEmployees(employeesResult.data, lang);
  const employee = pickEmployee(employees, sp.employee);
  if (!employee) {
    return (
      <PageBody>
        <h1 className="text-2xl font-semibold">{t("week.title")}</h1>
        <Empty>{t("errors.NO_EMPLOYEE_PROFILE")}</Empty>
      </PageBody>
    );
  }

  const week = weekStartOf(parseDay(sp.week) ?? today);
  const weekEnd = addDays(week, 6);
  const [planResult, customersResult] = await Promise.all([listPlan(employee.id, week, weekEnd), listPlanningCustomers(employee.id)]);
  const rows = planResult.ok ? planResult.data : [];
  const byDay = groupByDay(rows, lang);
  const days = visibleDays(week, settings.work_days, rows);
  const employeeName = localizedName(lang, employee.full_name_en, employee.full_name_ar);
  const query = `employee=${employee.id}`;
  const weekHref = (d: string) => `/planning?${query}&week=${d}`;
  const generateMonth = monthOf(week >= today ? week : today);
  const customers = customersResult.ok
    ? customersResult.data.map((c) => ({ id: c.customer_id, label: `${c.customer_name} (${c.customer_no})`, visitClass: c.visit_class }))
    : [];
  const preselect = typeof sp.customer === "string" ? sp.customer : undefined;

  const statusBadge = (r: PlanRow) => {
    const status = r.is_missed ? "missed" : r.status;
    return <Badge tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Badge>;
  };

  return (
    <PageBody>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("week.title")}</h1>
        <p className="text-sm text-muted-foreground">{employee.is_me ? t("week.subtitleMine") : t("week.subtitleFor", { name: employeeName })}</p>
      </div>

      {employees.length > 1 ? (
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="week" value={week} />
          <div className="min-w-0 flex-1 space-y-1 sm:flex-none">
            <Label htmlFor="planning-employee">{t("week.employee")}</Label>
            <Select id="planning-employee" name="employee" defaultValue={employee.id} className="w-full sm:w-72">
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.is_me ? t("week.me", { name: localizedName(lang, e.full_name_en, e.full_name_ar) }) : localizedName(lang, e.full_name_en, e.full_name_ar)}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="outline">
            {t("week.show")}
          </Button>
        </form>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">
          {t("week.range", { from: format.dateTime(dayAsDate(week), DAY_MEDIUM), to: format.dateTime(dayAsDate(weekEnd), DAY_MEDIUM) })}
        </h2>
        <nav aria-label={t("week.navLabel")} className="flex flex-wrap gap-2">
          <Link href={weekHref(addDays(week, -7))} className={buttonVariants({ variant: "outline" })}>
            {t("week.prev")}
          </Link>
          {week !== weekStartOf(today) ? (
            <Link href={weekHref(weekStartOf(today))} className={buttonVariants({ variant: "outline" })}>
              {t("week.thisWeek")}
            </Link>
          ) : null}
          <Link href={weekHref(addDays(week, 7))} className={buttonVariants({ variant: "outline" })}>
            {t("week.next")}
          </Link>
        </nav>
      </div>

      {!planResult.ok ? (
        <Alert>{tErrors(planResult.error.messageKey, { requestId: planResult.error.requestId ?? "—" })}</Alert>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t("week.total", { count: rows.length })}</p>
          <ul className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
            {days.map((day) => {
              const items = byDay.get(day) ?? [];
              const isWorkDay = settings.work_days.includes(weekDayName(day));
              return (
                <li
                  key={day}
                  aria-label={format.dateTime(dayAsDate(day), DAY_SHORT)}
                  className={cn("space-y-3 rounded-lg border bg-card p-4 shadow-sm", day === today && "border-primary", day < today && "opacity-80")}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-semibold">
                      {format.dateTime(dayAsDate(day), DAY_SHORT)}
                      {day === today ? <span className="ms-2 text-xs font-normal text-primary">{t("week.today")}</span> : null}
                    </h3>
                    <span className={cn("text-xs text-muted-foreground", items.length > settings.daily_cap && "font-medium text-destructive")}>
                      {t("week.dayCount", { count: items.length, cap: settings.daily_cap })}
                    </span>
                  </div>
                  {!isWorkDay ? <p className="text-xs text-muted-foreground">{t("week.dayOff")}</p> : null}
                  {items.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("week.noVisits")}</p>
                  ) : (
                    <ul className="space-y-2">
                      {items.map((r) => (
                        <li key={r.id} className="space-y-2 rounded-md border p-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{r.customer_name ?? t("week.unknownCustomer")}</p>
                              <p className="text-xs text-muted-foreground">{r.customer_no}</p>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              <Badge>{t(`class.${r.visit_class}`)}</Badge>
                              {statusBadge(r)}
                            </div>
                          </div>
                          {r.can_unplan ? <UnplanButton visitId={r.id} customerName={r.customer_name ?? r.customer_no ?? ""} /> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <Card id="add-visit" className="scroll-mt-20 space-y-3">
        <CardTitle>{t("add.title")}</CardTitle>
        {!customersResult.ok ? (
          <Alert>{tErrors(customersResult.error.messageKey, { requestId: customersResult.error.requestId ?? "—" })}</Alert>
        ) : (
          <AddVisitForm
            key={`${employee.id}-${week}`}
            employeeId={employee.id}
            customers={customers}
            defaultDate={defaultPlanDay(week, today, settings.work_days)}
            minDate={today}
            defaultCustomerId={preselect}
          />
        )}
      </Card>

      <BottomActions label={t("week.actions")}>
        {/* A same-page anchor: a plain <a>, not the locale-prefixing Link. */}
        <a href="#add-visit" className={buttonVariants({ variant: "outline" })}>
          {t("week.addVisit")}
        </a>
        <Link href={`/planning/generate?${query}&month=${generateMonth}`} className={buttonVariants()}>
          {t("week.generate")}
        </Link>
      </BottomActions>
    </PageBody>
  );
}
