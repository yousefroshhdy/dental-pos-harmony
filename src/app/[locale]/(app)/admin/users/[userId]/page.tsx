import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { revokeRole } from "@/modules/admin/actions";
import { ErrorMessage } from "@/modules/admin/components/action-message";
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
  if (!user.ok) return <ErrorMessage messageKey={user.error.messageKey} requestId={user.error.requestId} />;
  if (!user.data) notFound();
  if (!assignments.ok) return <ErrorMessage messageKey={assignments.error.messageKey} requestId={assignments.error.requestId} />;
  if (!roles.ok) return <ErrorMessage messageKey={roles.error.messageKey} requestId={roles.error.requestId} />;

  const profile = user.data;
  const name = localizedName(locale, profile.full_name_en, profile.full_name_ar) || profile.email || profile.user_id;
  const now = new Date();
  const active = activeRolesByUser(assignments.data, roles.data, now).get(userId) ?? [];
  const rows = new Map(assignments.data.map((a) => [a.id, a]));
  const territoryList = territories?.ok ? territories.data : [];
  const territoryName = new Map(territoryList.map((tr) => [tr.id, localizedName(locale, tr.name_en, tr.name_ar)]));

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/admin/users" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("back")}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{t("title", { name })}</h1>
          <Badge tone={statusTone(profile.status)}>{tUsers(STATUS_KEY[profile.status])}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {[profile.job_title, profile.employee_no].filter(Boolean).join(" · ")}
          {profile.email ? (
            <>
              {" · "}
              <span dir="ltr">{profile.email}</span>
            </>
          ) : null}
        </p>
      </div>

      <section className="space-y-3">
        <CardTitle>{t("assignments")}</CardTitle>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noAssignments")}</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("role")}</Th>
                <Th>{t("territory")}</Th>
                <Th>{t("grantedAt")}</Th>
                <Th>{t("validTo")}</Th>
                {mayAssign ? <Th>{tCommon("actions")}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {active.map((a) => {
                const row = rows.get(a.assignmentId);
                const territoryId = row?.scope_territory_id ?? null;
                return (
                  <tr key={a.assignmentId}>
                    <Td className="min-w-40">
                      <span className="flex flex-wrap items-center gap-2">
                        {localizedName(locale, a.nameEn, a.nameAr)}
                        {a.isOwnerRole ? <Badge tone="info">{t("ownerRole")}</Badge> : null}
                      </span>
                      <code dir="ltr" className="block text-xs text-muted-foreground">
                        {a.code}
                      </code>
                    </Td>
                    <Td>{territoryId ? (territoryName.get(territoryId) ?? t("boundTerritory")) : t("defaultScope")}</Td>
                    <Td className="whitespace-nowrap">{row ? format.dateTime(new Date(row.granted_at), CAIRO_DATE_TIME) : "—"}</Td>
                    <Td className="whitespace-nowrap">{row?.valid_to ? format.dateTime(new Date(row.valid_to), CAIRO_DATE) : t("noEnd")}</Td>
                    {mayAssign ? (
                      <Td>
                        {canRevokeAssignment(ctx, a) ? (
                          <ReasonActionForm
                            action={revokeRole}
                            fields={{ user_role_id: a.assignmentId, user_id: userId }}
                            trigger={t("revoke")}
                            confirm={t("revokeConfirm")}
                            reasonLabel={tCommon("reason")}
                            reasonPlaceholder={tCommon("reasonPlaceholder")}
                            destructive
                          />
                        ) : null}
                      </Td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>

      {canGrantTo(ctx, userId) ? (
        <Card className="space-y-4">
          <div>
            <CardTitle>{t("grantTitle")}</CardTitle>
            <p className="text-sm text-muted-foreground">{t("grantHint")}</p>
          </div>
          {territories && !territories.ok ? <p className="text-sm text-muted-foreground">{t("territoriesUnavailable")}</p> : null}
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
