import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { AccessNotice } from "@/modules/audit/components/access-notice";
import { AuditEntryCard, tableLabel } from "@/modules/audit/components/audit-entry";
import { AuditError } from "@/modules/audit/components/audit-error";
import { historyHref, maskedCategories, nextBeforeId, recordHref, tableRef, withQuery } from "@/modules/audit/logic";
import { HISTORY_PAGE_SIZE, recordHistory } from "@/modules/audit/queries";
import { parseAuditSearch, parseRecordRoute, type SearchParams } from "@/modules/audit/schemas";

type Params = { locale: string; table: string; recordId: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "audit.history" });
  return { title: t("title") };
}

export default async function AuditRecordPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<SearchParams> }) {
  const { locale, table, recordId } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "audit.row_image.read", "all")) return <Forbidden />;

  const t = await getTranslations("audit");
  const route = parseRecordRoute(table, recordId);
  if (!route) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">{t("history.title")}</h1>
        <Card className="text-sm text-muted-foreground">{t("history.invalid")}</Card>
        <Link href="/audit" className={buttonVariants({ variant: "outline" })}>
          {t("history.back")}
        </Link>
      </div>
    );
  }

  const { filters } = parseAuditSearch(await searchParams);
  const entries = await recordHistory(route.schema, route.table, route.recordId, { beforeId: filters.beforeId, reveal: filters.reveal });
  const self = historyHref(route.schema, route.table, route.recordId) ?? "/audit";
  const before = entries.ok ? nextBeforeId(entries.data, HISTORY_PAGE_SIZE) : null;
  const latest = entries.ok ? entries.data[0] : undefined;
  const record = recordHref(
    latest ?? { table_schema: route.schema, table_name: route.table, record_id: route.recordId, old_data: null, new_data: null },
  );
  const label = await tableLabel(route.schema, route.table);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link href="/audit" prefetch={false} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("history.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{t("history.title")}</h1>
        <p className="text-sm">
          {label}{" "}
          <code dir="ltr" className="text-xs text-muted-foreground">
            {tableRef(route.schema, route.table)}
          </code>
        </p>
        <p className="text-sm break-all">
          <span className="text-muted-foreground">{t("entry.record")} </span>
          <code dir="ltr" className="text-xs">
            {route.recordId}
          </code>
        </p>
        {record ? (
          <Link href={record} prefetch={false} className={buttonVariants({ variant: "outline" })}>
            {t("entry.openRecord")}
          </Link>
        ) : null}
      </div>

      <AccessNotice
        maskedCategories={entries.ok ? maskedCategories(entries.data) : []}
        canReveal={can(ctx, "audit.row_image.unmask", "all")}
        revealed={filters.reveal}
        hiddenInputs={{ before: filters.beforeId }}
        hideHref={withQuery(self, { before: filters.beforeId })}
        canSeeSecurityLog={can(ctx, "audit.security.read", "all")}
      />

      <section aria-labelledby="audit-timeline-heading" className="space-y-3">
        <h2 id="audit-timeline-heading" className="text-lg font-semibold">
          {t("history.timeline")}
        </h2>
        {!entries.ok ? (
          <AuditError error={entries.error} />
        ) : entries.data.length === 0 ? (
          <Card className="text-sm text-muted-foreground">{t("history.empty")}</Card>
        ) : (
          <ol className="relative space-y-3 border-s ps-4">
            {entries.data.map((entry) => (
              <li key={entry.id} className="relative">
                <span aria-hidden="true" className="absolute -start-[1.3rem] top-4 size-2.5 rounded-full bg-primary" />
                <AuditEntryCard entry={entry} showRecord={false} />
              </li>
            ))}
          </ol>
        )}
        <nav aria-label={t("list.paging")} className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          {filters.beforeId ? (
            <Link href={withQuery(self, { reveal: filters.reveal })} prefetch={false} className={buttonVariants({ variant: "outline" })}>
              {t("list.newest")}
            </Link>
          ) : (
            <span />
          )}
          {before ? (
            <Link href={withQuery(self, { before, reveal: filters.reveal })} prefetch={false} className={buttonVariants({ variant: "outline" })}>
              {t("list.older")}
            </Link>
          ) : null}
        </nav>
      </section>
    </div>
  );
}
