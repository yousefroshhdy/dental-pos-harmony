"use client";

import { ShieldAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { UrlDataTable } from "@/components/page-kit/url-data-table";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { SECURITY_EVENTS_TABLE } from "../tables";
import type { Severity } from "../types";

export interface SecurityEventListRow {
  id: string;
  occurredAt: string;
  /** Formatted on the server (Cairo time, Latin digits). */
  when: string;
  type: string;
  typeLabel: string;
  severity: Severity;
  severityTone: BadgeTone;
  actor: string;
  details: string;
}

export function SecurityEventsTable({
  rows,
  rowCount,
  filters,
  error,
}: {
  rows: SecurityEventListRow[];
  rowCount: number;
  filters?: ReactNode;
  error?: ReactNode;
}) {
  const t = useTranslations("admin.security");
  const tx = useTranslations("setup.console");

  const columns: DataTableColumn<SecurityEventListRow>[] = [
    {
      id: "type",
      header: t("event"),
      primary: true,
      accessor: (r) => r.typeLabel,
      cell: (r) => (
        <span className="inline-flex flex-col">
          <span>{r.typeLabel}</span>
          <code dir="ltr" className="text-xs font-normal text-muted-foreground">
            {r.type}
          </code>
        </span>
      ),
    },
    {
      id: "occurred_at",
      header: t("when"),
      sortable: true,
      accessor: (r) => r.occurredAt,
      cell: (r) => (
        <time dateTime={r.occurredAt} className="whitespace-nowrap tabular-nums">
          {r.when}
        </time>
      ),
    },
    {
      id: "severity",
      header: t("severity"),
      sortable: true,
      accessor: (r) => r.severity,
      cell: (r) => <Badge tone={r.severityTone}>{t(`severities.${r.severity}`)}</Badge>,
    },
    { id: "actor", header: t("actor"), accessor: (r) => r.actor },
    {
      id: "details",
      header: t("details"),
      cell: (r) => (
        <details className="max-w-md">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-primary">{t("show")}</summary>
          <pre dir="ltr" className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-start text-xs break-all whitespace-pre-wrap">
            {r.details}
          </pre>
        </details>
      ),
    },
  ];

  return (
    <UrlDataTable
      options={SECURITY_EVENTS_TABLE}
      rowCount={rowCount}
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      searchPlaceholder={tx("searchEventType")}
      filters={filters}
      error={error}
      caption={t("title")}
      empty={<EmptyState icon={<ShieldAlertIcon aria-hidden="true" />} title={t("empty")} />}
    />
  );
}
