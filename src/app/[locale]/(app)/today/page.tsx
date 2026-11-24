import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarCheckIcon, ChevronLeftIcon, MapPinIcon, MapPinnedIcon, PlusIcon, ShoppingCartIcon, SparklesIcon } from "lucide-react";
import { Forbidden } from "@/components/forbidden";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { CheckInButton } from "@/modules/field/components/check-in-button";
import { CompleteTaskForm } from "@/modules/field/components/complete-task-form";
import { FieldError } from "@/modules/field/components/field-error";
import { Item, ItemList, PageBody, Section } from "@/modules/field/components/layout-bits";
import { CAIRO_DATE_TIME, CAIRO_TIME } from "@/modules/field/format";
import { canSeeToday, groupToday, priorityTone, todayQuickActions, todaySummary, type TodayAction } from "@/modules/field/logic";
import { listMyToday } from "@/modules/field/queries";
import type { TodayItem } from "@/modules/field/types";
import { ShiftCard } from "@/modules/tracking/components/shift-card";
import { canStartShift } from "@/modules/tracking/logic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "field.today" });
  return { title: t("title") };
}

const ACTION_ICON = { checkIn: MapPinIcon, unplanned: PlusIcon, newOrder: ShoppingCartIcon } as const;
const linkClass = "inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline";

/**
 * The rep's home: shift, quick actions, visits in progress, today's plan, leads near me, and
 * tasks / follow-ups due today or overdue (api.v_my_today). Server-rendered; the only client
 * JS is the shift card, the check-in button and the task completion form.
 */
