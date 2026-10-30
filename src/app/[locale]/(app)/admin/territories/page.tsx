import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card, CardTitle, Input, Select, Table, Td, Th } from "@/components/ui/primitives";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import {
  createTerritory,
  moveTerritory,
  removeTerritoryCoverage,
  renameTerritory,
  setTerritoryActive,
  setTerritoryCoverage,
} from "@/modules/admin/actions";
import { ActionForm } from "@/modules/admin/components/action-form";
import { ErrorMessage } from "@/modules/admin/components/action-message";
import { Field } from "@/modules/admin/components/field";
import {
  buildTerritoryTree,
  canDeactivate,
  canReactivate,
  flattenTree,
  localizedName,
  moveTargets,
  parentOptions,
  unassignedCustomers,
  type TerritoryNode,
} from "@/modules/admin/logic";
import { listAllTerritories, listCoverage, listGovernorates, listTerritoryCounts } from "@/modules/admin/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.territories" });
  return { title: t("title") };
}

/** Indentation per depth (logical property, so it mirrors in RTL). */
const INDENT = ["ps-0", "ps-4 sm:ps-8", "ps-8 sm:ps-16"] as const;

export default async function TerritoriesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "core.territory.manage")) return <Forbidden />;

  const t = await getTranslations("admin.territories");
  const tCommon = await getTranslations("admin.common");
  const [territories, counts, coverage, governorates] = await Promise.all([
    listAllTerritories(),
    listTerritoryCounts(),
    listCoverage(),
    listGovernorates(),
  ]);
  if (!territories.ok) return <ErrorMessage messageKey={territories.error.messageKey} requestId={territories.error.requestId} />;

  const roots = buildTerritoryTree(territories.data, counts.ok ? counts.data : []);
  const flat = flattenTree(roots);
  const byId = new Map(flat.map((n) => [n.territory.id, n]));
  const label = (n: TerritoryNode) => `${localizedName(locale, n.territory.name_en, n.territory.name_ar)} (${n.territory.code})`;
  const company = can(ctx, "core.territory.manage", "all");
  const unassigned = counts.ok ? unassignedCustomers(counts.data) : null;
  const activeTerritories = flat.filter((n) => n.territory.is_active);
  const govName = new Map((governorates.ok ? governorates.data : []).map((g) => [g.code, localizedName(locale, g.name_en, g.name_ar)]));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
        {!counts.ok ? <p className="text-sm text-muted-foreground">{t("countsUnavailable")}</p> : null}
        {unassigned !== null && unassigned > 0 ? <p className="text-sm font-medium">{t("unassigned", { count: unassigned })}</p> : null}
      </div>

      <section aria-labelledby="tree-title" className="space-y-3">
        <CardTitle id="tree-title">{t("tree")}</CardTitle>
        {flat.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="space-y-2">
            {flat.map((node) => {
              const tr = node.territory;
              const parent = tr.parent_id ? byId.get(tr.parent_id) : undefined;
              const targets = moveTargets(flat, node);
              const mayRoot = company && tr.parent_id !== null;
              return (
                <li key={tr.id} className={cn(INDENT[Math.min(node.depth, 2)])}>
                  <Card className={cn("space-y-3 p-3 sm:p-4", !tr.is_active && "opacity-75")}>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <h3 className="font-medium">
                          {node.depth > 0 ? (
                            <span aria-hidden className="me-1 text-muted-foreground">
                              └
                            </span>
                          ) : null}
                          {localizedName(locale, tr.name_en, tr.name_ar)}
                        </h3>
                        <code dir="ltr" className="text-xs text-muted-foreground">
                          {tr.code}
                        </code>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <Badge>{t(`levels.${tr.level ?? "area"}`)}</Badge>
                        {!tr.is_active ? <Badge tone="warning">{t("inactive")}</Badge> : null}
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {t("customers", { count: node.customers })}
                      {node.children.length > 0 ? ` · ${t("customersTotal", { count: node.totalCustomers })}` : null}
                      {` · ${t("activeCustomers", { count: node.activeCustomers })}`}
                      {` · ${t("employees", { count: node.employees })}`}
                    </p>

                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
                      <ActionForm action={renameTerritory} trigger={t("rename")} submitLabel={t("renameSubmit")} success={t("saved")}>
                        <input type="hidden" name="territory_id" value={tr.id} />
                        <Field id={`rename-en-${tr.id}`} label={t("nameEn")}>
                          <Input id={`rename-en-${tr.id}`} name="name_en" required maxLength={120} dir="ltr" defaultValue={tr.name_en} />
                        </Field>
                        <Field id={`rename-ar-${tr.id}`} label={t("nameAr")}>
                          <Input id={`rename-ar-${tr.id}`} name="name_ar" required maxLength={120} dir="rtl" defaultValue={tr.name_ar ?? ""} />
                        </Field>
                      </ActionForm>

                      {targets.length > 0 || mayRoot ? (
                        <ActionForm action={moveTerritory} trigger={t("move")} submitLabel={t("moveSubmit")} success={t("saved")}>
                          <input type="hidden" name="territory_id" value={tr.id} />
                          <Field id={`move-${tr.id}`} label={t("moveTo")} hint={t("moveHint")}>
                            <Select id={`move-${tr.id}`} name="parent_id" required defaultValue="" className="w-full">
                              <option value="" disabled>
                                {t("selectParent")}
                              </option>
                              {mayRoot ? <option value="root">{t("moveRoot")}</option> : null}
                              {targets.map((n) => (
                                <option key={n.territory.id} value={n.territory.id}>
                                  {label(n)}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field id={`move-reason-${tr.id}`} label={tCommon("reason")} optionalLabel={t("optional")}>
                            <Input id={`move-reason-${tr.id}`} name="reason" maxLength={500} autoComplete="off" />
                          </Field>
                        </ActionForm>
                      ) : null}

                      {canDeactivate(node) ? (
                        <ActionForm action={setTerritoryActive} trigger={t("deactivate")} submitLabel={t("deactivateConfirm")} destructive>
                          <input type="hidden" name="territory_id" value={tr.id} />
                          <input type="hidden" name="active" value="false" />
                          <p className="text-sm text-muted-foreground">{t("deactivateHint")}</p>
                          <Field id={`deact-${tr.id}`} label={tCommon("reason")}>
                            <Input
                              id={`deact-${tr.id}`}
                              name="reason"
                              required
                              minLength={3}
                              maxLength={500}
                              placeholder={tCommon("reasonPlaceholder")}
                              autoComplete="off"
                            />
                          </Field>
                        </ActionForm>
                      ) : tr.is_active ? (
                        <p className="text-xs text-muted-foreground">{t("hasChildren")}</p>
                      ) : null}

                      {canReactivate(node, parent) ? (
                        <ActionForm action={setTerritoryActive} trigger={t("reactivate")} submitLabel={t("reactivateConfirm")}>
                          <input type="hidden" name="territory_id" value={tr.id} />
                          <input type="hidden" name="active" value="true" />
                          <Field id={`react-${tr.id}`} label={tCommon("reason")}>
                            <Input
                              id={`react-${tr.id}`}
                              name="reason"
                              required
                              minLength={3}
                              maxLength={500}
                              placeholder={tCommon("reasonPlaceholder")}
                              autoComplete="off"
                            />
                          </Field>
                        </ActionForm>
                      ) : !tr.is_active ? (
                        <p className="text-xs text-muted-foreground">{t("parentInactive")}</p>
                      ) : null}
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Card className="space-y-3">
        <div>
          <CardTitle>{t("createTitle")}</CardTitle>
          <p className="text-sm text-muted-foreground">{company ? t("createHint") : t("createHintScoped")}</p>
        </div>
        <ActionForm action={createTerritory} submitLabel={t("createSubmit")} success={t("created")} fieldsClassName="sm:grid-cols-2">
          <Field id="new-code" label={t("code")} hint={t("codeHint")}>
            <Input
              id="new-code"
              name="code"
              required
              minLength={2}
              maxLength={40}
              dir="ltr"
              autoComplete="off"
              pattern="[A-Za-z0-9][A-Za-z0-9\-]{1,39}"
              aria-describedby="new-code-hint"
            />
          </Field>
          <Field id="new-parent" label={t("parent")}>
            <Select id="new-parent" name="parent_id" defaultValue="" className="w-full" required={!company}>
              {company ? <option value="">{t("noParent")}</option> : <option value="" disabled>{t("selectParent")}</option>}
              {parentOptions(flat).map((n) => (
                <option key={n.territory.id} value={n.territory.id}>
                  {label(n)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="new-name-en" label={t("nameEn")}>
            <Input id="new-name-en" name="name_en" required maxLength={120} dir="ltr" autoComplete="off" />
          </Field>
          <Field id="new-name-ar" label={t("nameAr")}>
            <Input id="new-name-ar" name="name_ar" required maxLength={120} dir="rtl" autoComplete="off" />
          </Field>
        </ActionForm>
      </Card>

      <section aria-labelledby="coverage-title" className="space-y-3">
        <div>
          <CardTitle id="coverage-title">{t("coverageTitle")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("coverageHint")}</p>
        </div>
        {!coverage.ok ? (
          <ErrorMessage messageKey={coverage.error.messageKey} requestId={coverage.error.requestId} />
        ) : coverage.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("coverageEmpty")}</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("governorate")}</Th>
                <Th>{t("city")}</Th>
                <Th>{t("coverageTerritory")}</Th>
                <Th>{tCommon("actions")}</Th>
              </tr>
            </thead>
            <tbody>
              {coverage.data.map((c) => (
                <tr key={`${c.governorate_code}-${c.city}`}>
                  <Td className="min-w-32">{localizedName(locale, c.governorate_name_en, c.governorate_name_ar)}</Td>
                  <Td>{c.city === "*" ? <span className="text-muted-foreground">{t("wholeGovernorate")}</span> : c.city}</Td>
                  <Td className="min-w-32">
                    {localizedName(locale, c.territory_name_en, c.territory_name_ar)}
                    {!c.territory_active ? <Badge tone="warning" className="ms-2">{t("inactive")}</Badge> : null}
                  </Td>
                  <Td className="min-w-40">
                    <ActionForm action={removeTerritoryCoverage} trigger={t("removeCoverage")} submitLabel={t("removeCoverageConfirm")} destructive>
                      <input type="hidden" name="governorate_code" value={c.governorate_code} />
                      <input type="hidden" name="city" value={c.city} />
                      <p className="text-sm text-muted-foreground">{t("removeCoverageHint")}</p>
                    </ActionForm>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <Card className="space-y-3">
          <CardTitle>{t("addCoverage")}</CardTitle>
          {!governorates.ok ? <p className="text-sm text-muted-foreground">{t("governoratesUnavailable")}</p> : null}
          {activeTerritories.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ActionForm action={setTerritoryCoverage} submitLabel={t("addCoverageSubmit")} success={t("coverageSaved")} fieldsClassName="sm:grid-cols-3">
              <Field id="cov-gov" label={t("governorate")}>
                <Select id="cov-gov" name="governorate_code" required defaultValue="" className="w-full">
                  <option value="" disabled>
                    {t("selectGovernorate")}
                  </option>
                  {[...govName.entries()].map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="cov-city" label={t("city")} optionalLabel={t("optional")} hint={t("cityHint")}>
                <Input id="cov-city" name="city" maxLength={80} autoComplete="off" aria-describedby="cov-city-hint" />
              </Field>
              <Field id="cov-territory" label={t("coverageTerritory")}>
                <Select id="cov-territory" name="territory_id" required defaultValue="" className="w-full">
                  <option value="" disabled>
                    {t("selectTerritory")}
                  </option>
                  {activeTerritories.map((n) => (
                    <option key={n.territory.id} value={n.territory.id}>
                      {label(n)}
                    </option>
                  ))}
                </Select>
              </Field>
            </ActionForm>
          )}
        </Card>
      </section>
    </div>
  );
}
