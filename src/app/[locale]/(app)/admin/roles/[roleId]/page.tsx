import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { BackLink } from "@/components/page-kit/back-link";
import { PageError } from "@/components/page-kit/page-error";
import { PageHeader } from "@/components/ui/page-header";
import { Alert, Badge, Card, CardTitle } from "@/components/ui/primitives";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
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
  const tx = await getTranslations("setup.console");
  const format = await getFormatter();

  const [role, permissions, rolePermissions] = await Promise.all([getRole(roleId), listPermissions(), listRolePermissions(roleId)]);
  const back = <BackLink href="/admin/roles">{t("back")}</BackLink>;
  if (!role.ok) return <PageError back={back} error={role.error} />;
  if (!role.data) notFound();
  if (!permissions.ok) return <PageError back={back} error={permissions.error} />;
  if (!rolePermissions.ok) return <PageError back={back} error={rolePermissions.error} />;

  const current = role.data;
  const editable = canEditRole(ctx, current);
  const groups = groupPermissionsByModule(permissions.data, rolePermissions.data);
  const moduleName = (module: string) => (t.has(`modules.${module}`) ? t(`modules.${module}`) : module);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={back}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {localizedName(locale, current.name_en, current.name_ar)}
            {current.is_owner_role ? <Badge tone="info">{t("owner")}</Badge> : null}
            {current.is_system ? <Badge>{t("system")}</Badge> : null}
            {!current.is_active ? <Badge tone="warning">{t("inactive")}</Badge> : null}
          </span>
        }
        description={
          <>
            <code dir="ltr" className="me-2">
              {current.code}
            </code>
            {current.description}
          </>
        }
      />

      {current.is_owner_role ? (
        <Alert tone="info" role="status">
          {t("ownerNote")}
        </Alert>
      ) : !editable ? (
        <Alert tone="info" role="status">
          {t("readOnly")}
        </Alert>
      ) : (
        <Alert tone="info" role="status">
          {t("ceilingNote")}
        </Alert>
      )}

      {groups.length > 1 ? (
        <nav aria-label={tx("jumpToModule")} className="-mx-1 overflow-x-auto px-1">
          <ul className="flex w-max gap-2">
            {groups.map((group) => (
              <li key={group.module}>
                <a
                  href={`#module-${group.module}`}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full border bg-card px-4 text-sm font-medium whitespace-nowrap hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  {moduleName(group.module)}
                  <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
                    {group.grantedCount}/{group.items.length}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {groups.map((group) => (
        <Card key={group.module} id={`module-${group.module}`} className="scroll-mt-20 space-y-3">
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
