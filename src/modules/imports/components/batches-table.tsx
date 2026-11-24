"use client";

import { FileSpreadsheetIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { UrlDataTable } from "@/components/page-kit/url-data-table";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import type { ImportKind } from "../kinds";
import { BATCHES_TABLE } from "../tables";
import type { BatchStatus } from "../types";

export interface BatchListRow {
  id: string;
  kind: ImportKind;
  fileName: string | null;
  createdAt: string;
  when: string;
  by: string;
  rows: number;
  errors: number;
  status: BatchStatus;
  statusTone: BadgeTone;
}

export function BatchesTable({ rows, rowCount, filters, error }: { rows: BatchListRow[]; rowCount: number; filters?: ReactNode; error?: ReactNode }) {
  const t = useTranslations("imports");

  const columns: DataTableColumn<BatchListRow>[] = [
    {
      id: "kind",
      header: t("table.kind"),
      primary: true,
      accessor: (r) => r.kind,
      cell: (r) => t(`kinds.${r.kind}.title`),
    },
    {
      id: "file",
      header: t("table.file"),
      accessor: (r) => r.fileName,
      cell: (r) => <span className="break-all">{r.fileName ?? t("history.fileUnnamed")}</span>,
    },
    {
      id: "created_at",
      header: t("table.when"),
      sortable: true,
      accessor: (r) => r.createdAt,
      cell: (r) => (
        <span className="inline-flex flex-col">
          <time dateTime={r.createdAt} className="whitespace-nowrap tabular-nums">
            {r.when}
          </time>
          <span className="text-xs text-muted-foreground">{r.by}</span>
        </span>
      ),
    },
    { id: "row_count", header: t("table.rows"), sortable: true, align: "end", accessor: (r) => r.rows },
    {
      id: "error_count",
      header: t("table.errors"),
      sortable: true,
      align: "end",
      accessor: (r) => r.errors,
      cell: (r) => <span className={r.errors > 0 ? "font-medium text-destructive tabular-nums" : "tabular-nums"}>{r.errors}</span>,
    },
    {
      id: "status",
      header: t("table.status"),
      accessor: (r) => r.status,
      cell: (r) => <Badge tone={r.statusTone}>{t(`status.${r.status}`)}</Badge>,
    },
  ];

  return (
    <UrlDataTable
      options={BATCHES_TABLE}
      rowCount={rowCount}
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      rowHref={(r) => `/imports/${r.id}`}
      searchPlaceholder={t("table.search")}
      filters={filters}
      error={error}
      caption={t("history.listLabel")}
      empty={<EmptyState icon={<FileSpreadsheetIcon aria-hidden="true" />} title={t("history.empty")} description={t("table.emptyHint")} />}
    />
  );
}
