import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card, CardTitle, Input, Select, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { assignEmployeeTerritory, endEmployeeTerritory, setEmploymentStatus, updateEmployee } from "@/modules/admin/actions";
import { ActionForm } from "@/modules/admin/components/action-form";
import { ErrorMessage } from "@/modules/admin/components/action-message";
import { EmployeeFields } from "@/modules/admin/components/employee-fields";
import { Field } from "@/modules/admin/components/field";
import { CAIRO_DATE } from "@/modules/admin/format";
import {
  canChangeOwnScope,
  employmentTone,
  isDeactivation,
  localizedName,
  managerOptions,
  statusTargets,
} from "@/modules/admin/logic";
import {
  getEmployee,
  listAllTerritories,
  listDepartments,
  listEmployees,
  listHeldCustomers,
  listOffices,
  listOpenEmployeeTerritories,
} from "@/modules/admin/queries";

type Params = Promise<{ locale: string; employeeId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.employeeDetail" });
  return { title: t("metaTitle") };
}

export default async function EmployeePage({ params }: { params: Params }) {
  const { locale, employeeId } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(employeeId).success) notFound();

  const ctx = await getUserContext();
  if (!can(ctx, "core.employee.read")) return <Forbidden />;

  const t = await getTranslations("admin.employeeDetail");
  const tList = await getTranslations("admin.employees");
  const tCommon = await getTranslations("admin.common");
  const format = await getFormatter();
  const mayManage = can(ctx, "core.employee.manage");
  const mayTerritories = can(ctx, "core.territory.manage") && canChangeOwnScope(ctx, employeeId);

  const [employee, all, assignments, held, territories, departments, offices] = await Promise.all([
    getEmployee(employeeId),
    listEmployees(),
    listOpenEmployeeTerritories(employeeId),
    listHeldCustomers(employeeId),
    mayTerritories ? listAllTerritories() : Promise.resolve(null),
    mayManage ? listDepartments() : Promise.resolve(null),
    mayManage ? listOffices() : Promise.resolve(null),
  ]);
  if (!employee.ok) return <ErrorMessage messageKey={employee.error.messageKey} requestId={employee.error.requestId} />;
  if (!employee.data) notFound();

  const e = employee.data;
  const name = localizedName(locale, e.full_name_en, e.full_name_ar) || e.employee_no;
  const everyone = all.ok ? all.data : [];
  const reports = everyone.filter((r) => r.manager_id === e.id);
  const targets = statusTargets(ctx, e);
  const open = assignments.ok ? assignments.data : [];
  const assignedIds = new Set(open.map((a) => a.territory_id));
  const territoryChoices = (territories?.ok ? territories.data : []).filter((tr) => tr.is_active && !assignedIds.has(tr.id));
  const heldRows = held.ok ? held.data : [];

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/admin/employees" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("back")}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{name}</h1>
          <Badge tone={employmentTone(e.employment_status)}>{tList(`statuses.${e.employment_status}`)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          <span dir="ltr">{e.employee_no}</span> · {e.job_title}
          {e.terminated_on ? ` · ${t("terminatedOn", { date: format.dateTime(new Date(e.terminated_on), CAIRO_DATE) })}` : null}
        </p>
        <p className="text-sm">
          {e.user_id ? (
            can(ctx, "admin.user.read") ? (
              <Link href={`/admin/users/${e.user_id}`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
                {t("loginLinked")}
              </Link>
            ) : (
              t("loginLinked")
            )
          ) : (
            <span className="text-muted-foreground">{t("noLogin")}</span>
          )}
        </p>
      </div>

      <Card className="space-y-4">
        <CardTitle>{t("details")}</CardTitle>
        {mayManage ? (
          <ActionForm action={updateEmployee} submitLabel={t("save")} success={t("saved")}>
            <input type="hidden" name="employee_id" value={e.id} />
            <input type="hidden" name="expected_updated_at" value={e.updated_at} />
            <EmployeeFields
              locale={locale}
              employee={e}
              managers={managerOptions(everyone, e.id)}
              departments={departments?.ok ? departments.data : []}
              offices={offices?.ok ? offices.data : []}
              lockScope={!canChangeOwnScope(ctx, e.id)}
            />
          </ActionForm>
        ) : (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t("manager")}</dt>
              <dd>{e.manager_id ? localizedName(locale, e.manager_name_en, e.manager_name_ar) || e.manager_no : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("department")}</dt>
              <dd>{e.department_id ? localizedName(locale, e.department_name_en, e.department_name_ar) : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("office")}</dt>
              <dd>{e.office_id ? localizedName(locale, e.office_name_en, e.office_name_ar) : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("email")}</dt>
              <dd dir="ltr" className="text-start break-all">
                {e.email ?? "—"}
              </dd>
            </div>
          </dl>
        )}
      </Card>

      <section className="space-y-3" aria-labelledby="held-title">
        <CardTitle id="held-title">{t("heldTitle", { count: heldRows.length })}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("heldHint")}</p>
        {!held.ok ? (
          <ErrorMessage messageKey={held.error.messageKey} requestId={held.error.requestId} />
        ) : heldRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("heldEmpty")}</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("customerNo")}</Th>
                <Th>{t("customer")}</Th>
                <Th>{t("role")}</Th>
                <Th>{t("territory")}</Th>
                <Th>{t("since")}</Th>
              </tr>
            </thead>
            <tbody>
              {heldRows.map((h) => (
                <tr key={`${h.customer_id}-${h.role}`}>
                  <Td>
                    <span dir="ltr" className="whitespace-nowrap">
                      {h.customer_no}
                    </span>
                  </Td>
                  <Td className="min-w-40">{h.display_name}</Td>
                  <Td>{t(`roles.${h.role}`)}</Td>
                  <Td>
                    <span dir="ltr">{h.territory_code ?? "—"}</span>
                  </Td>
                  <Td className="whitespace-nowrap">{format.dateTime(new Date(h.assigned_since), CAIRO_DATE)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {targets.length > 0 ? (
        <Card className="space-y-4">
          <div>
            <CardTitle>{t("statusTitle")}</CardTitle>
            <p className="text-sm text-muted-foreground">{t("statusHint")}</p>
            {heldRows.length > 0 && !isDeactivation(e.employment_status) ? (
              <p className="mt-1 text-sm font-medium">{t("statusHeldWarning", { count: heldRows.length })}</p>
            ) : null}
            {reports.length > 0 ? <p className="mt-1 text-sm">{t("statusReportsWarning", { count: reports.length })}</p> : null}
          </div>
          <ActionForm action={setEmploymentStatus} submitLabel={t("statusSubmit")} success={t("statusChanged")} fieldsClassName="sm:grid-cols-2">
            <input type="hidden" name="employee_id" value={e.id} />
            <Field id="status-new" label={t("newStatus")}>
              <Select id="status-new" name="status" required defaultValue={targets[0]} className="w-full">
                {targets.map((s) => (
                  <option key={s} value={s}>
                    {tList(`statuses.${s}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="status-reason" label={tCommon("reason")}>
              <Input
                id="status-reason"
                name="reason"
                required
                minLength={3}
                maxLength={500}
                placeholder={tCommon("reasonPlaceholder")}
                autoComplete="off"
              />
            </Field>
          </ActionForm>
        </Card>
      ) : ctx.employee?.id === e.id ? (
        <p className="text-sm text-muted-foreground">{t("selfStatus")}</p>
      ) : null}

      <section className="space-y-3" aria-labelledby="territories-title">
        <CardTitle id="territories-title">{t("territoriesTitle")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("territoriesHint")}</p>
        {!assignments.ok ? (
          <ErrorMessage messageKey={assignments.error.messageKey} requestId={assignments.error.requestId} />
        ) : open.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noTerritories")}</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("territory")}</Th>
                <Th>{t("assignment")}</Th>
                <Th>{t("since")}</Th>
                {mayTerritories ? <Th>{tCommon("actions")}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {open.map((a) => (
                <tr key={a.id}>
                  <Td className="min-w-40">
                    {localizedName(locale, a.territory_name_en, a.territory_name_ar)}
                    <code dir="ltr" className="block text-xs text-muted-foreground">
                      {a.territory_code}
                    </code>
                    {!a.territory_active ? <Badge tone="warning">{t("territoryInactive")}</Badge> : null}
                  </Td>
                  <Td>{t(`assignments.${a.assignment}`)}</Td>
                  <Td className="whitespace-nowrap">{format.dateTime(new Date(a.valid_from), CAIRO_DATE)}</Td>
                  {mayTerritories ? (
                    <Td className="min-w-48">
                      <ActionForm action={endEmployeeTerritory} trigger={t("end")} submitLabel={t("endConfirm")} destructive>
                        <input type="hidden" name="employee_territory_id" value={a.id} />
                        <input type="hidden" name="employee_id" value={e.id} />
                        <Field id={`end-reason-${a.id}`} label={tCommon("reason")} optionalLabel={t("optional")}>
                          <Input id={`end-reason-${a.id}`} name="reason" maxLength={500} autoComplete="off" />
                        </Field>
                      </ActionForm>
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        {mayTerritories && e.employment_status !== "terminated" ? (
          <Card className="space-y-3">
            <CardTitle>{t("assignTitle")}</CardTitle>
            {territories && !territories.ok ? <p className="text-sm text-muted-foreground">{t("territoriesUnavailable")}</p> : null}
            {territoryChoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noTerritoryChoices")}</p>
            ) : (
              <ActionForm action={assignEmployeeTerritory} submitLabel={t("assignSubmit")} success={t("assigned")} fieldsClassName="sm:grid-cols-2">
                <input type="hidden" name="employee_id" value={e.id} />
                <Field id="assign-territory" label={t("territory")}>
                  <Select id="assign-territory" name="territory_id" required defaultValue="" className="w-full">
                    <option value="" disabled>
                      {t("selectTerritory")}
                    </option>
                    {territoryChoices.map((tr) => (
                      <option key={tr.id} value={tr.id}>
                        {`${localizedName(locale, tr.name_en, tr.name_ar)} (${tr.code})`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field id="assign-type" label={t("assignment")}>
                  <Select id="assign-type" name="assignment" defaultValue="member" className="w-full">
                    <option value="member">{t("assignments.member")}</option>
                    <option value="manager">{t("assignments.manager")}</option>
                  </Select>
                </Field>
              </ActionForm>
            )}
          </Card>
        ) : can(ctx, "core.territory.manage") && !canChangeOwnScope(ctx, employeeId) ? (
          <p className="text-sm text-muted-foreground">{t("selfTerritories")}</p>
        ) : null}
      </section>

      {reports.length > 0 ? (
        <section className="space-y-3" aria-labelledby="reports-title">
          <CardTitle id="reports-title">{t("reportsTitle", { count: reports.length })}</CardTitle>
          <ul className="flex flex-wrap gap-2">
            {reports.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/admin/employees/${r.id}`}
                  className="inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm hover:bg-muted"
                >
                  {localizedName(locale, r.full_name_en, r.full_name_ar)}
                  <Badge tone={employmentTone(r.employment_status)}>{tList(`statuses.${r.employment_status}`)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
