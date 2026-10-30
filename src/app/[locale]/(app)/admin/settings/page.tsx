import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card, CardTitle, Input, Select } from "@/components/ui/primitives";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { updateSetting } from "@/modules/admin/actions";
import { ActionForm } from "@/modules/admin/components/action-form";
import { ErrorMessage } from "@/modules/admin/components/action-message";
import { Field } from "@/modules/admin/components/field";
import { CAIRO_DATE_TIME } from "@/modules/admin/format";
import {
  asStringList,
  asTimeRange,
  groupSettings,
  localizedName,
  settingEditState,
  settingUnitKey,
  settingValueText,
  toNumber,
  WEEKDAYS,
} from "@/modules/admin/logic";
import { listSettings } from "@/modules/admin/queries";
import type { SettingRow } from "@/modules/admin/types";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.settings" });
  return { title: t("title") };
}

type T = Awaited<ReturnType<typeof getTranslations>>;
type F = Awaited<ReturnType<typeof getFormatter>>;

const isWeekdayList = (row: SettingRow) => (row.allowed_values ?? []).every((v) => (WEEKDAYS as readonly string[]).includes(v));

/** A value in the viewer's language: numbers with their unit, weekdays and yes/no translated. */
function displayValue(row: SettingRow, value: unknown, t: T, format: F): string {
  switch (row.value_type) {
    case "integer":
    case "number": {
      const n = toNumber(value);
      if (n === null) return settingValueText(value);
      const unit = settingUnitKey(row.unit);
      const num = format.number(n, { maximumFractionDigits: 2, numberingSystem: "latn" });
      return unit ? t(`units.${unit}`, { value: num }) : num;
    }
    case "boolean":
      return value === true ? t("yes") : t("no");
    case "enum_array": {
      const list = asStringList(value);
      if (list.length === 0) return "—";
      return list.map((d) => (isWeekdayList(row) ? t(`weekdays.${d}`) : d)).join(t("listSeparator"));
    }
    case "time_range": {
      const range = asTimeRange(value);
      return range ? `${range.start}–${range.end}` : settingValueText(value);
    }
    default:
      return settingValueText(value);
  }
}

/** Hidden inputs that carry `value` in the same shape as the edit form (used by "reset to default"). */
function ValueInputs({ row, value }: { row: SettingRow; value: unknown }) {
  if (row.value_type === "enum_array") {
    return (
      <>
        {asStringList(value).map((v) => (
          <input key={v} type="hidden" name="value" value={v} />
        ))}
      </>
    );
  }
  if (row.value_type === "time_range") {
    const range = asTimeRange(value);
    return (
      <>
        <input type="hidden" name="start" value={range?.start ?? ""} />
        <input type="hidden" name="end" value={range?.end ?? ""} />
      </>
    );
  }
  return <input type="hidden" name="value" value={settingValueText(value)} />;
}

