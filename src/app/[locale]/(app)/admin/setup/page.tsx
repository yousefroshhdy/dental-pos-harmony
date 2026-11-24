import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { CheckIcon, MapIcon, UsersIcon, WarehouseIcon } from "lucide-react";
import { ListError } from "@/components/page-kit/list-error";
import { PageError } from "@/components/page-kit/page-error";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Badge, Card, CardTitle, Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { createTerritory, setTerritoryCoverage } from "@/modules/admin/actions";
import { ActionForm } from "@/modules/admin/components/action-form";
import { Field } from "@/modules/admin/components/field";
import { BaseLocationForm } from "@/modules/admin/components/setup/base-location-form";
import { LegacyImportCard } from "@/modules/imports/legacy/components/setup-card";
import { LoginForm } from "@/modules/admin/components/setup/login-form";
import { activeRolesByUser, localizedName } from "@/modules/admin/logic";
import { listAllTerritories, listCoverage, listEmployees, listOpenAssignments, listRoles } from "@/modules/admin/queries";
import {
  IMPORT_SEQUENCE,
  MANSOURA,
  mansouraNeedingCoverage,
  mapsLink,
  SALES_MANAGER_ROLE,
  setupRoles,
  setupSteps,
} from "@/modules/admin/setup";
import { addLegacyCatalog, addSetupPerson, createMainWarehouse } from "@/modules/admin/setup-actions";
import { getSetupOverview, listBaseLocations, listWarehouses } from "@/modules/admin/setup-queries";

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "setup" });
  return { title: t("title") };
}

/**
 * Owner setup (Phase P step 1): one place for the main warehouse, territories, people with roles
 * and logins, reps' base addresses, and the order of the data imports. Owner only (UX gate; every
 * command re-checks in Postgres, and api.setup_overview refuses anyone else).
 */
