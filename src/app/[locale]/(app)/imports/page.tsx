import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { ImportErrorMessage } from "@/modules/imports/components/import-error";
import { SyntheticDataNotice } from "@/modules/imports/components/synthetic-notice";
import { UploadForm } from "@/modules/imports/components/upload-form";
import { IMPORT_KINDS, isImportKind, KIND_SPECS } from "@/modules/imports/kinds";
import { batchStatusTone, canImportKind, canRunImports, MAX_ROWS } from "@/modules/imports/logic";
import { listBatches } from "@/modules/imports/queries";

type Params = Promise<{ locale: string }>;
type Search = Promise<{ kind?: string | string[] }>;

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
  const batches = await listBatches();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("summary")}</p>
      </div>
      <SyntheticDataNotice />

      <Card className="space-y-4">
        <CardTitle>{t("upload.title")}</CardTitle>
        <ol className="list-decimal space-y-1 ps-5 text-sm text-muted-foreground">
          <li>{t("steps.one")}</li>
          <li>{t("steps.two", { max: MAX_ROWS })}</li>
          <li>{t("steps.three")}</li>
          <li>{t("steps.four")}</li>
        </ol>
        {kinds.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("upload.noKinds")}</p>
        ) : (
          <UploadForm kinds={kinds} defaultKind={isImportKind(requested) && kinds.includes(requested) ? requested : undefined} locale={locale} />
        )}
      </Card>

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
                  <a
                    href={`/${locale}/imports/templates/${kind}`}
                    download
                    className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted"
                  >
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

      <section aria-labelledby="import-history" className="space-y-3">
        <h2 id="import-history" className="text-lg font-semibold">
          {t("history.title")}
        </h2>
        {!batches.ok ? (
          <ImportErrorMessage messageKey={batches.error.messageKey} requestId={batches.error.requestId} />
        ) : batches.data.length === 0 ? (
          <Card className="text-center text-sm text-muted-foreground">{t("history.empty")}</Card>
        ) : (
          <ul className="space-y-2" aria-label={t("history.listLabel")}>
            {batches.data.map((b) => (
              <li key={b.id}>
                <Card className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
                  <div className="min-w-0 space-y-1">
                    <Link
                      href={`/imports/${b.id}`}
                      className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-4 hover:underline"
                    >
                      {t(`kinds.${b.kind}.title`)}
                    </Link>
                    <p className="text-sm break-all text-muted-foreground">{b.file_name ?? t("history.fileUnnamed")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("history.meta", {
                        at: format.dateTime(new Date(b.created_at), { dateStyle: "medium", timeStyle: "short" }),
                        by: (locale === "ar" ? b.created_by_name_ar : null) ?? b.created_by_name_en ?? "—",
                      })}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="tabular-nums">{t("history.counts", { rows: b.row_count, errors: b.error_count })}</span>
                    <Badge tone={batchStatusTone(b.status)}>{t(`status.${b.status}`)}</Badge>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
