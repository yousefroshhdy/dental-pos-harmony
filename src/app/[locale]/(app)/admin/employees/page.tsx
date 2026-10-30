import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { ErrorMessage } from "@/modules/admin/components/action-message";
import { employmentTone, localizedName, matchesEmployeeFilter, parseEmployeeFilter, type EmployeeFilter } from "@/modules/admin/logic";
import { listEmployees, listOpenEmployeeTerritories } from "@/modules/admin/queries";
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

  const filter = parseEmployeeFilter((await searchParams).status);
  const t = await getTranslations("admin.employees");
  const tCommon = await getTranslations("admin.common");
  const [employees, territories] = await Promise.all([listEmployees(), listOpenEmployeeTerritories()]);
  if (!employees.ok) return <ErrorMessage messageKey={employees.error.messageKey} requestId={employees.error.requestId} />;

  const byEmployee = new Map<string, EmployeeTerritoryRow[]>();
  for (const row of territories.ok ? territories.data : []) {
    const list = byEmployee.get(row.employee_id) ?? [];
    list.push(row);
    byEmployee.set(row.employee_id, list);
  }
  const rows = employees.data.filter((e) => matchesEmployeeFilter(e.employment_status, filter));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("intro")}</p>
        </div>
        {can(ctx, "core.employee.manage") ? (
          <Link href="/admin/employees/new" className={buttonVariants()}>
            {t("newEmployee")}
          </Link>
        ) : null}
      </div>

      <nav aria-label={t("filterLabel")} className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={f === "current" ? "/admin/employees" : `/admin/employees?status=${f}`}
            aria-current={f === filter ? "page" : undefined}
            className={cn(buttonVariants({ variant: f === filter ? "default" : "outline", size: "sm" }), "min-h-11")}
          >
            {t(`filters.${f}`)}
          </Link>
        ))}
      </nav>

      {!territories.ok ? <p className="text-sm text-muted-foreground">{t("territoriesUnavailable")}</p> : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{employees.data.length === 0 ? t("empty") : t("emptyFilter")}</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{t("employeeNo")}</Th>
              <Th>{t("name")}</Th>
              <Th>{t("manager")}</Th>
              <Th>{t("territories")}</Th>
              <Th>{tCommon("status")}</Th>
              <Th>{tCommon("actions")}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const mine = byEmployee.get(e.id) ?? [];
              return (
                <tr key={e.id}>
                  <Td>
                    <span dir="ltr" className="whitespace-nowrap">
                      {e.employee_no}
                    </span>
                  </Td>
                  <Td className="min-w-44">
                    <span className="block font-medium">{localizedName(locale, e.full_name_en, e.full_name_ar)}</span>
                    <span className="block text-xs text-muted-foreground">{e.job_title}</span>
                    {e.id === ctx.employee?.id ? <Badge className="mt-1">{t("you")}</Badge> : null}
                  </Td>
                  <Td className="min-w-32">{e.manager_id ? localizedName(locale, e.manager_name_en, e.manager_name_ar) || e.manager_no : "—"}</Td>
                  <Td className="min-w-32">
                    {mine.length === 0 ? (
                      <span className="text-muted-foreground">{t("noTerritories")}</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {mine.map((tr) => (
                          <Badge key={tr.id} tone={tr.assignment === "manager" ? "info" : "neutral"}>
                            {localizedName(locale, tr.territory_name_en, tr.territory_name_ar)}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={employmentTone(e.employment_status)}>{t(`statuses.${e.employment_status}`)}</Badge>
                  </Td>
                  <Td>
                    <Link href={`/admin/employees/${e.id}`} className={buttonVariants({ variant: "outline" })}>
                      {t("open")}
                    </Link>
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
