import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { DownloadIcon, FileSpreadsheetIcon } from "lucide-react";
import { FilterChips } from "@/components/page-kit/filter-chips";
import { buttonVariants } from "@/components/ui/button";
import { readTableParams } from "@/components/ui/data-table-params";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { directionOf } from "@/i18n/routing";
import { pickParam } from "@/lib/list-query";
import { BatchesTable, type BatchListRow } from "@/modules/imports/components/batches-table";
import { getUserContext } from "@/lib/authz/context";
import { ImportErrorMessage } from "@/modules/imports/components/import-error";
import { SyntheticDataNotice } from "@/modules/imports/components/synthetic-notice";
import { UploadForm } from "@/modules/imports/components/upload-form";
import { IMPORT_KINDS, isImportKind, KIND_SPECS } from "@/modules/imports/kinds";
import { batchStatusTone, canImportKind, canRunImports, MAX_ROWS } from "@/modules/imports/logic";
import { listBatchesPage } from "@/modules/imports/queries";
import { BATCH_STATUSES, BATCHES_TABLE, historyRequested } from "@/modules/imports/tables";
import { localizedName } from "@/modules/admin/logic";
import { listGovernorates } from "@/modules/admin/queries";

type Params = Promise<{ locale: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "imports" });
  return { title: t("title") };
}

export default async function ImportsPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canRunImports(ctx)) return <Forbidden />;

  const search = await searchParams;
  const requested = Array.isArray(search.kind) ? search.kind[0] : search.kind;
  const t = await getTranslations("imports");
  const format = await getFormatter();
  const kinds = IMPORT_KINDS.filter((k) => canImportKind(ctx, k));
  const table = readTableParams(search, BATCHES_TABLE);
  const status = pickParam(search, "status", [...BATCH_STATUSES, "all"] as const, "all");
  const [batches, governorates] = await Promise.all([
    listBatchesPage({
      offset: table.offset,
      pageSize: table.pageSize,
      orderBy: table.sorting[0]?.id ?? "created_at",
      desc: table.sorting[0]?.desc ?? true,
      search: table.search,
      status: status === "all" ? null : status,
    }),
    listGovernorates(),
  ]);
  const batchRows: BatchListRow[] = (batches.ok ? batches.data.rows : []).map((b) => ({
    id: b.id,
    kind: b.kind,
    fileName: b.file_name,
    createdAt: b.created_at,
    when: format.dateTime(new Date(b.created_at), { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" }),
    by: (locale === "ar" ? b.created_by_name_ar : null) ?? b.created_by_name_en ?? "—",
    rows: b.row_count,
    errors: b.error_count,
    status: b.status,
    statusTone: batchStatusTone(b.status),
  }));
  const governorateChoices = (governorates.ok ? governorates.data : []).map((g) => ({
    code: g.code,
    name: localizedName(locale, g.name_en, g.name_ar),
  }));

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("summary")} />
      <SyntheticDataNotice />

      <Tabs defaultValue={historyRequested(search) ? "history" : "upload"} dir={directionOf(locale)}>
        <TabsList className="w-full justify-start sm:w-auto">
          <TabsTrigger value="upload">{t("upload.title")}</TabsTrigger>
          <TabsTrigger value="templates">{t("templates.title")}</TabsTrigger>
          <TabsTrigger value="history">
            {t("history.title")}
            {batches.ok ? <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">{batches.data.total}</span> : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="upload">
      <Card className="space-y-4">
        <CardTitle>{t("upload.title")}</CardTitle>
        <ol className="list-decimal space-y-1 ps-5 text-sm text-muted-foreground">
          <li>{t("steps.one")}</li>
          <li>{t("steps.two", { max: MAX_ROWS })}</li>
          <li>{t("steps.three")}</li>
          <li>{t("steps.four")}</li>
        </ol>
        {kinds.length === 0 ? (
          <EmptyState compact icon={<FileSpreadsheetIcon aria-hidden="true" />} title={t("upload.noKinds")} />
        ) : (
          <UploadForm
            kinds={kinds}
            defaultKind={isImportKind(requested) && kinds.includes(requested) ? requested : undefined}
            locale={locale}
            governorates={governorateChoices}
          />
        )}
      </Card>
        </TabsContent>

        <TabsContent value="templates">
      <section aria-labelledby="import-templates" className="space-y-3">
        <h2 id="import-templates" className="text-lg font-semibold">
          {t("templates.title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("templates.intro")}</p>
        <div className="grid gap-3 md:grid-cols-2">
          {IMPORT_KINDS.map((kind) => {
            const spec = KIND_SPECS[kind];
            return (
              <Card key={kind} className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold">{t(`kinds.${kind}.title`)}</h3>
                    <p className="text-sm text-muted-foreground">{t(`kinds.${kind}.description`)}</p>
                  </div>
                  <a href={`/${locale}/imports/templates/${kind}`} download className={buttonVariants({ variant: "outline" })}>
                    <DownloadIcon aria-hidden="true" />
                    {t("templates.download")}
                  </a>
                </div>
                <details>
                  <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-primary">{t("templates.columnsLabel")}</summary>
                  <dl className="mt-2 space-y-2 text-sm">
                    {spec.columns.map((column) => (
                      <div key={column} className="grid gap-0.5 sm:grid-cols-[12rem_1fr]">
                        <dt className="flex items-center gap-2">
                          <code dir="ltr" className="break-all">
                            {column}
                          </code>
                          {spec.required.includes(column) ? <Badge tone="warning">{t("templates.required")}</Badge> : null}
                        </dt>
                        <dd className="text-muted-foreground">{t(`columns.${column}`)}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </Card>
            );
          })}
        </div>
      </section>
        </TabsContent>

        <TabsContent value="history">
      <section aria-labelledby="import-history" className="space-y-3">
        <h2 id="import-history" className="sr-only">
          {t("history.title")}
        </h2>
        <BatchesTable
          rows={batchRows}
          rowCount={batches.ok ? batches.data.total : 0}
          error={batches.ok ? undefined : <ImportErrorMessage messageKey={batches.error.messageKey} requestId={batches.error.requestId} />}
          filters={
            <FilterChips
              label={t("table.status")}
              pathname="/imports"
              params={{ ...search, tab: "history" }}
              param="status"
              current={status === "all" ? null : status}
              options={[{ value: null, label: t("table.allStatuses") }, ...BATCH_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))]}
            />
          }
        />
      </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
