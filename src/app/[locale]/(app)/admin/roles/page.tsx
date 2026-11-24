import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { ListError } from "@/components/page-kit/list-error";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readTableParams } from "@/components/ui/data-table-params";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { CreateRoleForm } from "@/modules/admin/components/create-role-form";
import { RolesTable, type RoleListRow } from "@/modules/admin/components/roles-table";
import { localizedName } from "@/modules/admin/logic";
import { listRolesPage } from "@/modules/admin/queries";
import { ROLES_TABLE, sortColumn } from "@/modules/admin/tables";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.roles" });
  return { title: t("title") };
}

export default async function RolesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "admin.role.read")) return <Forbidden />;

  const t = await getTranslations("admin.roles");
  const tx = await getTranslations("setup.console");
  const table = readTableParams(await searchParams, ROLES_TABLE);
  const roles = await listRolesPage({
    offset: table.offset,
    pageSize: table.pageSize,
    orderBy: sortColumn(table.sorting[0]?.id, locale, "code", { en: "name_en", ar: "name_ar" }),
    desc: table.sorting[0]?.desc ?? false,
    search: table.search,
  });

  const rows: RoleListRow[] = (roles.ok ? roles.data.rows : []).map((role) => ({
    id: role.id,
    code: role.code,
    name: localizedName(locale, role.name_en, role.name_ar),
    description: role.description,
    isOwner: role.is_owner_role,
    isSystem: role.is_system,
    isActive: role.is_active,
    permissionCount: Number(role.permission_count),
  }));

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={tx("rolesIntro")} />

      <RolesTable rows={rows} rowCount={roles.ok ? roles.data.total : 0} error={roles.ok ? undefined : <ListError error={roles.error} />} />

      {can(ctx, "admin.role.manage") ? (
        <Card className="space-y-4">
          <CardHeader>
            <div className="space-y-1">
              <CardTitle>{t("newRole")}</CardTitle>
              <CardDescription>{t("ceilingNote")}</CardDescription>
            </div>
          </CardHeader>
          <CreateRoleForm locale={locale} />
        </Card>
      ) : null}
    </div>
  );
}
