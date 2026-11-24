import { ChevronDownIcon, FilterIcon, SearchIcon } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { FormCombobox, FormDatePicker } from "@/components/page-kit/form-controls";
import { Button, buttonVariants } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Link } from "@/i18n/navigation";
import { localizedName, tableKey, tableRef } from "../logic";
import { AUDIT_ACTIONS, type ActorOption, type AuditFilters, type AuditTable } from "../types";

/**
 * Search filters as a GET form (the URL is shareable). Table and actor are searchable
 * pickers, the dates a calendar; each submits through a hidden input with the same
 * name the plain form used, so parseAuditSearch is unchanged. Folded once a filter
 * is set, so the results come first; the summary counts the active filters.
 */
export async function AuditSearchForm({
  filters,
  tables,
  actors,
}: {
  filters: AuditFilters;
  tables: AuditTable[];
  /** null: no user list available, the actor filter takes a user id. */
  actors: ActorOption[] | null;
}) {
  const t = await getTranslations("audit");
  const locale = await getLocale();
  const current = filters.tableSchema && filters.tableName ? tableRef(filters.tableSchema, filters.tableName) : "";
  const options = tables
    .map((x) => {
      const ref = tableRef(x.table_schema, x.table_name);
      const key = tableKey(x.table_schema, x.table_name);
      return { value: ref, label: t.has(key) ? t(key) : ref, description: ref, keywords: [ref] };
    })
    .sort((a, b) => a.label.localeCompare(b.label, locale));
  if (current && !options.some((o) => o.value === current)) options.unshift({ value: current, label: current, description: current, keywords: [current] });
  const active = [filters.tableName, filters.recordId, filters.actorUserId, filters.from, filters.to, filters.action].filter(Boolean).length;

  return (
    <details open={active === 0 || undefined} className="rounded-lg border bg-card shadow-sm">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 sm:px-4 [&::-webkit-details-marker]:hidden">
        <span id="audit-search-heading" className="flex items-center gap-2 text-base font-semibold">
          <FilterIcon aria-hidden="true" className="size-4" />
          {t("search.legend")}
          {active > 0 ? <span className="rounded-full bg-primary px-2 text-xs text-primary-foreground tabular-nums">{active}</span> : null}
        </span>
        <ChevronDownIcon aria-hidden="true" className="size-4 text-muted-foreground transition-transform [details[open]_&]:rotate-180" />
      </summary>
      <form method="get" aria-labelledby="audit-search-heading" className="space-y-3 border-t p-3 sm:p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FormField label={t("search.table")}>
            <FormCombobox
              name="table"
              options={options}
              defaultValue={current}
              placeholder={t("search.anyTable")}
              searchPlaceholder={t("search.table")}
              emptyText={t("list.empty")}
            />
          </FormField>
          <FormField label={t("search.record")} hint={t("search.recordHint")}>
            <Input
              name="record"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              defaultValue={filters.recordId ?? ""}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </FormField>
          <FormField label={t("search.actor")}>
            {actors ? (
              <FormCombobox
                name="actor"
                options={actors.map((a) => ({
                  value: a.user_id,
                  label: localizedName(locale, a.full_name_en, a.full_name_ar) || a.employee_no || a.user_id,
                  description: a.employee_no ?? undefined,
                  keywords: [a.full_name_en ?? "", a.full_name_ar ?? "", a.employee_no ?? ""].filter(Boolean),
                }))}
                defaultValue={filters.actorUserId ?? ""}
                placeholder={t("search.anyActor")}
                searchPlaceholder={t("search.actor")}
                emptyText={t("list.empty")}
              />
            ) : (
              <Input name="actor" dir="ltr" autoComplete="off" spellCheck={false} defaultValue={filters.actorUserId ?? ""} placeholder={t("search.actorId")} />
            )}
          </FormField>
          <FormField label={t("search.from")}>
            <FormDatePicker name="from" defaultValue={filters.from ?? null} placeholder={t("search.from")} clearLabel={t("search.reset")} max={filters.to ?? undefined} />
          </FormField>
          <FormField label={t("search.to")}>
            <FormDatePicker name="to" defaultValue={filters.to ?? null} placeholder={t("search.to")} clearLabel={t("search.reset")} min={filters.from ?? undefined} />
          </FormField>
          <FormField label={t("search.action")}>
            <NativeSelect name="action" defaultValue={filters.action ?? ""} className="w-full">
              <option value="">{t("search.anyAction")}</option>
              {AUDIT_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {t(`actions.${a}`)}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        </div>
        <p className="text-xs text-muted-foreground">{t("search.datesHint")}</p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Link href="/audit" prefetch={false} className={buttonVariants({ variant: "outline" })}>
            {t("search.reset")}
          </Link>
          <Button type="submit">
            <SearchIcon aria-hidden="true" />
            {t("search.submit")}
          </Button>
        </div>
      </form>
    </details>
  );
}
