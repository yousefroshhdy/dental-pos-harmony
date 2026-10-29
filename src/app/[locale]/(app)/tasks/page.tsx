import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { CompleteTaskForm } from "@/modules/field/components/complete-task-form";
import { CreateTaskForm } from "@/modules/field/components/create-task-form";
import { FieldError } from "@/modules/field/components/field-error";
import { chipClass, Empty, Item, ItemList, PageBody } from "@/modules/field/components/layout-bits";
import { CAIRO_DATE_TIME } from "@/modules/field/format";
import {
  canCompleteTask,
  canSeeOthersTasks,
  localizedName,
  parseTaskFilters,
  priorityTone,
  taskFilterHref,
  taskTone,
  toCairoLocalInput,
} from "@/modules/field/logic";
import { getCustomer, LIST_LIMIT, listTasks } from "@/modules/field/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "field.tasks" });
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function TasksPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: SearchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "work.task.read")) return <Forbidden />;

  const sp = await searchParams;
  const parsed = parseTaskFilters(sp);
  const othersVisible = canSeeOthersTasks(ctx);
  const filters = othersVisible ? parsed : { ...parsed, who: "mine" as const };
  const mayCreate = can(ctx, "work.task.manage") && ctx.employee !== null;

  const customerParam = first(sp.customer);
  const customerId = mayCreate && customerParam && z.guid().safeParse(customerParam).success ? customerParam : null;

  const t = await getTranslations("field.tasks");
  const tKind = await getTranslations("field.taskKind");
  const tPriority = await getTranslations("field.priority");
  const tStatus = await getTranslations("field.taskStatus");
  const format = await getFormatter();
  const now = new Date();

  const [tasks, customer] = await Promise.all([
    listTasks(filters, ctx.employee?.id ?? null, now),
    customerId ? getCustomer(customerId) : Promise.resolve(null),
  ]);
  const prefill = customer?.ok && customer.data ? { id: customer.data.id, name: customer.data.display_name } : null;
  // Default due time: one hour from now, Cairo wall clock.
  const defaultDue = toCairoLocalInput(new Date(now.getTime() + 3600_000));

  const chip = (label: string, change: Parameters<typeof taskFilterHref>[1], active: boolean) => (
    <Link href={taskFilterHref(filters, change)} className={chipClass(active)} aria-current={active ? "page" : undefined}>
      {label}
    </Link>
  );

  return (
    <PageBody>
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      {mayCreate ? (
        <Card className="p-0 sm:p-0">
          <details id="new-task" open={prefill !== null} className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center px-4 py-3 font-medium select-none [&::-webkit-details-marker]:hidden">
              <CardTitle className="text-base">{t("new")}</CardTitle>
            </summary>
            <div className="border-t p-4">
              <CreateTaskForm defaultDueLocal={defaultDue} customer={prefill} />
            </div>
          </details>
        </Card>
      ) : null}

      <nav aria-label={t("filters")} className="space-y-2">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {othersVisible ? chip(t("mine"), { who: "mine" }, filters.who === "mine") : null}
          {othersVisible ? chip(t("everyone"), { who: "all" }, filters.who === "all") : null}
          {chip(t("open"), { status: "open" }, filters.status === "open")}
          {chip(t("done"), { status: "done", due: filters.due === "overdue" ? "any" : filters.due }, filters.status === "done")}
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {chip(t("anyDue"), { due: "any" }, filters.due === "any")}
          {chip(t("dueToday"), { due: "today" }, filters.due === "today")}
          {filters.status === "open" ? chip(t("overdue"), { due: "overdue" }, filters.due === "overdue") : null}
        </div>
      </nav>

      {!tasks.ok ? (
        <FieldError code={tasks.error.code} messageKey={tasks.error.messageKey} requestId={tasks.error.requestId} />
      ) : tasks.data.length === 0 ? (
        <Empty>{t("empty")}</Empty>
      ) : (
        <>
          <ItemList>
            {tasks.data.map((task) => {
              const assignee = localizedName(locale, task.assignee_name_en, task.assignee_name_ar);
              const others = task.assignee_employee_id !== ctx.employee?.id;
              return (
                <Item key={task.id}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium break-words">{task.title}</p>
                      {task.customer_name ? <p className="text-sm text-muted-foreground break-words">{task.customer_name}</p> : null}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={taskTone(task)}>{task.status === "open" && task.is_overdue ? t("overdue") : tStatus(task.status)}</Badge>
                      {task.priority !== "normal" ? <Badge tone={priorityTone(task.priority)}>{tPriority(task.priority)}</Badge> : null}
                      <Badge>{tKind(task.kind)}</Badge>
                    </div>
                  </div>
                  <p className="text-sm">
                    {task.status === "done" && task.completed_at
                      ? t("completedAt", { when: format.dateTime(new Date(task.completed_at), CAIRO_DATE_TIME) })
                      : t("dueAt", { when: format.dateTime(new Date(task.due_at), CAIRO_DATE_TIME) })}
                    {others && assignee ? <span className="text-muted-foreground">{` · ${assignee}`}</span> : null}
                  </p>
                  {task.outcome ? <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">{task.outcome}</p> : null}
                  {canCompleteTask(ctx, task) ? <CompleteTaskForm taskId={task.id} title={task.title} /> : null}
                </Item>
              );
            })}
          </ItemList>
          {tasks.data.length >= LIST_LIMIT ? <p className="text-sm text-muted-foreground">{t("limited", { limit: LIST_LIMIT })}</p> : null}
        </>
      )}
    </PageBody>
  );
}
