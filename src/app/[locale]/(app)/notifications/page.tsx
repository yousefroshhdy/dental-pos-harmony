import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { FilterChips } from "@/components/page-kit/filter-chips";
import { readTableParams } from "@/components/ui/data-table-params";
import { PageHeader } from "@/components/ui/page-header";
import { ApprovalErrorMessage } from "@/modules/approvals/components/action-message";
import { MarkAllReadForm } from "@/modules/approvals/components/mark-read-form";
import { NotificationsTable, type NotificationListRow } from "@/modules/approvals/components/notifications-table";
import { workflowLabel } from "@/modules/approvals/components/request-view";
import { CAIRO_DATE_TIME } from "@/modules/approvals/format";
import { errorKeyFor, notificationKind, safeInternalHref } from "@/modules/approvals/logic";
import { countUnreadNotifications, listNotificationsPage } from "@/modules/approvals/queries";
import { parseNotificationFilter } from "@/modules/approvals/schemas";
import { NOTIFICATIONS_TABLE } from "@/modules/approvals/tables";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "approvals.notifications" });
  return { title: t("title") };
}

const FILTERS = ["all", "unread"] as const;

/** The signed-in user's in-app notifications (api.v_notifications only ever returns the caller's own). */
export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const filter = parseNotificationFilter(sp.filter);
  const table = readTableParams(sp, NOTIFICATIONS_TABLE);

  const t = await getTranslations("approvals");
  const format = await getFormatter();
  const [page, unread] = await Promise.all([
    listNotificationsPage(filter, { offset: table.offset, pageSize: table.pageSize, desc: table.sorting[0]?.desc ?? true, search: table.search }),
    countUnreadNotifications(),
  ]);
  const unreadCount = unread.ok ? unread.data : null;

  const rows: NotificationListRow[] = (page.ok ? page.data.rows : []).map((n) => {
    const kind = notificationKind(n);
    const data = n.data ?? {};
    const workflow = typeof data.workflow === "string" ? workflowLabel(t, data.workflow, data.workflow) : "";
    const orderNo = typeof data.order_no === "string" ? data.order_no : "";
    return {
      id: n.id,
      title: kind ? t(`notifications.types.${kind}`, { workflow, orderNo }) : n.title,
      body: n.body,
      href: safeInternalHref(n.link),
      unread: n.read_at === null,
      createdAt: n.created_at,
      when: format.dateTime(new Date(n.created_at), CAIRO_DATE_TIME),
    };
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={t("notifications.title")}
        description={
          unreadCount !== null ? <span aria-live="polite">{t("notifications.unreadCount", { count: unreadCount })}</span> : undefined
        }
        actions={unreadCount ? <MarkAllReadForm /> : null}
      />

      <NotificationsTable
        key={filter}
        filter={filter}
        rows={rows}
        rowCount={page.ok ? page.data.total : 0}
        error={page.ok ? undefined : <ApprovalErrorMessage messageKey={errorKeyFor(page.error)} requestId={page.error.requestId} />}
        filters={
          <FilterChips
            label={t("notifications.filterLabel")}
            pathname="/notifications"
            params={sp}
            param="filter"
            current={filter === "all" ? null : filter}
            options={FILTERS.map((key) => ({
              value: key === "all" ? null : key,
              label: t(`notifications.filters.${key}`),
              count: key === "unread" && unreadCount !== null ? unreadCount : undefined,
            }))}
          />
        }
      />
    </div>
  );
}
