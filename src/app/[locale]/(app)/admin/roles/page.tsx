import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { ErrorMessage } from "@/modules/admin/components/action-message";
import { CreateRoleForm } from "@/modules/admin/components/create-role-form";
import { localizedName } from "@/modules/admin/logic";
import { listRoles } from "@/modules/admin/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.roles" });
  return { title: t("title") };
}

export default async function RolesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "admin.role.read")) return <Forbidden />;

  const t = await getTranslations("admin.roles");
  const roles = await listRoles();
  if (!roles.ok) return <ErrorMessage messageKey={roles.error.messageKey} requestId={roles.error.requestId} />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      {roles.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{t("code")}</Th>
              <Th>{t("name")}</Th>
              <Th>{t("type")}</Th>
              <Th className="text-end">{t("permissions")}</Th>
            </tr>
          </thead>
          <tbody>
            {roles.data.map((role) => (
              <tr key={role.id}>
                <Td>
                  <Link
                    href={`/admin/roles/${role.id}`}
                    className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline"
                  >
                    <code dir="ltr">{role.code}</code>
                  </Link>
                </Td>
                <Td className="min-w-40">
                  {localizedName(locale, role.name_en, role.name_ar)}
                  {role.description ? <span className="block text-xs text-muted-foreground">{role.description}</span> : null}
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    {role.is_owner_role ? <Badge tone="info">{t("owner")}</Badge> : null}
                    {role.is_system ? <Badge>{t("system")}</Badge> : null}
                    {!role.is_active ? <Badge tone="warning">{t("inactive")}</Badge> : null}
                  </span>
                </Td>
                <Td className="text-end tabular-nums">{role.is_owner_role ? t("allPermissions") : Number(role.permission_count)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {can(ctx, "admin.role.manage") ? (
        <Card className="space-y-4">
          <CardTitle>{t("newRole")}</CardTitle>
          <CreateRoleForm locale={locale} />
        </Card>
      ) : null}
    </div>
  );
}
