import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, Badge, Input, Label, Select } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { Empty, Item, ItemList, PageBody, Section } from "@/modules/field/components/layout-bits";
import { localizedName } from "@/modules/field/logic";
import { PlanReviewForm, type ReviewDay } from "@/modules/planning/components/plan-review-form";
import { DAY_MEDIUM, DAY_SHORT, MONTH_LONG, dayAsDate } from "@/modules/planning/format";
import { canPlan, groupProposals, monthOf, parseMonth, pickEmployee, planningErrorCode, proposalValue, sortEmployees } from "@/modules/planning/logic";
import { generatePlan, getPlanningSettings, listPlanningEmployees } from "@/modules/planning/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "planning.generate" });
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * "Generate month plan": api.generate_plan proposes visits from each customer's frequency and
 * last visit, spread over the working days under the daily cap. Nothing is written until the
 * reviewed (checked) proposals are saved with api.plan_visits.
 */
export default async function GeneratePlanPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: SearchParams }) {
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
  if (!settingsResult.ok || !employeesResult.ok) {
    const error = !settingsResult.ok ? settingsResult.error : !employeesResult.ok ? employeesResult.error : null;
    return (
      <PageBody>
        <h1 className="text-2xl font-semibold">{t("generate.title")}</h1>
        <Alert>{tErrors(error?.messageKey ?? "UNKNOWN", { requestId: error?.requestId ?? "—" })}</Alert>
      </PageBody>
    );
  }

  const today = settingsResult.data.today;
  const employees = sortEmployees(employeesResult.data, lang);
  const employee = pickEmployee(employees, sp.employee);
  if (!employee) {
    return (
      <PageBody>
        <h1 className="text-2xl font-semibold">{t("generate.title")}</h1>
        <Empty>{t("errors.NO_EMPLOYEE_PROFILE")}</Empty>
      </PageBody>
    );
  }

  const month = parseMonth(sp.month) ?? `${monthOf(today)}-01`;
  const result = await generatePlan(employee.id, month);
  const query = `employee=${employee.id}`;
  const employeeName = localizedName(lang, employee.full_name_en, employee.full_name_ar);
  const day = (d: string, f: typeof DAY_SHORT | typeof DAY_MEDIUM = DAY_MEDIUM) => format.dateTime(dayAsDate(d), f);

  let review: ReviewDay[] = [];
  if (result.ok) {
    const plan = result.data;
    const loads = new Map(plan.days.map((d) => [d.date, d]));
    review = groupProposals(plan.proposals).map(({ date, items }) => ({
      date,
      label: day(date, DAY_SHORT),
      load: t("generate.dayLoad", { existing: loads.get(date)?.existing ?? 0, proposed: items.length, cap: plan.daily_cap }),
      items: items.map((p) => ({
        value: proposalValue(p),
        title: `${p.customer_name} (${p.customer_no})`,
        detail:
          p.reason === "never_visited"
            ? t("generate.reason.never_visited")
            : t(`generate.reason.${p.reason}`, { date: p.last_visit_on ? day(p.last_visit_on) : "—", due: day(p.due_on) }),
        classLabel: t(`class.${p.visit_class}`),
      })),
    }));
  }

  return (
    <PageBody>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("generate.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("generate.subtitle")}</p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2">
        {employees.length > 1 ? (
          <div className="min-w-0 flex-1 space-y-1 sm:flex-none">
            <Label htmlFor="generate-employee">{t("week.employee")}</Label>
            <Select id="generate-employee" name="employee" defaultValue={employee.id} className="w-full sm:w-72">
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.is_me ? t("week.me", { name: localizedName(lang, e.full_name_en, e.full_name_ar) }) : localizedName(lang, e.full_name_en, e.full_name_ar)}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <input type="hidden" name="employee" value={employee.id} />
        )}
        <div className="space-y-1">
          <Label htmlFor="generate-month">{t("generate.month")}</Label>
          <Input id="generate-month" name="month" type="month" required min={monthOf(today)} defaultValue={monthOf(month)} className="w-auto" />
        </div>
        <Button type="submit" variant="outline">
          {t("generate.run")}
        </Button>
      </form>

      <h2 className="text-lg font-semibold">
        {t("generate.heading", { month: format.dateTime(dayAsDate(month), MONTH_LONG), name: employeeName })}
      </h2>

      {!result.ok ? (
        <Alert>
          {planningErrorCode(result.error.code)
            ? t(`errors.${planningErrorCode(result.error.code)}`)
            : tErrors(result.error.messageKey, { requestId: result.error.requestId ?? "—" })}
        </Alert>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t("generate.summary", {
              proposals: result.data.proposals.length,
              customers: result.data.customers,
              cap: result.data.daily_cap,
              from: day(result.data.from),
              to: day(result.data.to),
            })}
          </p>
          {review.length === 0 ? (
            <Empty>{t("generate.empty")}</Empty>
          ) : (
            <PlanReviewForm employeeId={employee.id} employeeQuery={query} days={review} />
          )}

          {result.data.unscheduled.length > 0 ? (
            <Section title={t("generate.unscheduledTitle")} count={result.data.unscheduled.length}>
              <p className="text-sm text-muted-foreground">{t("generate.unscheduledBody", { cap: result.data.daily_cap })}</p>
              <ItemList>
                {result.data.unscheduled.map((u) => (
                  <Item key={`${u.customer_id}-${u.due_on}`} className="flex flex-wrap items-center justify-between gap-2 space-y-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {u.customer_name} ({u.customer_no})
                      </p>
                      <p className="text-xs text-muted-foreground">{t("generate.dueOn", { date: day(u.due_on) })}</p>
                    </div>
                    <Badge tone="warning">{t(`class.${u.visit_class}`)}</Badge>
                  </Item>
                ))}
              </ItemList>
            </Section>
          ) : null}
        </>
      )}

      <Link href={`/planning?${query}`} className={buttonVariants({ variant: "link" })}>
        {t("generate.back")}
      </Link>
    </PageBody>
  );
}
