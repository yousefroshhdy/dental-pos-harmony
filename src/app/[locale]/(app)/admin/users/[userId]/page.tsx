import { ShieldCheckIcon } from "lucide-react";
import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { BackLink } from "@/components/page-kit/back-link";
import { PageError } from "@/components/page-kit/page-error";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { revokeRole } from "@/modules/admin/actions";
import { GrantRoleForm } from "@/modules/admin/components/grant-role-form";
import { ReasonActionForm } from "@/modules/admin/components/reason-action-form";
import { CAIRO_DATE, CAIRO_DATE_TIME } from "@/modules/admin/format";
import { activeRolesByUser, canGrantTo, canRevokeAssignment, grantableRoles, localizedName, statusTone } from "@/modules/admin/logic";
import { getUser, listOpenAssignments, listRoles, listTerritories } from "@/modules/admin/queries";

type Params = Promise<{ locale: string; userId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.userDetail" });
  return { title: t("metaTitle") };
}

const STATUS_KEY = { active: "statusActive", suspended: "statusSuspended", disabled: "statusDisabled" } as const;

export default async function UserAccessPage({ params }: { params: Params }) {
  const { locale, userId } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(userId).success) notFound();

  const ctx = await getUserContext();
  if (!can(ctx, "admin.user.read") || !can(ctx, "admin.role.read")) return <Forbidden />;

  const t = await getTranslations("admin.userDetail");
  const tUsers = await getTranslations("admin.users");
  const tCommon = await getTranslations("admin.common");
  const format = await getFormatter();
  const mayAssign = can(ctx, "admin.role.assign");

  const [user, assignments, roles, territories] = await Promise.all([
    getUser(userId),
    listOpenAssignments(userId),
    listRoles(),
    mayAssign ? listTerritories() : Promise.resolve(null),
  ]);
  const back = <BackLink href="/admin/users">{t("back")}</BackLink>;
  if (!user.ok) return <PageError back={back} error={user.error} />;
  if (!user.data) notFound();
  if (!assignments.ok) return <PageError back={back} error={assignments.error} />;
  if (!roles.ok) return <PageError back={back} error={roles.error} />;

  const profile = user.data;
  const name = localizedName(locale, profile.full_name_en, profile.full_name_ar) || profile.email || profile.user_id;
  const active = activeRolesByUser(assignments.data, roles.data, new Date()).get(userId) ?? [];
  const rows = new Map(assignments.data.map((a) => [a.id, a]));
  const territoryList = territories?.ok ? territories.data : [];
  const territoryName = new Map(territoryList.map((tr) => [tr.id, localizedName(locale, tr.name_en, tr.name_ar)]));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={back}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {t("title", { name })}
            <Badge tone={statusTone(profile.status)}>{tUsers(STATUS_KEY[profile.status])}</Badge>
          </span>
        }
        description={
          <>
            {[profile.job_title, profile.employee_no].filter(Boolean).join(" · ")}
            {profile.email ? (
              <>
                {" · "}
                <span dir="ltr">{profile.email}</span>
              </>
            ) : null}
          </>
        }
      />

      <Card className="space-y-4">
        <CardHeader>
          <CardTitle>{t("assignments")}</CardTitle>
        </CardHeader>
        {active.length === 0 ? (
          <EmptyState compact icon={<ShieldCheckIcon aria-hidden="true" />} title={t("noAssignments")} />
        ) : (
          <ul className="divide-y">
            {active.map((a) => {
              const row = rows.get(a.assignmentId);
              const territoryId = row?.scope_territory_id ?? null;
              return (
                <li key={a.assignmentId} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {localizedName(locale, a.nameEn, a.nameAr)}
                      {a.isOwnerRole ? <Badge tone="info">{t("ownerRole")}</Badge> : null}
                      <code dir="ltr" className="text-xs font-normal text-muted-foreground">
                        {a.code}
                      </code>
                    </p>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                      <dt className="text-muted-foreground">{t("territory")}</dt>
                      <dd>{territoryId ? (territoryName.get(territoryId) ?? t("boundTerritory")) : t("defaultScope")}</dd>
                      <dt className="text-muted-foreground">{t("grantedAt")}</dt>
                      <dd className="tabular-nums">{row ? format.dateTime(new Date(row.granted_at), CAIRO_DATE_TIME) : "—"}</dd>
                      <dt className="text-muted-foreground">{t("validTo")}</dt>
                      <dd className="tabular-nums">{row?.valid_to ? format.dateTime(new Date(row.valid_to), CAIRO_DATE) : t("noEnd")}</dd>
                    </dl>
                  </div>
                  {mayAssign && canRevokeAssignment(ctx, a) ? (
                    <div className="shrink-0">
                      <ReasonActionForm
                        action={revokeRole}
                        fields={{ user_role_id: a.assignmentId, user_id: userId }}
                        trigger={t("revoke")}
                        confirm={t("revokeConfirm")}
                        reasonLabel={tCommon("reason")}
                        reasonPlaceholder={tCommon("reasonPlaceholder")}
                        destructive
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {canGrantTo(ctx, userId) ? (
        <Card className="space-y-4">
          <CardHeader>
            <div className="space-y-1">
              <CardTitle>{t("grantTitle")}</CardTitle>
              <CardDescription>{t("grantHint")}</CardDescription>
            </div>
          </CardHeader>
          {territories && !territories.ok ? (
            <Alert tone="warning" role="status">
              {t("territoriesUnavailable")}
            </Alert>
          ) : null}
          <GrantRoleForm
            userId={userId}
            roles={grantableRoles(roles.data, ctx).map((r) => ({ value: r.id, label: `${localizedName(locale, r.name_en, r.name_ar)} (${r.code})` }))}
            territories={territoryList.map((tr) => ({ value: tr.id, label: `${territoryName.get(tr.id) ?? tr.code} (${tr.code})` }))}
          />
        </Card>
      ) : null}
    </div>
  );
}

