import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { reactivateUser, suspendUser } from "@/modules/admin/actions";
import { ErrorMessage } from "@/modules/admin/components/action-message";
import { ReasonActionForm } from "@/modules/admin/components/reason-action-form";
import { activeRolesByUser, canInvite, localizedName, statusTone, userRowActions, type AssignedRole } from "@/modules/admin/logic";
import { listOpenAssignments, listRoles, listUsers } from "@/modules/admin/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.users" });
  return { title: t("title") };
}

const STATUS_KEY = { active: "statusActive", suspended: "statusSuspended", disabled: "statusDisabled" } as const;

export default async function UsersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "admin.user.read")) return <Forbidden />;

  const t = await getTranslations("admin.users");
  const tCommon = await getTranslations("admin.common");
  const showRoles = can(ctx, "admin.role.read");

  const [users, assignments, roles] = await Promise.all([
    listUsers(),
    showRoles ? listOpenAssignments() : Promise.resolve(null),
    showRoles ? listRoles() : Promise.resolve(null),
  ]);
  if (!users.ok) return <ErrorMessage messageKey={users.error.messageKey} requestId={users.error.requestId} />;

  const rolesByUser =
    assignments?.ok && roles?.ok ? activeRolesByUser(assignments.data, roles.data, new Date()) : new Map<string, AssignedRole[]>();
  const rolesFailed = showRoles && (!assignments?.ok || !roles?.ok);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        {canInvite(ctx) ? (
          <Link href="/admin/users/new" className={buttonVariants()}>
            {t("invite")}
          </Link>
        ) : null}
      </div>

      {rolesFailed ? <p className="text-sm text-muted-foreground">{t("rolesUnavailable")}</p> : null}

      {users.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{t("employeeNo")}</Th>
              <Th>{t("name")}</Th>
              <Th>{t("jobTitle")}</Th>
              <Th>{t("email")}</Th>
              <Th>{tCommon("status")}</Th>
              {showRoles ? <Th>{t("roles")}</Th> : null}
              <Th>{tCommon("actions")}</Th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((user) => {
              const actions = userRowActions(ctx, user);
              const userRoles = rolesByUser.get(user.user_id) ?? [];
              const name = localizedName(locale, user.full_name_en, user.full_name_ar);
              return (
                <tr key={user.user_id}>
                  <Td>
                    <span dir="ltr" className="whitespace-nowrap">
                      {user.employee_no ?? "—"}
                    </span>
                  </Td>
                  <Td className="min-w-40">
                    {name || "—"}
                    {user.user_id === ctx.user_id ? <Badge className="ms-2">{t("you")}</Badge> : null}
                  </Td>
                  <Td className="min-w-32">{user.job_title ?? "—"}</Td>
                  <Td>
                    <span dir="ltr" className="break-all">
                      {user.email ?? "—"}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(user.status)}>{t(STATUS_KEY[user.status])}</Badge>
                  </Td>
                  {showRoles ? (
                    <Td className="min-w-40">
                      {userRoles.length === 0 ? (
                        <span className="text-muted-foreground">{t("noRoles")}</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {userRoles.map((r) => (
                            <Badge key={r.assignmentId} tone={r.isOwnerRole ? "info" : "neutral"}>
                              {localizedName(locale, r.nameEn, r.nameAr)}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </Td>
                  ) : null}
                  <Td>
                    <div className="flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap">
                      {actions.manageRoles ? (
                        <Link href={`/admin/users/${user.user_id}`} className={buttonVariants({ variant: "outline" })}>
                          {t("manageRoles")}
                        </Link>
                      ) : null}
                      {actions.suspend ? (
                        <ReasonActionForm
                          action={suspendUser}
                          fields={{ user_id: user.user_id }}
                          trigger={t("suspend")}
                          confirm={t("suspendConfirm")}
                          reasonLabel={tCommon("reason")}
                          reasonPlaceholder={tCommon("reasonPlaceholder")}
                          destructive
                        />
                      ) : null}
                      {actions.reactivate ? (
                        <ReasonActionForm
                          action={reactivateUser}
                          fields={{ user_id: user.user_id }}
                          trigger={t("reactivate")}
                          confirm={t("reactivateConfirm")}
                          reasonLabel={tCommon("reason")}
                          reasonPlaceholder={tCommon("reasonPlaceholder")}
                        />
                      ) : null}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
