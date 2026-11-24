"use client";

import { IdCardIcon, UserPlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { UrlDataTable } from "@/components/page-kit/url-data-table";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { EMPLOYEES_TABLE } from "../tables";
import type { EmploymentStatus } from "../types";

export interface EmployeeListRow {
  id: string;
  employee_no: string;
  name: string;
  job_title: string;
  department: string | null;
  manager: string | null;
  status: EmploymentStatus;
  statusTone: BadgeTone;
  isMe: boolean;
  /** null: territory assignments could not be read. */
  territories: { id: string; label: string; manager: boolean }[] | null;
}

export function EmployeesTable({
  rows,
  rowCount,
  filters,
  error,
  canCreate,
  filtered,
}: {
  rows: EmployeeListRow[];
  rowCount: number;
  filters?: ReactNode;
  error?: ReactNode;
  canCreate: boolean;
  /** A status filter other than the default is on (changes the empty text). */
  filtered: boolean;
}) {
  const t = useTranslations("admin.employees");
  const tc = useTranslations("admin.common");
  const tx = useTranslations("setup.console");

  const columns: DataTableColumn<EmployeeListRow>[] = [
    {
      id: "name",
      header: t("name"),
      sortable: true,
      primary: true,
      accessor: (r) => r.name,
      cell: (r) => (
        <span className="inline-flex flex-col">
          <span className="inline-flex flex-wrap items-center gap-2">
            {r.name}
            {r.isMe ? <Badge tone="info">{t("you")}</Badge> : null}
          </span>
          <span className="text-xs font-normal text-muted-foreground">{r.job_title}</span>
        </span>
      ),
    },
    {
      id: "employee_no",
      header: t("employeeNo"),
      sortable: true,
      accessor: (r) => r.employee_no,
      cell: (r) => (
        <span dir="ltr" className="whitespace-nowrap tabular-nums">
          {r.employee_no}
        </span>
      ),
    },
    { id: "department", header: tx("department"), accessor: (r) => r.department },
    { id: "manager", header: t("manager"), accessor: (r) => r.manager },
    {
      id: "territories",
      header: t("territories"),
      cell: (r) =>
        r.territories === null ? (
          "—"
        ) : r.territories.length === 0 ? (
          <span className="text-muted-foreground">{t("noTerritories")}</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {r.territories.map((tr) => (
              <Badge key={tr.id} tone={tr.manager ? "info" : "neutral"}>
                {tr.label}
              </Badge>
            ))}
          </span>
        ),
    },
    {
      id: "status",
      header: tc("status"),
      accessor: (r) => r.status,
      cell: (r) => <Badge tone={r.statusTone}>{t(`statuses.${r.status}`)}</Badge>,
    },
  ];

  return (
    <UrlDataTable
      options={EMPLOYEES_TABLE}
      rowCount={rowCount}
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      rowHref={(r) => `/admin/employees/${r.id}`}
      searchPlaceholder={tx("searchEmployees")}
      filters={filters}
      error={error}
      caption={t("title")}
      empty={
        <EmptyState
          icon={<IdCardIcon aria-hidden="true" />}
          title={filtered ? t("emptyFilter") : t("empty")}
          description={filtered ? undefined : tx("employeesEmptyHint")}
          action={
            canCreate && !filtered ? (
              <Link href="/admin/employees/new" className={buttonVariants()}>
                <UserPlusIcon aria-hidden="true" />
                {t("newEmployee")}
              </Link>
            ) : undefined
          }
        />
      }
    />
  );
}
