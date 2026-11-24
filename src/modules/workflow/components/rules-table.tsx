"use client";

import { WorkflowIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";

export interface DefinitionListRow {
  id: string;
  code: string;
  name: string;
  rules: number;
  version: number;
  active: boolean;
}

/** Approval workflows (one per gated action, a fixed handful): searched and sorted in the browser. */
export function RulesTable({ rows, error }: { rows: DefinitionListRow[]; error?: ReactNode }) {
  const t = useTranslations("workflow");
  const columns: DataTableColumn<DefinitionListRow>[] = [
    { id: "name", header: t("rulesTable.workflow"), primary: true, sortable: true, searchable: true, accessor: (r) => r.name },
    {
      id: "code",
      header: t("rulesTable.code"),
      searchable: true,
      accessor: (r) => r.code,
      cell: (r) => (
        <code dir="ltr" className="text-xs break-all">
          {r.code}
        </code>
      ),
    },
    { id: "rules", header: t("rulesTable.rules"), sortable: true, align: "end", accessor: (r) => r.rules },
    {
      id: "status",
      header: t("rulesTable.status"),
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone="info">{t("rules.version", { version: r.version })}</Badge>
          {!r.active ? <Badge tone="warning">{t("rules.inactive")}</Badge> : null}
        </span>
      ),
    },
  ];
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      rowHref={(r) => `/workflow/rules/${r.id}`}
      searchPlaceholder={t("rulesTable.search")}
      error={error}
      caption={t("rules.title")}
      empty={<EmptyState icon={<WorkflowIcon aria-hidden="true" />} title={t("rules.empty")} />}
    />
  );
}