/** The type-specific control(s) of the edit form. */
function ValueEditor({ row, t }: { row: SettingRow; t: T }) {
  const id = `setting-${row.key}`;
  const min = toNumber(row.min_value);
  const max = toNumber(row.max_value);
  const rangeHint = min !== null && max !== null && row.value_type !== "enum_array" ? t("range", { min, max }) : undefined;
  switch (row.value_type) {
    case "integer":
    case "number":
      return (
        <Field id={id} label={t("newValue")} hint={rangeHint}>
          <Input
            id={id}
            name="value"
            defaultValue={settingValueText(row.value)}
            inputMode={row.value_type === "integer" ? "numeric" : "decimal"}
            dir="ltr"
            required
            autoComplete="off"
            aria-describedby={rangeHint ? `${id}-hint` : undefined}
          />
        </Field>
      );
    case "boolean":
      return (
        <Field id={id} label={t("newValue")}>
          <Select id={id} name="value" defaultValue={row.value === true ? "true" : "false"} className="w-full">
            <option value="true">{t("yes")}</option>
            <option value="false">{t("no")}</option>
          </Select>
        </Field>
      );
    case "enum":
      return (
        <Field id={id} label={t("newValue")}>
          <Select id={id} name="value" defaultValue={settingValueText(row.value)} className="w-full">
            {(row.allowed_values ?? []).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
      );
    case "enum_array": {
      const current = new Set(asStringList(row.value));
      return (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("newValue")}</legend>
          <div className="flex flex-wrap gap-2">
            {(row.allowed_values ?? []).map((v) => (
              <label key={v} className="inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm">
                <input type="checkbox" name="value" value={v} defaultChecked={current.has(v)} className="size-4" />
                {isWeekdayList(row) ? t(`weekdays.${v}`) : v}
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
    case "time_range": {
      const range = asTimeRange(row.value);
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-start`} label={t("start")}>
            <Input id={`${id}-start`} name="start" type="time" defaultValue={range?.start ?? ""} dir="ltr" required />
          </Field>
          <Field id={`${id}-end`} label={t("end")}>
            <Input id={`${id}-end`} name="end" type="time" defaultValue={range?.end ?? ""} dir="ltr" required />
          </Field>
        </div>
      );
    }
    default:
      return (
        <Field id={id} label={t("newValue")}>
          <Input
            id={id}
            name="value"
            defaultValue={settingValueText(row.value)}
            required
            minLength={toNumber(row.min_value) ?? undefined}
            maxLength={toNumber(row.max_value) ?? 500}
            autoComplete="off"
          />
        </Field>
      );
  }
}

export default async function SettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "admin.settings.manage")) return <Forbidden />;

  const t = await getTranslations("admin.settings");
  const format = await getFormatter();
  const settings = await listSettings();
  if (!settings.ok) return <ErrorMessage messageKey={settings.error.messageKey} requestId={settings.error.requestId} />;
  const groups = groupSettings(settings.data);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
        {!ctx.is_owner ? <p className="text-sm text-muted-foreground">{t("ownerOnlyHint")}</p> : null}
      </div>

      {groups.length === 0 ? <p className="text-sm text-muted-foreground">{t("empty")}</p> : null}

      {groups.map((group) => (
        <section key={group.group} aria-labelledby={`group-${group.group}`} className="space-y-3">
          <CardTitle id={`group-${group.group}`}>{t(`groups.${group.labelKey}`)}</CardTitle>
          <ul className="space-y-3">
            {group.items.map((row) => {
              const state = settingEditState(ctx, row);
              const label = localizedName(locale, row.label_en, row.label_ar) || row.key;
              const description = localizedName(locale, row.description_en, row.description_ar);
              return (
                <li key={row.key}>
                  <Card className="space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <h3 className="font-medium">{label}</h3>
                        <code dir="ltr" className="block text-xs break-all text-muted-foreground">
                          {row.key}
                        </code>
                        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {row.owner_only && row.is_whitelisted ? <Badge tone="info">{t("ownerOnly")}</Badge> : null}
                        {state === "fixed" ? <Badge>{t("fixed")}</Badge> : null}
                        {state === "notWhitelisted" ? <Badge tone="warning">{t("notWhitelisted")}</Badge> : null}
                        {!row.is_default ? <Badge tone="warning">{t("modified")}</Badge> : null}
                      </div>
                    </div>

                    <dl className="grid gap-2 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-muted-foreground">{t("current")}</dt>
                        <dd className="font-medium" dir="auto">
                          {displayValue(row, row.value, t, format)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">{t("default")}</dt>
                        <dd dir="auto">{row.is_whitelisted ? displayValue(row, row.default_value, t, format) : "—"}</dd>
                      </div>
                    </dl>
                    {row.updated_at ? (
                      <p className="text-xs text-muted-foreground">
                        {t("lastChanged", { when: format.dateTime(new Date(row.updated_at), CAIRO_DATE_TIME) })}
                      </p>
                    ) : null}
                    {state === "fixed" ? <p className="text-xs text-muted-foreground">{t("fixedHint")}</p> : null}
                    {state === "notWhitelisted" ? <p className="text-xs text-muted-foreground">{t("notWhitelistedHint")}</p> : null}

                    {state === "editable" && row.value_type ? (
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                        <ActionForm action={updateSetting} trigger={t("change")} submitLabel={t("save")} success={t("saved")}>
                          <input type="hidden" name="key" value={row.key} />
                          <input type="hidden" name="value_type" value={row.value_type} />
                          {row.updated_at ? <input type="hidden" name="expected_updated_at" value={row.updated_at} /> : null}
                          <ValueEditor row={row} t={t} />
                          <Field id={`reason-${row.key}`} label={t("reason")} optionalLabel={t("optional")}>
                            <Input
                              id={`reason-${row.key}`}
                              name="reason"
                              maxLength={500}
                              placeholder={t("reasonPlaceholder")}
                              autoComplete="off"
                            />
                          </Field>
                        </ActionForm>
                        {!row.is_default ? (
                          <ActionForm action={updateSetting} trigger={t("reset")} submitLabel={t("resetConfirm")} success={t("saved")}>
                            <input type="hidden" name="key" value={row.key} />
                            <input type="hidden" name="value_type" value={row.value_type} />
                            {row.updated_at ? <input type="hidden" name="expected_updated_at" value={row.updated_at} /> : null}
                            <input type="hidden" name="reason" value={t("resetReason")} />
                            <ValueInputs row={row} value={row.default_value} />
                            <p className="text-sm text-muted-foreground">
                              {t("resetTo", { value: displayValue(row, row.default_value, t, format) })}
                            </p>
                          </ActionForm>
                        ) : null}
                      </div>
                    ) : null}
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
