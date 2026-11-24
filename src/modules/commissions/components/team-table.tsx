"use client";

import { UsersIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";

/** One employee's month; the money is formatted on the server, the raw totals sort. */
export interface TeamRow {
  employeeId: string;
  name: string;
  href: string;
  earned: string;
  clawedBack: string;
  adjustments: string;
  total: string;
  totalValue: number;
}

/** The team's commission month: searchable by name, sortable by total (a team is tens of people). */
export function TeamTable({ rows, error }: { rows: TeamRow[]; error?: ReactNode }) {
  const t = useTranslations("commissions");
  const columns: DataTableColumn<TeamRow>[] = [
    { id: "name", header: t("team.employee"), primary: true, sortable: true, searchable: true, accessor: (r) => r.name },
    { id: "earned", header: t("statement.totals.earned"), align: "end", cell: (r) => <span className="whitespace-nowrap tabular-nums">{r.earned}</span> },
    {
      id: "clawed",
      header: t("statement.totals.clawedBack"),
      align: "end",
      cell: (r) => <span className="whitespace-nowrap tabular-nums">{r.clawedBack}</span>,
    },
    {
      id: "adjustments",
      header: t("statement.totals.adjustments"),
      align: "end",
      cell: (r) => <span className="whitespace-nowrap tabular-nums">{r.adjustments}</span>,
    },
    {
      id: "total",
      header: t("statement.totals.total"),
      align: "end",
      sortable: true,
      accessor: (r) => r.totalValue,
      cell: (r) => <span className="font-semibold whitespace-nowrap tabular-nums">{r.total}</span>,
    },
  ];
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.employeeId}
      rowHref={(r) => r.href}
      searchPlaceholder={t("tables.searchEmployee")}
      error={error}
      caption={t("team.title")}
      empty={<EmptyState icon={<UsersIcon aria-hidden="true" />} title={t("team.empty")} />}
    />
  );
}
