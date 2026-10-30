import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { CheckInButton } from "@/modules/field/components/check-in-button";
import { CompleteTaskForm } from "@/modules/field/components/complete-task-form";
import { FieldError } from "@/modules/field/components/field-error";
import { BottomActions, Empty, Item, ItemList, PageBody, Section } from "@/modules/field/components/layout-bits";
import { CAIRO_DATE_TIME, CAIRO_TIME } from "@/modules/field/format";
import { canSeeToday, groupToday, priorityTone } from "@/modules/field/logic";
import { listMyToday } from "@/modules/field/queries";
import type { TodayItem } from "@/modules/field/types";
import { ShiftCard } from "@/modules/tracking/components/shift-card";
import { canStartShift } from "@/modules/tracking/logic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "field.today" });
  return { title: t("title") };
}

/**
 * The rep's home: today's planned visits, visits still open, and tasks /
 * follow-ups due today or overdue (api.v_my_today). Server-rendered; the only
 * client JS is the check-in button and the task completion form.
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

  const today = await listMyToday();

  const header = (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">
        {format.dateTime(now, { dateStyle: "full", timeZone: "Africa/Cairo", numberingSystem: "latn" })}
      </p>
    </div>
  );

  if (!today.ok) {
    return (
      <PageBody>
        {header}
        <FieldError code={today.error.code} messageKey={today.error.messageKey} requestId={today.error.requestId} />
      </PageBody>
    );
  }

  const groups = groupToday(today.data);
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

  return (
    <PageBody>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        {header}
        {mayCheckIn ? (
          <BottomActions label={t("actions")}>
            <Link href="/visits/new" className={buttonVariants({ variant: "outline" })}>
              {t("unplanned")}
            </Link>
          </BottomActions>
        ) : null}
      </div>

      {canStartShift(ctx) && ctx.user_id && ctx.employee ? <ShiftCard userId={ctx.user_id} employeeId={ctx.employee.id} /> : null}

      {nothing ? <Empty>{t("allClear")}</Empty> : null}

      {groups.inProgress.length > 0 ? (
        <Section title={t("inProgress")} count={groups.inProgress.length}>
          <ItemList>
            {groups.inProgress.map((item) => (
              <Item key={item.item_id}>
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

      {mayCheckIn || groups.planned.length > 0 ? (
        <Section title={t("planned")} count={groups.planned.length}>
          {groups.planned.length === 0 ? (
            <Empty>{t("noPlanned")}</Empty>
          ) : (
            <ItemList>
              {groups.planned.map((item) => (
                <Item key={item.item_id}>
                  <p className="font-medium break-words">{item.customer_name ?? item.title}</p>
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
      ) : null}

      <Section title={t("followUps")} count={groups.followUps.length}>
        {groups.followUps.length === 0 ? <Empty>{t("noFollowUps")}</Empty> : <ItemList>{groups.followUps.map(taskItem)}</ItemList>}
      </Section>

      <Section title={t("tasks")} count={groups.tasks.length}>
        {groups.tasks.length === 0 ? <Empty>{t("noTasks")}</Empty> : <ItemList>{groups.tasks.map(taskItem)}</ItemList>}
      </Section>

      <p className="text-sm">
        {can(ctx, "work.task.read") ? (
          <Link href="/tasks" className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
            {t("allTasks")}
          </Link>
        ) : null}{" "}
        {mayCheckIn ? (
          <Link href="/visits/privacy" className="inline-flex min-h-11 items-center px-2 text-primary underline-offset-4 hover:underline">
            {t("privacy")}
          </Link>
        ) : null}
      </p>
    </PageBody>
  );
}