export default async function TodayPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canSeeToday(ctx)) return <Forbidden />;

  const t = await getTranslations("field.today");
  const tKind = await getTranslations("field.taskKind");
  const tPriority = await getTranslations("field.priority");
  const format = await getFormatter();
  const now = new Date();

  const mayCheckIn = can(ctx, "field.visit.create") && ctx.employee !== null;
  const mayRequestException = can(ctx, "field.visit_exception.request");
  const mayManageTasks = can(ctx, "work.task.manage");
  const mayOrder = can(ctx, "sales.order.create");
  // Same gate as the /leads entry of the field bottom bar (src/lib/nav.ts).
  const mayLeads = can(ctx, "crm.lead.read");

  const today = await listMyToday();
  const dateLine = format.dateTime(now, { dateStyle: "full", timeZone: "Africa/Cairo", numberingSystem: "latn" });

  if (!today.ok) {
    return (
      <PageBody>
        <PageHeader title={t("title")} description={dateLine} />
        <FieldError code={today.error.code} messageKey={today.error.messageKey} requestId={today.error.requestId} />
      </PageBody>
    );
  }

  const groups = groupToday(today.data);
  const summary = todaySummary(groups);
  const actions = todayQuickActions({ mayCheckIn, mayOrder, groups });
  const nothing = today.data.length === 0;

  const taskItem = (item: TodayItem) => (
    <Item key={item.item_id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="font-medium break-words">{item.title}</p>
          {item.customer_name ? <p className="text-sm text-muted-foreground break-words">{item.customer_name}</p> : null}
        </div>
        <div className="flex flex-wrap gap-1">
          {item.is_overdue ? <Badge tone="danger">{t("overdue")}</Badge> : null}
          {item.priority && item.priority !== "normal" ? <Badge tone={priorityTone(item.priority)}>{tPriority(item.priority)}</Badge> : null}
          {item.kind && item.kind !== "follow_up" ? <Badge>{tKind(item.kind)}</Badge> : null}
        </div>
      </div>
      {item.due_at ? (
        <p className="text-sm">
          {t("due", { when: format.dateTime(new Date(item.due_at), item.is_overdue ? CAIRO_DATE_TIME : CAIRO_TIME) })}
        </p>
      ) : null}
      {mayManageTasks ? <CompleteTaskForm taskId={item.item_id} title={item.title} /> : null}
    </Item>
  );

  const actionLabel = (a: TodayAction) => (a.key === "checkIn" ? t("checkIn") : a.key === "unplanned" ? t("unplanned") : t("newOrder"));

  return (
    <PageBody>
      <PageHeader
        title={t("title")}
        description={
          <>
            <span className="block">{dateLine}</span>
            <span className="block">
              {t("summary", { planned: summary.planned, due: summary.due })}
              {summary.overdue > 0 ? (
                <>
                  {" · "}
                  <span className="font-medium text-destructive">{t("overdueCount", { count: summary.overdue })}</span>
                </>
              ) : null}
            </span>
          </>
        }
      />

      {actions.length > 0 ? (
        <nav aria-label={t("quick")}>
          <ul className={cn("grid gap-2", actions.length === 3 ? "grid-cols-3" : actions.length === 2 ? "grid-cols-2" : "grid-cols-1")}>
            {actions.map((a, i) => {
              const Icon = ACTION_ICON[a.key];
              return (
                <li key={a.key}>
                  <Link
                    href={a.href}
                    className={buttonVariants({
                      variant: i === 0 ? "default" : "outline",
                      className: "h-auto min-h-16 w-full flex-col gap-1 px-2 py-2 text-center whitespace-normal",
                    })}
                  >
                    <Icon aria-hidden="true" className="size-5" />
                    <span className="text-xs leading-tight sm:text-sm">{actionLabel(a)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}

      {canStartShift(ctx) && ctx.user_id && ctx.employee ? <ShiftCard userId={ctx.user_id} employeeId={ctx.employee.id} /> : null}

      {groups.inProgress.length > 0 ? (
        <Section title={t("inProgress")} count={groups.inProgress.length}>
          <ItemList>
            {groups.inProgress.map((item) => (
              <Item key={item.item_id} className="border-primary/40 bg-primary/5">
                <div className="space-y-1">
                  <p className="font-medium break-words">{item.customer_name ?? item.title}</p>
                  {item.due_at ? (
                    <p className="text-sm text-muted-foreground">
                      {t("checkedInAt", { when: format.dateTime(new Date(item.due_at), CAIRO_TIME) })}
                    </p>
                  ) : null}
                </div>
                <Link href={`/visits/${item.item_id}`} className={buttonVariants({ className: "w-full sm:w-auto" })}>
                  {t("checkOut")}
                </Link>
              </Item>
            ))}
          </ItemList>
        </Section>
      ) : null}

      {nothing ? (
        <EmptyState
          icon={<CalendarCheckIcon aria-hidden="true" />}
          title={t("allClear")}
          description={mayCheckIn ? t("allClearBody") : undefined}
        />
      ) : null}

      {mayCheckIn || groups.planned.length > 0 ? (
        <div id="plan" className="scroll-mt-20">
          <Section title={t("plan")} count={groups.planned.length}>
            {groups.planned.length === 0 ? (
              <EmptyState
                compact
                icon={<MapPinnedIcon aria-hidden="true" />}
                title={t("noPlanned")}
                action={
                  mayCheckIn ? (
                    <Link href="/visits/new" className={buttonVariants({ variant: "outline" })}>
                      {t("unplanned")}
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <ItemList>
                {groups.planned.map((item) => (
                  <Item key={item.item_id}>
                    {item.customer_id ? (
                      <Link href={`/customers/${item.customer_id}`} className="inline-flex min-h-11 items-center font-medium break-words underline-offset-4 hover:underline">
                        {item.customer_name ?? item.title}
                      </Link>
                    ) : (
                      <p className="font-medium break-words">{item.customer_name ?? item.title}</p>
                    )}
                    {mayCheckIn && item.customer_id && ctx.user_id ? (
                      <CheckInButton
                        visitId={item.item_id}
                        customerId={item.customer_id}
                        customerName={item.customer_name ?? item.title}
                        userId={ctx.user_id}
                        mayRequestException={mayRequestException}
                        size="lg"
                      />
                    ) : null}
                  </Item>
                ))}
              </ItemList>
            )}
          </Section>
        </div>
      ) : null}

      {mayLeads ? (
        <Card className="flex items-center gap-3 p-4 sm:p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
            <SparklesIcon aria-hidden="true" className="size-5" />
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <h2 className="font-semibold">{t("leadsTitle")}</h2>
            <p className="text-sm text-muted-foreground">{t("leadsBody")}</p>
          </div>
          <Link href="/leads" className={buttonVariants({ variant: "outline", size: "icon" })} aria-label={t("leadsOpen")}>
            <ChevronLeftIcon aria-hidden="true" className="ltr:rotate-180" />
          </Link>
        </Card>
      ) : null}

      <Section title={t("followUps")} count={groups.followUps.length}>
        {groups.followUps.length === 0 ? (
          <EmptyState compact title={t("noFollowUps")} />
        ) : (
          <ItemList>{groups.followUps.map(taskItem)}</ItemList>
        )}
      </Section>

      <Section title={t("tasks")} count={groups.tasks.length}>
        {groups.tasks.length === 0 ? <EmptyState compact title={t("noTasks")} /> : <ItemList>{groups.tasks.map(taskItem)}</ItemList>}
      </Section>

      <p className="flex flex-wrap gap-x-4 text-sm">
        {can(ctx, "work.task.read") ? (
          <Link href="/tasks" className={linkClass}>
            {t("allTasks")}
          </Link>
        ) : null}
        {mayCheckIn ? (
          <Link href="/visits/privacy" className={linkClass}>
            {t("privacy")}
          </Link>
        ) : null}
      </p>
    </PageBody>
  );
}
