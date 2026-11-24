"use client";

import { BellIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { UrlDataTable } from "@/components/page-kit/url-data-table";
import { Badge } from "@/components/ui/badge";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { NOTIFICATIONS_TABLE } from "../tables";
import { MarkReadForm } from "./mark-read-form";

/** One notification, its title translated and its link checked (internal only) on the server. */
export interface NotificationListRow {
  id: string;
  title: string;
  body: string | null;
  /** Internal path or null (logic.safeInternalHref). */
  href: string | null;
  unread: boolean;
  createdAt: string;
  when: string;
}

export function NotificationsTable({
  rows,
  rowCount,
  filter,
  filters,
  error,
}: {
  rows: NotificationListRow[];
  rowCount: number;
  filter: "all" | "unread";
  filters?: ReactNode;
  error?: ReactNode;
}) {
  const t = useTranslations("approvals.notifications");

  const title = (r: NotificationListRow) =>
    r.href ? (
      <Link href={r.href} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline">
        {r.title}
      </Link>
    ) : (
      <span className="font-medium">{r.title}</span>
    );

  const columns: DataTableColumn<NotificationListRow>[] = [
    {
      id: "title",
      header: t("table.notification"),
      accessor: (r) => r.title,
      cell: (r) => (
        <span className="inline-flex max-w-xl flex-col gap-0.5">
          <span className="inline-flex flex-wrap items-center gap-2">
            {title(r)}
            {r.unread ? <Badge tone="info">{t("new")}</Badge> : null}
          </span>
          {r.body ? <span className="text-sm break-words whitespace-pre-line text-muted-foreground">{r.body}</span> : null}
        </span>
      ),
    },
    {
      id: "created_at",
      header: t("table.when"),
      sortable: true,
      accessor: (r) => r.createdAt,
      cell: (r) => (
        <time dateTime={r.createdAt} className="whitespace-nowrap text-muted-foreground tabular-nums">
          {r.when}
        </time>
      ),
    },
    {
      id: "actions",
      header: t("table.actions"),
      align: "end",
      cell: (r) => (r.unread ? <MarkReadForm ids={[r.id]} label={t("markRead")} /> : null),
    },
  ];

  return (
    <UrlDataTable
      options={NOTIFICATIONS_TABLE}
      rowCount={rowCount}
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      searchPlaceholder={t("table.search")}
      filters={filters}
      error={error}
      caption={t("title")}
      mobileCard={(r) => (
        <div className={cn("space-y-2", !r.unread && "opacity-90")}>
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 break-words">{title(r)}</p>
            {r.unread ? (
              <Badge tone="info" className="shrink-0">
                {t("new")}
              </Badge>
            ) : null}
          </div>
          {r.body ? <p className="text-sm break-words whitespace-pre-line">{r.body}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <time dateTime={r.createdAt} className="text-xs text-muted-foreground tabular-nums">
              {r.when}
            </time>
            {r.unread ? <MarkReadForm ids={[r.id]} label={t("markRead")} /> : null}
          </div>
        </div>
      )}
      empty={<EmptyState icon={<BellIcon aria-hidden="true" />} title={t(`empty.${filter}`)} />}
    />
  );
}
