import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Alert, Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { AccessNotice } from "@/modules/audit/components/access-notice";
import { AuditEntryCard } from "@/modules/audit/components/audit-entry";
import { AuditError } from "@/modules/audit/components/audit-error";
import { AuditSearchForm } from "@/modules/audit/components/search-form";
import { filtersToQuery, maskedCategories, nextBeforeId, withQuery } from "@/modules/audit/logic";
import { listActors, listAuditedTables, PAGE_SIZE, searchAudit } from "@/modules/audit/queries";
import { parseAuditSearch, type SearchParams } from "@/modules/audit/schemas";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "audit" });
  return { title: t("title") };
}

export default async function AuditSearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "audit.row_image.read", "all")) return <Forbidden />;

  const { filters, invalid } = parseAuditSearch(await searchParams);
  const t = await getTranslations("audit");
  const [entries, tables, actors] = await Promise.all([
    searchAudit(filters),
    listAuditedTables(),
    can(ctx, "admin.user.read", "all") ? listActors() : Promise.resolve(null),
  ]);

  const query = filtersToQuery(filters);
  const before = entries.ok ? nextBeforeId(entries.data, PAGE_SIZE) : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <AuditSearchForm filters={filters} tables={tables.ok ? tables.data : []} actors={actors?.ok ? actors.data : null} />

      {invalid.length > 0 ? (
        <Alert tone="info" role="status">
          {t("invalid.intro")} {invalid.map((field) => t(`invalid.${field}`)).join(" · ")}
        </Alert>
      ) : null}

      <AccessNotice
        maskedCategories={entries.ok ? maskedCategories(entries.data) : []}
        canReveal={can(ctx, "audit.row_image.unmask", "all")}
        revealed={filters.reveal}
        hiddenInputs={{ ...query, reveal: undefined, before: filters.beforeId }}
        hideHref={withQuery("/audit", { ...query, reveal: undefined, before: filters.beforeId })}
        canSeeSecurityLog={can(ctx, "audit.security.read", "all")}
      />

      <section aria-labelledby="audit-results-heading" className="space-y-3">
        <h2 id="audit-results-heading" className="text-lg font-semibold">
          {t("list.heading")}
        </h2>
        {!entries.ok ? (
          <AuditError error={entries.error} />
        ) : entries.data.length === 0 ? (
          <Card className="text-sm text-muted-foreground">{t("list.empty")}</Card>
        ) : (
          <ul className="space-y-3">
            {entries.data.map((entry) => (
              <li key={entry.id}>
                <AuditEntryCard entry={entry} showRecord />
              </li>
            ))}
          </ul>
        )}
        <nav aria-label={t("list.paging")} className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          {filters.beforeId ? (
            <Link href={withQuery("/audit", query)} prefetch={false} className={buttonVariants({ variant: "outline" })}>
              {t("list.newest")}
            </Link>
          ) : (
            <span />
          )}
          {before ? (
            <Link href={withQuery("/audit", { ...query, before })} prefetch={false} className={buttonVariants({ variant: "outline" })}>
              {t("list.older")}
            </Link>
          ) : null}
        </nav>
      </section>
    </div>
  );
}
