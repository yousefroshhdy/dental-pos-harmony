"use client";

import { CalendarRangeIcon, PercentIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { RecalculateForm } from "./period-actions";

/**
 * Commission months and plans. Both lists are bounded (one row per month, at most
 * PERIOD_LIMIT; a handful of plans), and the period actions need every month at
 * once (closableMonth), so they sort and page in the browser.
 */

export interface PeriodListRow {
  key: string;
  label: string;
  status: string;
  statusTone: BadgeTone;
  /** Formatted on the server; null for a month not calculated yet. */
  entries: string | null;
  adjustments: string | null;
  total: string | null;
  employees: string | null;
  closing: string | null;
  recalculable: boolean;
}

export function PeriodsTable({ rows, error }: { rows: PeriodListRow[]; error?: ReactNode }) {
  const t = useTranslations("commissions");
  const columns: DataTableColumn<PeriodListRow>[] = [
    {
      id: "month",
      header: t("tables.month"),
      primary: true,
      sortable: true,
      accessor: (r) => r.key,
      // A plain link, not rowHref: the row also holds the recalculate button, and a
      // phone card that is itself a link must not contain a form.
      cell: (r) => (
        <Link href={`/commissions/team?period=${r.key}`} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline">
          {r.label}
        </Link>
      ),
    },
    { id: "status", header: t("tables.status"), cell: (r) => <Badge tone={r.statusTone}>{t(`period.status.${r.status}`)}</Badge> },
    { id: "entries", header: t("periods.entries"), align: "end", accessor: (r) => r.entries, cell: (r) => <Num v={r.entries} /> },
    { id: "adjustments", header: t("statement.totals.adjustments"), align: "end", cell: (r) => <Num v={r.adjustments} /> },
    { id: "total", header: t("statement.totals.total"), align: "end", cell: (r) => <Num v={r.total} strong /> },
    { id: "employees", header: t("periods.employees"), align: "end", cell: (r) => <Num v={r.employees} /> },
    { id: "closing", header: t("tables.closing"), cell: (r) => (r.closing ? <span className="text-xs text-muted-foreground">{r.closing}</span> : t("period.notCalculated")) },
    {
      id: "actions",
      header: t("tables.actions"),
      cell: (r) => (r.recalculable ? <RecalculateForm period={r.key} label={r.label} /> : null),
    },
  ];
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.key}
      searchable={false}
      pageSize={12}
      error={error}
      caption={t("periods.list")}
      empty={<EmptyState icon={<CalendarRangeIcon aria-hidden="true" />} title={t("period.notCalculated")} />}
    />
  );
}

export interface PlanListRow {
  id: string;
  code: string;
  name: string;
  status: string;
  statusTone: BadgeTone;
  isDefault: boolean;
  window: string;
  rates: number;
}

export function PlansTable({ rows, error, empty }: { rows: PlanListRow[]; error?: ReactNode; empty: string }) {
  const t = useTranslations("commissions.plans");
  const tt = useTranslations("commissions.tables");
  const columns: DataTableColumn<PlanListRow>[] = [
    {
      id: "code",
      header: tt("plan"),
      primary: true,
      sortable: true,
      searchable: true,
      accessor: (r) => r.code,
      cell: (r) => <span dir="ltr">{r.code}</span>,
    },
    { id: "name", header: tt("name"), searchable: true, accessor: (r) => r.name },
    {
      id: "status",
      header: tt("status"),
      accessor: (r) => r.status,
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={r.statusTone}>{t(`status.${r.status}`)}</Badge>
          {r.isDefault ? <Badge tone="info">{t("default")}</Badge> : null}
        </span>
      ),
    },
    { id: "window", header: tt("window"), accessor: (r) => r.window },
    { id: "rates", header: tt("rates"), align: "end", sortable: true, accessor: (r) => r.rates },
  ];
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      rowHref={(r) => `/commissions/plans/${r.id}`}
      error={error}
      caption={t("list")}
      empty={<EmptyState icon={<PercentIcon aria-hidden="true" />} title={empty} />}
    />
  );
}

function Num({ v, strong = false }: { v: string | null; strong?: boolean }) {
  return <span className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>{v ?? "—"}</span>;
}
