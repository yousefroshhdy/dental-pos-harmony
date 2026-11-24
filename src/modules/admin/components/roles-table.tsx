"use client";

import { ShieldIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { UrlDataTable } from "@/components/page-kit/url-data-table";
import { Badge } from "@/components/ui/badge";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ROLES_TABLE } from "../tables";

export interface RoleListRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isOwner: boolean;
  isSystem: boolean;
  isActive: boolean;
  permissionCount: number;
}

export function RolesTable({ rows, rowCount, error }: { rows: RoleListRow[]; rowCount: number; error?: ReactNode }) {
  const t = useTranslations("admin.roles");
  const tx = useTranslations("setup.console");

  const columns: DataTableColumn<RoleListRow>[] = [
    {
      id: "name",
      header: t("name"),
      sortable: true,
      primary: true,
      accessor: (r) => r.name,
      cell: (r) => (
        <span className="inline-flex flex-col">
          <span>{r.name}</span>
          {r.description ? <span className="text-xs font-normal text-muted-foreground">{r.description}</span> : null}
        </span>
      ),
    },
    {
      id: "code",
      header: t("code"),
      sortable: true,
      accessor: (r) => r.code,
      cell: (r) => (
        <code dir="ltr" className="text-xs">
          {r.code}
        </code>
      ),
    },
    {
      id: "type",
      header: t("type"),
      cell: (r) =>
        r.isOwner || r.isSystem || !r.isActive ? (
          <span className="flex flex-wrap gap-1">
            {r.isOwner ? <Badge tone="info">{t("owner")}</Badge> : null}
            {r.isSystem ? <Badge>{t("system")}</Badge> : null}
            {!r.isActive ? <Badge tone="warning">{t("inactive")}</Badge> : null}
          </span>
        ) : (
          "—"
        ),
    },
    {
      id: "permissions",
      header: t("permissions"),
      align: "end",
      accessor: (r) => r.permissionCount,
      cell: (r) => <span className="tabular-nums">{r.isOwner ? t("allPermissions") : r.permissionCount}</span>,
    },
  ];

  return (
    <UrlDataTable
      options={ROLES_TABLE}
      rowCount={rowCount}
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      rowHref={(r) => `/admin/roles/${r.id}`}
      searchPlaceholder={tx("searchRoles")}
      error={error}
      caption={t("title")}
      empty={<EmptyState icon={<ShieldIcon aria-hidden="true" />} title={t("empty")} />}
    />
  );
}
