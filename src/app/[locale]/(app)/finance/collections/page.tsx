import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { FilterLinks } from "@/modules/finance/components/bits";
import { CollectionTaskForm } from "@/modules/finance/components/collection-form";
import { FinanceError } from "@/modules/finance/components/finance-error";
import { CAIRO_DATE, dateOnly } from "@/modules/finance/format";
import {
  cairoToday,
  canManageCollection,
  COLLECTION_FILTERS,
  collectionActions,
  collectionStatusTone,
  financeErrorCode,
  localizedName,
  parseCollectionFilter,
  toNumber,
  withQuery,
  type CollectionFilter,
} from "@/modules/finance/logic";
import { LIST_LIMIT, listCollectionTasks } from "@/modules/finance/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.collections" });
  return { title: t("title") };
}

const FILTERS = Object.keys(COLLECTION_FILTERS) as CollectionFilter[];

/**
 * Collection work: one task per overdue invoice (created by the nightly overdue scan),
 * promise-to-pay with a date, escalation and closing. Reps see the tasks assigned to them.
 */
export default async function CollectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "finance.collection.manage") && !can(ctx, "work.task.manage")) return <Forbidden />;

  const filter = parseCollectionFilter((await searchParams).status);
  const t = await getTranslations("finance");
  const format = await getFormatter();
  const money = (v: number | string | null) => format.number(toNumber(v), "egp");
  const tasks = await listCollectionTasks(filter);
  const today = cairoToday();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("collections.title")}</h1>
      <FilterLinks
        label={t("collections.filterLabel")}
        items={FILTERS.map((f) => ({
          key: f,
          href: withQuery("/finance/collections", { status: f === "active" ? null : f }),
          text: t(`collections.filters.${f}`),
          current: f === filter,
        }))}
      />

      {!tasks.ok ? (
        <FinanceError code={financeErrorCode(tasks.error)} requestId={tasks.error.requestId} />
      ) : tasks.data.length === 0 ? (
        <Card className="text-sm text-muted-foreground">{t("collections.empty")}</Card>
      ) : (
        <>
          <ul className="space-y-2">
            {tasks.data.map((task) => (
              <li key={task.id} className="space-y-2 rounded-lg border bg-card p-3 text-sm">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{task.customer_name ?? "—"}</span>
                      <Badge tone={collectionStatusTone(task.status, task.promise_broken)}>
                        {task.promise_broken ? t("collections.promiseBroken") : t(`collectionStatus.${task.status}`)}
                      </Badge>
                    </div>
                    {task.invoice_id ? (
                      <Link href={`/finance/invoices/${task.invoice_id}`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline" dir="ltr">
                        {task.invoice_no}
                      </Link>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {[
                        localizedName(locale, task.assignee_name_en, task.assignee_name_ar),
                        task.days_overdue !== null ? t("invoices.overdueDays", { count: task.days_overdue }) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {task.promised_date ? (
                      <p>
                        {t("collections.promise", {
                          date: format.dateTime(dateOnly(task.promised_date), CAIRO_DATE),
                          amount: task.promised_amount !== null ? money(task.promised_amount) : "—",
                        })}
                      </p>
                    ) : null}
                    {task.outcome ? <p className="text-muted-foreground">{task.outcome}</p> : null}
                  </div>
                  <span className="font-semibold whitespace-nowrap">{task.invoice_open_amount !== null ? money(task.invoice_open_amount) : ""}</span>
                </div>
                {canManageCollection(ctx, task) ? (
                  <CollectionTaskForm taskId={task.id} locale={locale} actions={collectionActions(task.status)} today={today} />
                ) : null}
              </li>
            ))}
          </ul>
          {tasks.data.length >= LIST_LIMIT ? <p className="text-sm text-muted-foreground">{t("limited", { count: LIST_LIMIT })}</p> : null}
        </>
      )}
    </div>
  );
}
