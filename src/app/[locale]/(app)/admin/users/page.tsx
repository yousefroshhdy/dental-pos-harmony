import { UserPlusIcon } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { FilterChips } from "@/components/page-kit/filter-chips";
import { ListError } from "@/components/page-kit/list-error";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { readTableParams } from "@/components/ui/data-table-params";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { pickParam } from "@/lib/list-query";
import { UsersTable, type UserListRow } from "@/modules/admin/components/users-table";
import { activeRolesByUser, canInvite, localizedName, statusTone, userRowActions, type AssignedRole } from "@/modules/admin/logic";
import { listOpenAssignmentsFor, listRoles, listUsersPage } from "@/modules/admin/queries";
import { sortColumn, USER_STATUSES, USERS_TABLE } from "@/modules/admin/tables";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.users" });
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function UsersPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: SearchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "admin.user.read")) return <Forbidden />;

  const t = await getTranslations("admin.users");
  const tx = await getTranslations("setup.console");
  const sp = await searchParams;
  const table = readTableParams(sp, USERS_TABLE);
  const status = pickParam(sp, "status", [...USER_STATUSES, "all"] as const, "all");
  const showRoles = can(ctx, "admin.role.read");

  const users = await listUsersPage({
    offset: table.offset,
    pageSize: table.pageSize,
    orderBy: sortColumn(table.sorting[0]?.id, locale, "employee_no"),
    desc: table.sorting[0]?.desc ?? false,
    search: table.search,
    status: status === "all" ? null : status,
  });
  const pageRows = users.ok ? users.data.rows : [];
  const [assignments, roles] = showRoles
    ? await Promise.all([listOpenAssignmentsFor(pageRows.map((u) => u.user_id)), listRoles()])
    : [null, null];

  const rolesByUser =
    assignments?.ok && roles?.ok ? activeRolesByUser(assignments.data, roles.data, new Date()) : new Map<string, AssignedRole[]>();
  const rolesFailed = showRoles && (!assignments?.ok || !roles?.ok);

  const rows: UserListRow[] = pageRows.map((user) => ({
    user_id: user.user_id,
    employee_no: user.employee_no,
    name: localizedName(locale, user.full_name_en, user.full_name_ar),
    job_title: user.job_title,
    email: user.email,
    status: user.status,
    statusTone: statusTone(user.status),
    isMe: user.user_id === ctx.user_id,
    roles: showRoles
      ? (rolesByUser.get(user.user_id) ?? []).map((r) => ({ id: r.assignmentId, label: localizedName(locale, r.nameEn, r.nameAr), owner: r.isOwnerRole }))
      : null,
    actions: userRowActions(ctx, user),
  }));

  const statusLabel = { active: t("statusActive"), suspended: t("statusSuspended"), disabled: t("statusDisabled") };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={tx("usersIntro")}
        actions={
          canInvite(ctx) ? (
            <Link href="/admin/users/new" className={buttonVariants()}>
              <UserPlusIcon aria-hidden="true" />
              {t("invite")}
            </Link>
          ) : null
        }
      />

      {users.ok && rolesFailed ? (
        <Alert tone="warning" role="status">
          {t("rolesUnavailable")}
        </Alert>
      ) : null}

      <UsersTable
        rows={rows}
        rowCount={users.ok ? users.data.total : 0}
        canInvite={canInvite(ctx)}
        showRoles={showRoles && !rolesFailed}
        error={users.ok ? undefined : <ListError error={users.error} />}
        filters={
          <FilterChips
            label={tx("filterStatus")}
            pathname="/admin/users"
            params={sp}
            param="status"
            current={status === "all" ? null : status}
            options={[{ value: null, label: tx("all") }, ...USER_STATUSES.map((s) => ({ value: s, label: statusLabel[s] }))]}
          />
        }
      />
    </div>
  );
}