export default async function SetupPage({ params }: { params: Params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!ctx.is_owner) return <Forbidden />;
  const uiLocale = locale === "en" ? "en" : "ar";

  const t = await getTranslations("setup");
  const [overview, warehouses, territories, coverage, employees, bases, roles, assignments] = await Promise.all([
    getSetupOverview(),
    listWarehouses(),
    listAllTerritories(),
    listCoverage(),
    listEmployees(),
    listBaseLocations(),
    listRoles(),
    listOpenAssignments(),
  ]);
  const header = <PageHeader title={t("title")} description={t("intro")} />;
  if (!overview.ok) return <PageError back={header} error={overview.error} />;
  const o = overview.data;

  const steps = o ? setupSteps(o) : [];
  const mainWarehouses = (warehouses.ok ? warehouses.data : []).filter((w) => w.is_active);
  const activeTerritories = (territories.ok ? territories.data : []).filter((x) => x.is_active);
  const mansoura = mansouraNeedingCoverage(activeTerritories, coverage.ok ? coverage.data : []);
  const coverageByTerritory = new Map<string, string[]>();
  for (const c of coverage.ok ? coverage.data : []) {
    const list = coverageByTerritory.get(c.territory_id) ?? [];
    list.push(c.city === "*" ? localizedName(locale, c.governorate_name_en, c.governorate_name_ar) : `${localizedName(locale, c.governorate_name_en, c.governorate_name_ar)} · ${c.city}`);
    coverageByTerritory.set(c.territory_id, list);
  }
  const roleChoices = setupRoles(roles.ok ? roles.data : []).map((r) => ({
    id: r.id,
    label: `${localizedName(locale, r.name_en, r.name_ar)}${r.code === SALES_MANAGER_ROLE ? ` · ${t("people.salesManager")}` : ""}`,
  }));
  const repRoleId = (roles.ok ? roles.data : []).find((r) => r.code === "sales_rep")?.id;
  const territoryChoices = activeTerritories.map((x) => ({ id: x.id, label: `${localizedName(locale, x.name_en, x.name_ar)} (${x.code})` }));
  const rolesByUser = activeRolesByUser(assignments.ok ? assignments.data : [], roles.ok ? roles.data : [], new Date());
  const baseById = new Map((bases.ok ? bases.data : []).map((b) => [b.employee_id, b]));
  const people = (employees.ok ? employees.data : []).filter((e) => e.employment_status === "active");
  const newWarehouseId = crypto.randomUUID();
  const doneCount = steps.filter((s) => s.done).length;
  const pct = steps.length === 0 ? 0 : Math.round((doneCount / steps.length) * 100);

  return (
    <div className="space-y-6">
      {header}

      {/* Checklist */}
      <Card className="space-y-4">
        <section aria-labelledby="setup-progress" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="setup-progress" className="text-lg font-semibold">
            {t("progress.title")}
          </h2>
          <span className="text-sm text-muted-foreground tabular-nums">{t("progress.countOf", { count: doneCount, total: steps.length })}</span>
        </div>
        <div
          role="progressbar"
          aria-labelledby="setup-progress"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={doneCount}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        <ol className="grid gap-2 sm:grid-cols-2">
          {steps.map((s, i) => (
            <li key={s.key}>
              <a
                href={s.href.startsWith("#") ? s.href : `/${locale}${s.href}`}
                className="flex min-h-11 items-center gap-3 rounded-md border bg-card px-3 py-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums",
                    s.done ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                  )}
                >
                  {s.done ? <CheckIcon className="size-4" /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{t(`progress.steps.${s.key}`)}</span>
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    {s.total === undefined ? t("progress.count", { count: s.count }) : t("progress.countOf", { count: s.count, total: s.total })}
                  </span>
                </span>
                <Badge tone={s.done ? "success" : "warning"}>{s.done ? t("progress.done") : t("progress.todo")}</Badge>
              </a>
            </li>
          ))}
        </ol>
        </section>
      </Card>

      {/* 1. Main warehouse */}
      <section id="setup-warehouse" aria-labelledby="setup-warehouse-title" className="scroll-mt-20 space-y-3 rounded-lg border bg-card p-4 shadow-sm sm:p-6">
        <CardTitle id="setup-warehouse-title" className="flex items-center gap-2">
          <StepNo n={1} />
          {t("warehouse.title")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("warehouse.intro")}</p>
        {!warehouses.ok ? (
          <ListError compact error={warehouses.error} />
        ) : mainWarehouses.length === 0 ? (
          <EmptyState compact icon={<WarehouseIcon aria-hidden="true" />} title={t("warehouse.empty")} />
        ) : (
          <ul className="space-y-1 text-sm">
            {mainWarehouses.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-2">
                <code dir="ltr">{w.code}</code> <span>{w.name}</span> <Badge>{t(`warehouse.kinds.${w.kind}`)}</Badge>
              </li>
            ))}
          </ul>
        )}
        {o && o.main_warehouses === 0 ? (
          <Card className="bg-muted/40 shadow-none">
            <ActionForm action={createMainWarehouse} submitLabel={t("warehouse.create")} success={t("saved")} fieldsClassName="sm:grid-cols-2">
              <input type="hidden" name="warehouse_id" value={newWarehouseId} />
              <Field id="wh-code" label={t("warehouse.code")} hint={t("warehouse.codeHint")}>
                <Input id="wh-code" name="code" required maxLength={40} dir="ltr" defaultValue="WH-MAIN" />
              </Field>
              <Field id="wh-name" label={t("warehouse.name")}>
                <Input id="wh-name" name="name" required maxLength={120} defaultValue={t("warehouse.defaultName")} />
              </Field>
            </ActionForm>
          </Card>
        ) : null}
      </section>

      {/* 2. Territories */}
      <section id="setup-territories" aria-labelledby="setup-territories-title" className="scroll-mt-20 space-y-3 rounded-lg border bg-card p-4 shadow-sm sm:p-6">
        <CardTitle id="setup-territories-title" className="flex items-center gap-2">
          <StepNo n={2} />
          {t("territories.title")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("territories.intro")}</p>
        {!territories.ok ? (
          <ListError compact error={territories.error} />
        ) : activeTerritories.length === 0 ? (
          <EmptyState compact icon={<MapIcon aria-hidden="true" />} title={t("territories.empty")} />
        ) : (
          <ul className="space-y-1 text-sm">
            {activeTerritories.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{localizedName(locale, x.name_en, x.name_ar)}</span>
                <code dir="ltr" className="text-xs text-muted-foreground">
                  {x.code}
                </code>
                <span className="text-muted-foreground">{(coverageByTerritory.get(x.id) ?? []).join("، ") || t("territories.noCoverage")}</span>
              </li>
            ))}
          </ul>
        )}
        {mansoura ? (
          <Card className="space-y-2 bg-muted/40 shadow-none">
            <p className="text-sm">{t("territories.mansouraHint")}</p>
            <ActionForm action={setTerritoryCoverage} submitLabel={t("territories.coverMansoura")} success={t("saved")}>
              <input type="hidden" name="territory_id" value={mansoura.id} />
              <input type="hidden" name="governorate_code" value={MANSOURA.governorateCode} />
            </ActionForm>
          </Card>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <ActionForm action={createTerritory} trigger={t("territories.add")} submitLabel={t("territories.create")} success={t("saved")}>
            <Field id="tr-code" label={t("territories.code")}>
              <Input id="tr-code" name="code" required maxLength={40} dir="ltr" />
            </Field>
            <Field id="tr-en" label={t("territories.nameEn")}>
              <Input id="tr-en" name="name_en" required maxLength={120} dir="ltr" />
            </Field>
            <Field id="tr-ar" label={t("territories.nameAr")}>
              <Input id="tr-ar" name="name_ar" required maxLength={120} dir="rtl" />
            </Field>
          </ActionForm>
          <Link href="/admin/territories" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
            {t("territories.manage")}
          </Link>
        </div>
      </section>

      {/* 3. People: employees, logins, roles, base addresses */}
      <section id="setup-people" aria-labelledby="setup-people-title" className="scroll-mt-20 space-y-3 rounded-lg border bg-card p-4 shadow-sm sm:p-6">
        <CardTitle id="setup-people-title" className="flex items-center gap-2">
          <StepNo n={3} />
          {t("people.title")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("people.intro")}</p>
        <ActionForm action={addSetupPerson} trigger={t("people.add")} submitLabel={t("people.create")} success={t("saved")} fieldsClassName="sm:grid-cols-2">
          <input type="hidden" name="locale" value={uiLocale} />
          <Field id="p-no" label={t("people.employeeNo")}>
            <Input id="p-no" name="employee_no" required maxLength={40} dir="ltr" />
          </Field>
          <Field id="p-title" label={t("people.jobTitle")} hint={t("people.jobTitleHint")}>
            <Input id="p-title" name="job_title" required minLength={2} maxLength={120} />
          </Field>
          <Field id="p-en" label={t("people.nameEn")}>
            <Input id="p-en" name="full_name_en" required minLength={2} maxLength={160} dir="ltr" />
          </Field>
          <Field id="p-ar" label={t("people.nameAr")} optionalLabel={t("optional")}>
            <Input id="p-ar" name="full_name_ar" maxLength={160} dir="rtl" />
          </Field>
          <Field id="p-email" label={t("people.email")} hint={t("people.emailHint")}>
            <Input id="p-email" name="email" type="email" maxLength={254} dir="ltr" autoComplete="off" />
          </Field>
          <Field id="p-phone" label={t("people.phone")} optionalLabel={t("optional")}>
            <Input id="p-phone" name="phone" type="tel" inputMode="tel" maxLength={20} dir="ltr" autoComplete="off" />
          </Field>
        </ActionForm>

        {!employees.ok ? (
          <ListError compact error={employees.error} />
        ) : people.length === 0 ? (
          <EmptyState compact icon={<UsersIcon aria-hidden="true" />} title={t("people.empty")} />
        ) : (
          <ul className="space-y-3">
            {people.map((e) => {
              const base = baseById.get(e.id);
              const held = e.user_id ? (rolesByUser.get(e.user_id) ?? []) : [];
              const isOwner = held.some((r) => r.isOwnerRole);
              const isRep = held.some((r) => r.code === "sales_rep");
              return (
                <li key={e.id}>
                  <Card className="space-y-3 bg-background p-3 shadow-none sm:p-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <h3 className="font-medium">{localizedName(locale, e.full_name_en, e.full_name_ar)}</h3>
                        <p className="text-sm text-muted-foreground">
                          <code dir="ltr">{e.employee_no}</code> · {e.job_title}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {held.map((r) => (
                          <Badge key={r.assignmentId} tone="info">
                            {localizedName(locale, r.nameEn, r.nameAr)}
                          </Badge>
                        ))}
                        <Badge tone={e.user_id ? "success" : "warning"}>{e.user_id ? t("people.hasLogin") : t("people.noLogin")}</Badge>
                        {isRep || base?.base_lat != null ? (
                          <Badge tone={base?.base_lat != null ? "success" : "warning"}>
                            {base?.base_lat != null ? t("people.hasBase", { km: base.lead_radius_km }) : t("people.noBase")}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    {base?.base_lat != null && base.base_lng != null ? (
                      <p className="text-xs text-muted-foreground">
                        {base.base_address ? `${base.base_address} · ` : null}
                        <a href={mapsLink(base.base_lat, base.base_lng)} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline" dir="ltr">
                          {base.base_lat}, {base.base_lng}
                        </a>
                        {` · ${t(`people.sources.${base.base_location_source ?? "manual"}`)}`}
                      </p>
                    ) : null}
                    {isOwner ? null : (
                      <div className="grid gap-2 lg:grid-cols-2">
                        <details className="rounded-md border p-3">
                          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">{e.user_id ? t("people.loginLink") : t("people.createLogin")}</summary>
                          <div className="mt-2">
                            {e.email ? (
                              <LoginForm
                                employeeId={e.id}
                                hasLogin={e.user_id !== null}
                                roles={roleChoices}
                                territories={territoryChoices}
                                defaultRoleId={e.user_id ? undefined : repRoleId}
                              />
                            ) : (
                              <p className="text-sm text-muted-foreground">{t("people.needsEmail")}</p>
                            )}
                          </div>
                        </details>
                        <details className="rounded-md border p-3">
                          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">{t("people.baseAddress")}</summary>
                          <div className="mt-2">
                            <BaseLocationForm
                              employeeId={e.id}
                              uiLocale={uiLocale}
                              defaults={{
                                address: base?.base_address ?? null,
                                lat: base?.base_lat ?? null,
                                lng: base?.base_lng ?? null,
                                radius: base?.lead_radius_km ?? 5,
                              }}
                            />
                          </div>
                        </details>
                      </div>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 4. Imports, in order */}
      <section id="setup-imports" aria-labelledby="setup-imports-title" className="scroll-mt-20 space-y-3 rounded-lg border bg-card p-4 shadow-sm sm:p-6">
        <CardTitle id="setup-imports-title" className="flex items-center gap-2">
          <StepNo n={4} />
          {t("imports.title")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("imports.intro")}</p>
        <LegacyImportCard />
        {o && o.legacy_catalog_missing.length > 0 ? (
          <Card className="space-y-2 bg-muted/40 shadow-none">
            <p className="text-sm">{t("imports.catalogHint", { codes: o.legacy_catalog_missing.join(", ") })}</p>
            <ActionForm action={addLegacyCatalog} submitLabel={t("imports.catalogAdd")} success={t("saved")}>
              {null}
            </ActionForm>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">{t("imports.catalogReady")}</p>
        )}
        <ol className="list-decimal space-y-2 ps-5 text-sm">
          {IMPORT_SEQUENCE.map((s) => (
            <li key={s.file}>
              <Link href={`/imports?kind=${s.kind}`} className="inline-flex min-h-11 items-center gap-2 text-primary underline-offset-4 hover:underline">
                <code dir="ltr">{s.file}</code>
              </Link>
              <span className="block text-muted-foreground">{t(`imports.files.${s.key}`)}</span>
            </li>
          ))}
        </ol>
        {o && o.customers_phone_missing > 0 ? (
          <Alert tone="warning" role="status">
            {t("imports.phoneMissing", { count: o.customers_phone_missing })}
          </Alert>
        ) : null}
      </section>
    </div>
  );
}

function StepNo({ n }: { n: number }) {
  return (
    <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground tabular-nums">
      {n}
    </span>
  );
}
