import { getTranslations } from "next-intl/server";
import { Input, Select } from "@/components/ui/primitives";
import { localizedName } from "../logic";
import type { AdminEmployeeRow, OrgUnitRow } from "../types";
import { Field } from "./field";

export interface EmployeeOption {
  id: string;
  employee_no: string;
  full_name_en: string;
  full_name_ar: string | null;
}

/**
 * The editable employee fields, shared by "new employee" and the employee page. Rendered on the
 * server inside an ActionForm. `lockScope` (editing your own record without being an owner)
 * keeps manager and department as hidden fields: they drive your own data scope, and
 * api.update_employee refuses to change them (SELF_GRANT_FORBIDDEN).
 */
export async function EmployeeFields({
  locale,
  employee,
  managers,
  departments,
  offices,
  lockScope = false,
}: {
  locale: string;
  employee?: AdminEmployeeRow;
  managers: EmployeeOption[];
  departments: OrgUnitRow[];
  offices: OrgUnitRow[];
  lockScope?: boolean;
}) {
  const t = await getTranslations("admin.employeeForm");
  const prefix = employee ? `emp-${employee.id}` : "emp-new";
  const id = (name: string) => `${prefix}-${name}`;
  const unitLabel = (u: OrgUnitRow) => `${localizedName(locale, u.name_en, u.name_ar)} (${u.code})`;
  const activeOr = (units: OrgUnitRow[], current: string | null | undefined) => units.filter((u) => u.is_active || u.id === current);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {employee ? null : (
        <Field id={id("employee_no")} label={t("employeeNo")}>
          <Input id={id("employee_no")} name="employee_no" required maxLength={40} dir="ltr" autoComplete="off" />
        </Field>
      )}
      <Field id={id("job_title")} label={t("jobTitle")} hint={t("jobTitleHint")}>
        <Input id={id("job_title")} name="job_title" required minLength={2} maxLength={120} defaultValue={employee?.job_title ?? ""} />
      </Field>
      <Field id={id("full_name_en")} label={t("fullNameEn")}>
        <Input
          id={id("full_name_en")}
          name="full_name_en"
          required
          minLength={2}
          maxLength={160}
          dir="ltr"
          autoComplete="off"
          defaultValue={employee?.full_name_en ?? ""}
        />
      </Field>
      <Field id={id("full_name_ar")} label={t("fullNameAr")} optionalLabel={t("optional")}>
        <Input
          id={id("full_name_ar")}
          name="full_name_ar"
          maxLength={160}
          dir="rtl"
          autoComplete="off"
          defaultValue={employee?.full_name_ar ?? ""}
        />
      </Field>
      <Field id={id("email")} label={t("email")} optionalLabel={t("optional")}>
        <Input
          id={id("email")}
          name="email"
          type="email"
          inputMode="email"
          maxLength={254}
          dir="ltr"
          autoComplete="off"
          defaultValue={employee?.email ?? ""}
        />
      </Field>
      <Field id={id("phone")} label={t("phone")} optionalLabel={t("optional")} hint={t("phoneHint")}>
        <Input
          id={id("phone")}
          name="phone"
          type="tel"
          inputMode="tel"
          dir="ltr"
          autoComplete="off"
          aria-describedby={`${id("phone")}-hint`}
          defaultValue={employee?.phone ?? ""}
        />
      </Field>

      {lockScope ? (
        <>
          {employee?.manager_id ? <input type="hidden" name="manager_id" value={employee.manager_id} /> : null}
          {employee?.department_id ? <input type="hidden" name="department_id" value={employee.department_id} /> : null}
          <p className="text-sm text-muted-foreground sm:col-span-2">{t("selfScopeLocked")}</p>
        </>
      ) : (
        <>
          <Field id={id("manager_id")} label={t("manager")} optionalLabel={t("optional")} hint={t("managerHint")}>
            <Select id={id("manager_id")} name="manager_id" defaultValue={employee?.manager_id ?? ""} className="w-full">
              <option value="">{t("noManager")}</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>
                  {`${localizedName(locale, m.full_name_en, m.full_name_ar)} (${m.employee_no})`}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={id("department_id")} label={t("department")} optionalLabel={t("optional")}>
            <Select id={id("department_id")} name="department_id" defaultValue={employee?.department_id ?? ""} className="w-full">
              <option value="">{departments.length === 0 ? t("noneDefined") : t("noDepartment")}</option>
              {activeOr(departments, employee?.department_id).map((d) => (
                <option key={d.id} value={d.id}>
                  {unitLabel(d)}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}
      <Field id={id("office_id")} label={t("office")} optionalLabel={t("optional")}>
        <Select id={id("office_id")} name="office_id" defaultValue={employee?.office_id ?? ""} className="w-full">
          <option value="">{offices.length === 0 ? t("noneDefined") : t("noOffice")}</option>
          {activeOr(offices, employee?.office_id).map((o) => (
            <option key={o.id} value={o.id}>
              {unitLabel(o)}
            </option>
          ))}
        </Select>
      </Field>
      <Field id={id("hired_on")} label={t("hiredOn")} optionalLabel={t("optional")}>
        <Input id={id("hired_on")} name="hired_on" type="date" dir="ltr" defaultValue={employee?.hired_on ?? ""} />
      </Field>
    </div>
  );
}
