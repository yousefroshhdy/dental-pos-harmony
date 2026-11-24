"use client";

import { InboxIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { UrlDataTable } from "@/components/page-kit/url-data-table";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { INBOX_TABLE } from "../tables";
import type { InboxTab, RequestStatus } from "../types";

/** One inbox row, with every text already formatted on the server (facts, money, waiting time). */
export interface InboxRow {
  id: string;
  title: string;
  workflow: string;
  requester: string;
  /** "Stage 1 of 2" while pending. */
  stage: string | null;
  headline: { label: string; value: string } | null;
  status: RequestStatus;
  statusTone: BadgeTone;
  waiting: string | null;
  waitingSince: string;
  overdue: boolean;
  myDecision: { label: string; tone: BadgeTone } | null;
}

export function InboxTable({
  tab,
  rows,
  rowCount,
  filters,
  error,
}: {
  tab: InboxTab;
  rows: InboxRow[];
  rowCount: number;
  filters?: ReactNode;
  error?: ReactNode;
}) {
  const t = useTranslations("approvals");

  const columns: DataTableColumn<InboxRow>[] = [
    {
      id: "title",
      header: t("inboxTable.request"),
      primary: true,
      accessor: (r) => r.title,
      cell: (r) => <span className="break-words">{r.title}</span>,
    },
    { id: "workflow", header: t("inboxTable.workflow"), accessor: (r) => r.workflow },
    {
      id: "requester",
      header: t("inboxTable.requester"),
      accessor: (r) => r.requester,
      cell: (r) => (
        <span className="inline-flex flex-col">
          <span>{r.requester}</span>
          {r.stage ? <span className="text-xs text-muted-foreground">{r.stage}</span> : null}
        </span>
      ),
    },
    {
      id: "headline",
      header: t("inboxTable.keyFact"),
      cell: (r) =>
        r.headline ? (
          <span className="inline-flex flex-col">
            <span className="text-xs text-muted-foreground">{r.headline.label}</span>
            <span dir="ltr" className="font-medium tabular-nums">
              {r.headline.value}
            </span>
          </span>
        ) : (
          "—"
        ),
    },
    {
      id: "waiting",
      header: t("inboxTable.waiting"),
      sortable: true,
      accessor: (r) => r.waitingSince,
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className={cn(r.overdue ? "font-medium text-destructive" : "text-muted-foreground")}>{r.waiting ?? "—"}</span>
          {r.overdue ? <Badge tone="danger">{t("card.overdue")}</Badge> : null}
        </span>
      ),
    },
    {
      id: "status",
      header: t("inboxTable.status"),
      cell: (r) => (
        <span className="inline-flex flex-wrap gap-1">
          <Badge tone={r.statusTone}>{t(`status.${r.status}`)}</Badge>
          {r.myDecision ? <Badge tone={r.myDecision.tone}>{r.myDecision.label}</Badge> : null}
        </span>
      ),
    },
  ];

  return (
    <UrlDataTable
      options={INBOX_TABLE}
      rowCount={rowCount}
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      rowHref={(r) => `/approvals/${r.id}`}
      searchPlaceholder={t("inboxTable.search")}
      filters={filters}
      error={error}
      caption={t("inbox.title")}
      mobileCard={(r) => (
        <div className="space-y-1.5">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 font-medium break-words text-primary">{r.title}</p>
            <Badge tone={r.statusTone} className="shrink-0">
              {t(`status.${r.status}`)}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{r.workflow}</p>
          <p className="text-sm text-muted-foreground">
            {t("card.requestedBy", { name: r.requester })}
            {r.stage ? <> · {r.stage}</> : null}
          </p>
          {r.headline ? (
            <p className="text-sm">
              <span className="text-muted-foreground">{r.headline.label}: </span>
              <span dir="ltr" className="font-medium tabular-nums">
                {r.headline.value}
              </span>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={cn(r.overdue ? "font-medium text-destructive" : "text-muted-foreground")}>{r.waiting}</span>
            {r.overdue ? <Badge tone="danger">{t("card.overdue")}</Badge> : null}
            {r.myDecision ? <Badge tone={r.myDecision.tone}>{r.myDecision.label}</Badge> : null}
          </div>
        </div>
      )}
      empty={<EmptyState icon={<InboxIcon aria-hidden="true" />} title={t(`inbox.empty.${tab}`)} description={t(`inboxTable.emptyHint.${tab}`)} />}
    />
  );
}
