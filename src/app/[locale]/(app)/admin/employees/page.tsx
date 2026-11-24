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
import { EmployeesTable, type EmployeeListRow } from "@/modules/admin/components/employees-table";
import { employmentTone, localizedName, parseEmployeeFilter, type EmployeeFilter } from "@/modules/admin/logic";
import { listEmployeesPage, listOpenEmployeeTerritoriesFor } from "@/modules/admin/queries";
import { EMPLOYEES_TABLE, sortColumn } from "@/modules/admin/tables";
import type { EmployeeTerritoryRow } from "@/modules/admin/types";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.employees" });
  return { title: t("title") };
}

const FILTERS: EmployeeFilter[] = ["current", "inactive", "all"];

export default async function EmployeesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "core.employee.read")) return <Forbidden />;

  const sp = await searchParams;
  const filter = parseEmployeeFilter(sp.status);
  const table = readTableParams(sp, EMPLOYEES_TABLE);
  const t = await getTranslations("admin.employees");

  const employees = await listEmployeesPage({
    offset: table.offset,
    pageSize: table.pageSize,
    orderBy: sortColumn(table.sorting[0]?.id, locale, "employee_no"),
    desc: table.sorting[0]?.desc ?? false,
    search: table.search,
    filter,
  });
  const pageRows = employees.ok ? employees.data.rows : [];
  const territories = await listOpenEmployeeTerritoriesFor(pageRows.map((e) => e.id));

  const byEmployee = new Map<string, EmployeeTerritoryRow[]>();
  for (const row of territories.ok ? territories.data : []) {
    const list = byEmployee.get(row.employee_id) ?? [];
    list.push(row);
    byEmployee.set(row.employee_id, list);
  }

  const rows: EmployeeListRow[] = pageRows.map((e) => ({
    id: e.id,
    employee_no: e.employee_no,
    name: localizedName(locale, e.full_name_en, e.full_name_ar),
    job_title: e.job_title,
    department: e.department_id ? localizedName(locale, e.department_name_en, e.department_name_ar) || e.department_code : null,
    manager: e.manager_id ? localizedName(locale, e.manager_name_en, e.manager_name_ar) || e.manager_no : null,
    status: e.employment_status,
    statusTone: employmentTone(e.employment_status),
    isMe: e.id === ctx.employee?.id,
    territories: territories.ok
      ? (byEmployee.get(e.id) ?? []).map((tr) => ({
          id: tr.id,
          label: localizedName(locale, tr.territory_name_en, tr.territory_name_ar),
          manager: tr.assignment === "manager",
        }))
      : null,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("intro")}
        actions={
          can(ctx, "core.employee.manage") ? (
            <Link href="/admin/employees/new" className={buttonVariants()}>
              <UserPlusIcon aria-hidden="true" />
              {t("newEmployee")}
            </Link>
          ) : null
        }
      />

      {employees.ok && !territories.ok ? (
        <Alert tone="warning" role="status">
          {t("territoriesUnavailable")}
        </Alert>
      ) : null}

      <EmployeesTable
        rows={rows}
        rowCount={employees.ok ? employees.data.total : 0}
        canCreate={can(ctx, "core.employee.manage")}
        filtered={filter === "inactive"}
        error={employees.ok ? undefined : <ListError error={employees.error} />}
        filters={
          <FilterChips
            label={t("filterLabel")}
            pathname="/admin/employees"
            params={sp}
            param="status"
            current={filter === "current" ? null : filter}
            options={FILTERS.map((f) => ({ value: f === "current" ? null : f, label: t(`filters.${f}`) }))}
          />
        }
      />
    </div>
  );
}
