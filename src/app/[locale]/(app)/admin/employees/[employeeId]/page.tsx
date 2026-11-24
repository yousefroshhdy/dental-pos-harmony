import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { BuildingIcon, KeyRoundIcon, MapPinIcon } from "lucide-react";
import { BackLink } from "@/components/page-kit/back-link";
import { ListError } from "@/components/page-kit/list-error";
import { PageError } from "@/components/page-kit/page-error";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Badge, Card, CardTitle, Input, Select } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { directionOf } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { assignEmployeeTerritory, endEmployeeTerritory, setEmploymentStatus, updateEmployee } from "@/modules/admin/actions";
import { ActionForm } from "@/modules/admin/components/action-form";
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
  const tx = await getTranslations("setup.console");
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
  const back = <BackLink href="/admin/employees">{t("back")}</BackLink>;
  if (!employee.ok) return <PageError back={back} error={employee.error} />;
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
      <PageHeader
        eyebrow={back}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {name}
            <Badge tone={employmentTone(e.employment_status)}>{tList(`statuses.${e.employment_status}`)}</Badge>
          </span>
        }
        description={
          <>
            <span dir="ltr">{e.employee_no}</span> · {e.job_title}
            {e.terminated_on ? ` · ${t("terminatedOn", { date: format.dateTime(new Date(e.terminated_on), CAIRO_DATE) })}` : null}
          </>
        }
        actions={
          e.user_id ? (
            can(ctx, "admin.user.read") ? (
              <Link href={`/admin/users/${e.user_id}`} className={buttonVariants({ variant: "outline" })}>
                <KeyRoundIcon aria-hidden="true" />
                {t("loginLinked")}
              </Link>
            ) : (
              <Badge tone="success">{t("loginLinked")}</Badge>
            )
          ) : (
            <Badge>{t("noLogin")}</Badge>
          )
        }
      />

      <Tabs defaultValue="details" dir={directionOf(locale)}>
        <TabsList className="w-full justify-start sm:w-auto">
          <TabsTrigger value="details">{t("details")}</TabsTrigger>
          <TabsTrigger value="territories">
            {t("territoriesTitle")}
            <Count n={open.length} />
          </TabsTrigger>
          <TabsTrigger value="held">
            {tx("heldTab")}
            <Count n={heldRows.length} />
          </TabsTrigger>
          {targets.length > 0 || ctx.employee?.id === e.id ? <TabsTrigger value="status">{t("statusTitle")}</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="details" className="space-y-6">
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

      {reports.length > 0 ? (
        <section className="space-y-3" aria-labelledby="reports-title">
          <CardTitle id="reports-title">{t("reportsTitle", { count: reports.length })}</CardTitle>
          <ul className="flex flex-wrap gap-2">
            {reports.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/admin/employees/${r.id}`}
                  className="inline-flex min-h-11 items-center gap-2 rounded-md border bg-card px-3 text-sm hover:bg-muted"
                >
                  {localizedName(locale, r.full_name_en, r.full_name_ar)}
                  <Badge tone={employmentTone(r.employment_status)}>{tList(`statuses.${r.employment_status}`)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
        </TabsContent>

        <TabsContent value="held">
      <section className="space-y-3" aria-labelledby="held-title">
        <CardTitle id="held-title">{t("heldTitle", { count: heldRows.length })}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("heldHint")}</p>
        {!held.ok ? (
          <ListError compact error={held.error} />
        ) : heldRows.length === 0 ? (
          <EmptyState compact icon={<BuildingIcon aria-hidden="true" />} title={t("heldEmpty")} />
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {heldRows.map((h) => (
              <li key={`${h.customer_id}-${h.role}`} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="font-medium">{h.display_name}</p>
                  <p className="text-xs text-muted-foreground">
                    <span dir="ltr">{h.customer_no}</span>
                    {h.territory_code ? (
                      <>
                        {" · "}
                        <span dir="ltr">{h.territory_code}</span>
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge>{t(`roles.${h.role}`)}</Badge>
                  <span className="text-muted-foreground tabular-nums">
                    {t("since")}: {format.dateTime(new Date(h.assigned_since), CAIRO_DATE)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
        </TabsContent>

        <TabsContent value="status">
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
        <Alert tone="info" role="status">
          {t("selfStatus")}
        </Alert>
      ) : null}
        </TabsContent>

        <TabsContent value="territories">
      <section className="space-y-3" aria-labelledby="territories-title">
        <CardTitle id="territories-title">{t("territoriesTitle")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("territoriesHint")}</p>
        {!assignments.ok ? (
          <ListError compact error={assignments.error} />
        ) : open.length === 0 ? (
          <EmptyState compact icon={<MapPinIcon aria-hidden="true" />} title={t("noTerritories")} />
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {open.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {localizedName(locale, a.territory_name_en, a.territory_name_ar)}
                    <code dir="ltr" className="text-xs font-normal text-muted-foreground">
                      {a.territory_code}
                    </code>
                    {!a.territory_active ? <Badge tone="warning">{t("territoryInactive")}</Badge> : null}
                  </p>
                  <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <Badge tone={a.assignment === "manager" ? "info" : "neutral"}>{t(`assignments.${a.assignment}`)}</Badge>
                    <span className="tabular-nums">
                      {t("since")}: {format.dateTime(new Date(a.valid_from), CAIRO_DATE)}
                    </span>
                  </p>
                </div>
                {mayTerritories ? (
                  <div className="shrink-0 sm:min-w-48">
                    <ActionForm action={endEmployeeTerritory} trigger={t("end")} submitLabel={t("endConfirm")} destructive>
                      <input type="hidden" name="employee_territory_id" value={a.id} />
                      <input type="hidden" name="employee_id" value={e.id} />
                      <Field id={`end-reason-${a.id}`} label={tCommon("reason")} optionalLabel={t("optional")}>
                        <Input id={`end-reason-${a.id}`} name="reason" maxLength={500} autoComplete="off" />
                      </Field>
                    </ActionForm>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {mayTerritories && e.employment_status !== "terminated" ? (
          <Card className="space-y-3">
            <CardTitle>{t("assignTitle")}</CardTitle>
            {territories && !territories.ok ? (
              <Alert tone="warning" role="status">
                {t("territoriesUnavailable")}
              </Alert>
            ) : null}
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
          <Alert tone="info" role="status">
            {t("selfTerritories")}
          </Alert>
        ) : null}
      </section>
        </TabsContent>
      </Tabs>

    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">{n}</span>;
}
