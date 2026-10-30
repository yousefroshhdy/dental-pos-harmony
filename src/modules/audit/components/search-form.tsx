import { getLocale, getTranslations } from "next-intl/server";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { localizedName, tableKey, tableRef } from "../logic";
import { AUDIT_ACTIONS, type ActorOption, type AuditFilters, type AuditTable } from "../types";

/** Search filters as a plain GET form (works without JavaScript; the URL is shareable). */
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
      return { ref, label: t.has(key) ? `${t(key)} (${ref})` : ref };
    })
    .sort((a, b) => a.label.localeCompare(b.label, locale));
  if (current && !options.some((o) => o.ref === current)) options.unshift({ ref: current, label: current });

  return (
    <form method="get" aria-labelledby="audit-search-heading" className="space-y-3 rounded-lg border bg-card p-3 sm:p-4">
      <h2 id="audit-search-heading" className="text-lg font-semibold">
        {t("search.legend")}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-table">{t("search.table")}</Label>
          <Select id="audit-table" name="table" defaultValue={current} className="w-full">
            <option value="">{t("search.anyTable")}</option>
            {options.map((o) => (
              <option key={o.ref} value={o.ref}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-record">{t("search.record")}</Label>
          <Input
            id="audit-record"
            name="record"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            defaultValue={filters.recordId ?? ""}
            placeholder="00000000-0000-0000-0000-000000000000"
            aria-describedby="audit-record-hint"
          />
          <span id="audit-record-hint" className="text-xs text-muted-foreground">
            {t("search.recordHint")}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-actor">{t("search.actor")}</Label>
          {actors ? (
            <Select id="audit-actor" name="actor" defaultValue={filters.actorUserId ?? ""} className="w-full">
              <option value="">{t("search.anyActor")}</option>
              {actors.map((a) => (
                <option key={a.user_id} value={a.user_id}>
                  {[a.employee_no, localizedName(locale, a.full_name_en, a.full_name_ar)].filter(Boolean).join(" · ") || a.user_id}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id="audit-actor"
              name="actor"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              defaultValue={filters.actorUserId ?? ""}
              placeholder={t("search.actorId")}
            />
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-from">{t("search.from")}</Label>
          <Input id="audit-from" name="from" type="date" defaultValue={filters.from ?? ""} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-to">{t("search.to")}</Label>
          <Input id="audit-to" name="to" type="date" defaultValue={filters.to ?? ""} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-action">{t("search.action")}</Label>
          <Select id="audit-action" name="action" defaultValue={filters.action ?? ""} className="w-full">
            <option value="">{t("search.anyAction")}</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(`actions.${a}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("search.datesHint")}</p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Link href="/audit" prefetch={false} className={buttonVariants({ variant: "outline" })}>
          {t("search.reset")}
        </Link>
        <Button type="submit">{t("search.submit")}</Button>
      </div>
    </form>
  );
}
