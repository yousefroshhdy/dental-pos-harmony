import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Badge, Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { ApprovalErrorMessage } from "@/modules/approvals/components/action-message";
import { MarkAllReadForm, MarkReadForm } from "@/modules/approvals/components/mark-read-form";
import { workflowLabel } from "@/modules/approvals/components/request-view";
import { CAIRO_DATE_TIME } from "@/modules/approvals/format";
import { errorKeyFor, notificationKind, safeInternalHref } from "@/modules/approvals/logic";
import { countUnreadNotifications, listNotifications } from "@/modules/approvals/queries";
import { parseNotificationFilter } from "@/modules/approvals/schemas";

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
  const filter = parseNotificationFilter((await searchParams).filter);

  const t = await getTranslations("approvals");
  const format = await getFormatter();
  const [rows, unread] = await Promise.all([listNotifications(filter), countUnreadNotifications()]);
  const unreadCount = unread.ok ? unread.data : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{t("notifications.title")}</h1>
          {unreadCount !== null ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t("notifications.unreadCount", { count: unreadCount })}
            </p>
          ) : null}
        </div>
        {unreadCount ? <MarkAllReadForm /> : null}
      </div>

      <nav aria-label={t("notifications.filterLabel")} className="flex gap-1 border-b">
        {FILTERS.map((key) => (
          <Link
            key={key}
            href={key === "all" ? "/notifications" : "/notifications?filter=unread"}
            aria-current={key === filter ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center border-b-2 px-3 text-sm whitespace-nowrap",
              key === filter ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`notifications.filters.${key}`)}
          </Link>
        ))}
      </nav>

      {!rows.ok ? (
        <ApprovalErrorMessage messageKey={errorKeyFor(rows.error)} requestId={rows.error.requestId} />
      ) : rows.data.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t(`notifications.empty.${filter}`)}</p>
      ) : (
        <ul className="space-y-3">
          {rows.data.map((n) => {
            const kind = notificationKind(n);
            const data = n.data ?? {};
            const workflow = typeof data.workflow === "string" ? workflowLabel(t, data.workflow, data.workflow) : "";
            const orderNo = typeof data.order_no === "string" ? data.order_no : "";
            const title = kind ? t(`notifications.types.${kind}`, { workflow, orderNo }) : n.title;
            const href = safeInternalHref(n.link);
            const isUnread = n.read_at === null;
            return (
              <li key={n.id}>
                <Card className={cn("space-y-2 p-4 sm:p-4", isUnread ? "border-primary/40" : "opacity-90")}>
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="min-w-0 font-medium break-words">
                      {href ? (
                        <Link href={href} className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">
                          {title}
                        </Link>
                      ) : (
                        title
                      )}
                    </h2>
                    {isUnread ? (
                      <Badge tone="info" className="shrink-0">
                        {t("notifications.new")}
                      </Badge>
                    ) : null}
                  </div>
                  {n.body ? <p className="text-sm break-words whitespace-pre-line">{n.body}</p> : null}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <time dateTime={n.created_at} className="text-xs text-muted-foreground">
                      {format.dateTime(new Date(n.created_at), CAIRO_DATE_TIME)}
                    </time>
                    {isUnread ? <MarkReadForm ids={[n.id]} label={t("notifications.markRead")} /> : null}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
