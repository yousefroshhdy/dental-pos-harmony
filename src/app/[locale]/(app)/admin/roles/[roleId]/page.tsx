import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { Alert, Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { ErrorMessage } from "@/modules/admin/components/action-message";
import { PermissionRowForm } from "@/modules/admin/components/permission-row-form";
import { canEditRole, defaultScopeFor, groupPermissionsByModule, localizedName } from "@/modules/admin/logic";
import { getRole, listPermissions, listRolePermissions } from "@/modules/admin/queries";

type Params = Promise<{ locale: string; roleId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.roles" });
  return { title: t("title") };
}

export default async function RolePage({ params }: { params: Params }) {
  const { locale, roleId } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(roleId).success) notFound();

  const ctx = await getUserContext();
  if (!can(ctx, "admin.role.read")) return <Forbidden />;

  const t = await getTranslations("admin.roles");
  const tScopes = await getTranslations("scopes");
  const format = await getFormatter();

  const [role, permissions, rolePermissions] = await Promise.all([getRole(roleId), listPermissions(), listRolePermissions(roleId)]);
  if (!role.ok) return <ErrorMessage messageKey={role.error.messageKey} requestId={role.error.requestId} />;
  if (!role.data) notFound();
  if (!permissions.ok) return <ErrorMessage messageKey={permissions.error.messageKey} requestId={permissions.error.requestId} />;
  if (!rolePermissions.ok) return <ErrorMessage messageKey={rolePermissions.error.messageKey} requestId={rolePermissions.error.requestId} />;

  const current = role.data;
  const editable = canEditRole(ctx, current);
  const groups = groupPermissionsByModule(permissions.data, rolePermissions.data);
  const moduleName = (module: string) => (t.has(`modules.${module}`) ? t(`modules.${module}`) : module);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/admin/roles" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("back")}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{localizedName(locale, current.name_en, current.name_ar)}</h1>
          <code dir="ltr" className="text-sm text-muted-foreground">
            {current.code}
          </code>
          {current.is_owner_role ? <Badge tone="info">{t("owner")}</Badge> : null}
          {current.is_system ? <Badge>{t("system")}</Badge> : null}
          {!current.is_active ? <Badge tone="warning">{t("inactive")}</Badge> : null}
        </div>
        {current.description ? <p className="text-sm text-muted-foreground">{current.description}</p> : null}
      </div>

      {current.is_owner_role ? (
        <Alert tone="info">{t("ownerNote")}</Alert>
      ) : !editable ? (
        <Alert tone="info">{t("readOnly")}</Alert>
      ) : (
        <p className="text-sm text-muted-foreground">{t("ceilingNote")}</p>
      )}

      {groups.map((group) => (
        <Card key={group.module} className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle>{moduleName(group.module)}</CardTitle>
            <span className="text-sm text-muted-foreground">
              {t("grantedOf", { granted: group.grantedCount, total: group.items.length })}
            </span>
          </div>
          <ul className="divide-y">
            {group.items.map((item) => (
              <li key={item.code} className="flex flex-col gap-3 py-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code dir="ltr" className="text-sm font-medium break-all">
                      {item.code}
                    </code>
                    {item.is_sensitive ? (
                      <Badge tone="danger" title={t("sensitiveHint")}>
                        {t("sensitive")}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-sm text-muted-foreground">{item.description}</p>
                  <p className="text-sm">
                    {current.is_owner_role ? (
                      <Badge tone="info">{tScopes("all")}</Badge>
                    ) : item.grant ? (
                      <span className="flex flex-wrap gap-1">
                        <Badge tone="success">{tScopes(item.grant.scope)}</Badge>
                        {item.supports_limit ? (
                          <Badge tone="warning">
                            {item.grant.limit === null
                              ? t("noLimit")
                              : `≤ ${format.number(item.grant.limit, { maximumFractionDigits: 2, numberingSystem: "latn" })}`}
                          </Badge>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t("notGranted")}</span>
                    )}
                  </p>
                </div>
                {editable && item.scopes.length > 0 ? (
                  <div className="shrink-0">
                    <PermissionRowForm
                      // Remount when the stored grant changes so stale results clear.
                      key={`${item.grant?.scope ?? "-"}:${item.grant?.limit ?? "-"}`}
                      roleId={current.id}
                      permission={item.code}
                      scopes={item.scopes}
                      defaultScope={defaultScopeFor(item)}
                      supportsLimit={item.supports_limit}
                      limit={item.grant?.limit ?? null}
                      granted={item.grant !== null}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
