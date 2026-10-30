import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { createEmployee } from "@/modules/admin/actions";
import { ActionForm } from "@/modules/admin/components/action-form";
import { EmployeeFields } from "@/modules/admin/components/employee-fields";
import { managerOptions } from "@/modules/admin/logic";
import { listDepartments, listEmployees, listOffices } from "@/modules/admin/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.employeeForm" });
  return { title: t("titleNew") };
}

export default async function NewEmployeePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "core.employee.manage")) return <Forbidden />;

  const t = await getTranslations("admin.employeeForm");
  const [employees, departments, offices] = await Promise.all([listEmployees(), listDepartments(), listOffices()]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/admin/employees" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("back")}
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{t("titleNew")}</h1>
        <p className="text-sm text-muted-foreground">{t("introNew")}</p>
      </div>
      {!employees.ok || !departments.ok || !offices.ok ? <p className="text-sm text-muted-foreground">{t("listsUnavailable")}</p> : null}
      <Card>
        <ActionForm action={createEmployee} submitLabel={t("create")}>
          <input type="hidden" name="locale" value={locale === "en" ? "en" : "ar"} />
          <EmployeeFields
            locale={locale}
            managers={managerOptions(employees.ok ? employees.data : [], null)}
            departments={departments.ok ? departments.data : []}
            offices={offices.ok ? offices.data : []}
          />
        </ActionForm>
      </Card>
    </div>
  );
}
