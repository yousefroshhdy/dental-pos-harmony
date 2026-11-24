"use client";

import { HistoryIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";

/**
 * One audit search result. `changes` (the folded diff) and `card` (the phone layout)
 * are server-rendered elements: the diff formatting and masking stay on the server.
 */
export interface AuditResultRow {
  id: string;
  action: "INSERT" | "UPDATE" | "DELETE";
  actionTone: "success" | "info" | "danger";
  tableLabel: string;
  tableRef: string;
  occurredAt: string;
  when: string;
  actor: string;
  recordId: string | null;
  historyHref: string | null;
  recordHref: string | null;
  changes: ReactNode;
  card: ReactNode;
}

/**
 * Audit search results. The audit RPC pages by keyset (older than an id), not by
 * count, so this table shows one page and the page's own "newer / older" links
 * do the paging (no total is computed over the whole log).
 */
export function AuditResultsTable({ rows, pageSize, error }: { rows: AuditResultRow[]; pageSize: number; error?: ReactNode }) {
  const t = useTranslations("audit");

  const columns: DataTableColumn<AuditResultRow>[] = [
    {
      id: "what",
      header: t("table.what"),
      primary: true,
      accessor: (r) => r.tableLabel,
      cell: (r) => (
        <span className="inline-flex flex-col gap-1">
          <span className="inline-flex flex-wrap items-center gap-2">
            <Badge tone={r.actionTone}>{t(`actions.${r.action}`)}</Badge>
            <span className="font-medium">{r.tableLabel}</span>
          </span>
          <code dir="ltr" className="text-xs text-muted-foreground">
            {r.tableRef}
          </code>
        </span>
      ),
    },
    {
      id: "when",
      header: t("table.when"),
      accessor: (r) => r.occurredAt,
      cell: (r) => (
        <time dateTime={r.occurredAt} className="whitespace-nowrap tabular-nums">
          {r.when}
        </time>
      ),
    },
    { id: "actor", header: t("table.actor"), accessor: (r) => r.actor },
    {
      id: "record",
      header: t("entry.record"),
      cell: (r) => (
        <span className="inline-flex flex-col">
          <code dir="ltr" className="max-w-48 truncate text-xs" title={r.recordId ?? undefined}>
            {r.recordId ?? t("entry.noRecordId")}
          </code>
          <span className="flex flex-wrap gap-x-3">
            {r.historyHref ? (
              <Link href={r.historyHref} prefetch={false} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
                {t("entry.history")}
              </Link>
            ) : null}
            {r.recordHref ? (
              <Link href={r.recordHref} prefetch={false} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
                {t("entry.openRecord")}
              </Link>
            ) : null}
          </span>
        </span>
      ),
    },
    { id: "changes", header: t("table.changes"), className: "min-w-64", cell: (r) => r.changes },
  ];

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      searchable={false}
      pageSize={pageSize}
      error={error}
      caption={t("list.heading")}
      mobileCard={(r) => r.card}
      empty={<EmptyState icon={<HistoryIcon aria-hidden="true" />} title={t("list.empty")} description={t("table.emptyHint")} />}
    />
  );
}
