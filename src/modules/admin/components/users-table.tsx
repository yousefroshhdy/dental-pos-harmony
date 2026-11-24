"use client";

import { UserPlusIcon, UsersIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { UrlDataTable } from "@/components/page-kit/url-data-table";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { reactivateUser, suspendUser } from "../actions";
import { USERS_TABLE } from "../tables";
import type { ProfileStatus } from "../types";
import { ReasonActionForm } from "./reason-action-form";

/** One row of the users list, computed on the server (names localised, actions decided by permission). */
export interface UserListRow {
  user_id: string;
  employee_no: string | null;
  name: string;
  job_title: string | null;
  email: string | null;
  status: ProfileStatus;
  statusTone: BadgeTone;
  isMe: boolean;
  /** null: roles are not shown to this viewer. */
  roles: { id: string; label: string; owner: boolean }[] | null;
  actions: { manageRoles: boolean; suspend: boolean; reactivate: boolean };
}

const STATUS_KEY = { active: "statusActive", suspended: "statusSuspended", disabled: "statusDisabled" } as const;

export function UsersTable({
  rows,
  rowCount,
  filters,
  error,
  canInvite,
  showRoles,
}: {
  rows: UserListRow[];
  rowCount: number;
  filters?: ReactNode;
  error?: ReactNode;
  canInvite: boolean;
  showRoles: boolean;
}) {
  const t = useTranslations("admin.users");
  const tc = useTranslations("admin.common");
  const tx = useTranslations("setup.console");

  const columns: DataTableColumn<UserListRow>[] = [
    {
      id: "name",
      header: t("name"),
      sortable: true,
      primary: true,
      accessor: (r) => r.name,
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span>{r.name || "—"}</span>
          {r.isMe ? <Badge tone="info">{t("you")}</Badge> : null}
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
          {r.employee_no ?? "—"}
        </span>
      ),
    },
    { id: "job_title", header: t("jobTitle"), accessor: (r) => r.job_title },
    {
      id: "email",
      header: t("email"),
      accessor: (r) => r.email,
      cell: (r) => (
        <span dir="ltr" className="break-all">
          {r.email ?? "—"}
        </span>
      ),
    },
    {
      id: "status",
      header: tc("status"),
      sortable: true,
      accessor: (r) => r.status,
      cell: (r) => <Badge tone={r.statusTone}>{t(STATUS_KEY[r.status])}</Badge>,
    },
    ...(showRoles
      ? [
          {
            id: "roles",
            header: t("roles"),
            cell: (r: UserListRow) =>
              !r.roles || r.roles.length === 0 ? (
                <span className="text-muted-foreground">{t("noRoles")}</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {r.roles.map((role) => (
                    <Badge key={role.id} tone={role.owner ? "info" : "neutral"}>
                      {role.label}
                    </Badge>
                  ))}
                </span>
              ),
          } satisfies DataTableColumn<UserListRow>,
        ]
      : []),
    {
      id: "actions",
      header: tc("actions"),
      cell: (r) => <UserActions row={r} />,
    },
  ];

  return (
    <UrlDataTable
      options={USERS_TABLE}
      rowCount={rowCount}
      columns={columns}
      data={rows}
      getRowId={(r) => r.user_id}
      searchPlaceholder={tx("searchUsers")}
      filters={filters}
      error={error}
      caption={t("title")}
      empty={
        <EmptyState
          icon={<UsersIcon aria-hidden="true" />}
          title={t("empty")}
          description={tx("usersEmptyHint")}
          action={
            canInvite ? (
              <Link href="/admin/users/new" className={buttonVariants()}>
                <UserPlusIcon aria-hidden="true" />
                {t("invite")}
              </Link>
            ) : undefined
          }
        />
      }
    />
  );
}

function UserActions({ row }: { row: UserListRow }) {
  const t = useTranslations("admin.users");
  const tc = useTranslations("admin.common");
  const { actions } = row;
  if (!actions.manageRoles && !actions.suspend && !actions.reactivate) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-start">
      {actions.manageRoles ? (
        <Link href={`/admin/users/${row.user_id}`} className={buttonVariants({ variant: "outline" })}>
          {t("manageRoles")}
        </Link>
      ) : null}
      {actions.suspend ? (
        <ReasonActionForm
          action={suspendUser}
          fields={{ user_id: row.user_id }}
          trigger={t("suspend")}
          confirm={t("suspendConfirm")}
          reasonLabel={tc("reason")}
          reasonPlaceholder={tc("reasonPlaceholder")}
          destructive
        />
      ) : null}
      {actions.reactivate ? (
        <ReasonActionForm
          action={reactivateUser}
          fields={{ user_id: row.user_id }}
          trigger={t("reactivate")}
          confirm={t("reactivateConfirm")}
          reasonLabel={tc("reason")}
          reasonPlaceholder={tc("reasonPlaceholder")}
        />
      ) : null}
    </div>
  );
}
