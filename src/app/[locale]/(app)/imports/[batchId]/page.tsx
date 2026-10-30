import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Forbidden } from "@/components/forbidden";
import { Alert, Badge, Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { BatchActions } from "@/modules/imports/components/batch-actions";
import { ImportErrorMessage } from "@/modules/imports/components/import-error";
import { SyntheticDataNotice } from "@/modules/imports/components/synthetic-notice";
import {
  batchActions,
  batchStatusTone,
  canImportKind,
  canRunImports,
  failureCode,
  parseRowError,
  previewColumns,
  PREVIEW_ROWS,
  REJECTS_SHOWN,
  resultEntries,
  rowErrorKey,
  rowStatusTone,
  sheetRow,
} from "@/modules/imports/logic";
import { getBatch, previewRows, rejectedRows } from "@/modules/imports/queries";
import { batchIdParam } from "@/modules/imports/schemas";

type Params = Promise<{ locale: string; batchId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "imports.batch" });
  return { title: t("title") };
}

export default async function ImportBatchPage({ params }: { params: Params }) {
  const { locale, batchId } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canRunImports(ctx)) return <Forbidden />;
  if (!batchIdParam.safeParse(batchId).success) notFound();

  const t = await getTranslations("imports");
  const format = await getFormatter();
  const batch = await getBatch(batchId);
  if (!batch.ok) return <ImportErrorMessage messageKey={batch.error.messageKey} requestId={batch.error.requestId} />;
  if (!batch.data) notFound();
  const b = batch.data;

  const [preview, rejects] = await Promise.all([previewRows(b.id), b.error_count > 0 ? rejectedRows(b.id) : Promise.resolve(null)]);
  const when = (iso: string | null) => (iso ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : null);
  const allowed = canImportKind(ctx, b.kind) ? batchActions(b.status) : { validate: false, commit: false, discard: false };
  const columns = preview && preview.ok ? previewColumns(b.kind, preview.data) : [];
  const code = failureCode(b.failure);
  const results = resultEntries(b.result);

  return (
    <div className="space-y-6">
      <Link href="/imports" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("batch.back")}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{t(`kinds.${b.kind}.title`)}</h1>
          <p className="text-sm break-all text-muted-foreground">{b.file_name ?? t("history.fileUnnamed")}</p>
        </div>
        <Badge tone={batchStatusTone(b.status)} className="text-sm">
          {t(`status.${b.status}`)}
        </Badge>
      </div>

      <SyntheticDataNotice compact />

      <Card className="space-y-3">
        <dl className="grid grid-cols-3 gap-3 text-center">
          <div>
            <dt className="text-xs text-muted-foreground">{t("batch.rows")}</dt>
            <dd className="text-xl font-semibold tabular-nums">{b.row_count}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("batch.valid")}</dt>
            <dd className="text-xl font-semibold text-success tabular-nums">{b.status === "uploaded" ? "—" : b.valid_count}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("batch.rejected")}</dt>
            <dd className="text-xl font-semibold text-destructive tabular-nums">{b.status === "uploaded" ? "—" : b.error_count}</dd>
          </div>
        </dl>
        <ul className="space-y-1 text-sm text-muted-foreground">
          <li>{t("batch.uploaded", { at: when(b.created_at) ?? "—", by: (locale === "ar" ? b.created_by_name_ar : null) ?? b.created_by_name_en ?? "—" })}</li>
          {b.validated_at ? <li>{t("batch.validatedAt", { at: when(b.validated_at) ?? "—" })}</li> : null}
          {b.committed_at ? <li>{t("batch.committedAt", { at: when(b.committed_at) ?? "—" })}</li> : null}
          {b.discarded_at ? <li>{t("batch.discardedAt", { at: when(b.discarded_at) ?? "—" })}</li> : null}
        </ul>
        {b.status === "uploaded" ? <p className="text-sm">{t("batch.notValidatedYet")}</p> : null}
        {b.status === "discarded" ? <p className="text-sm">{t("batch.discarded")}</p> : null}
      </Card>

      {b.failure ? (
        <Alert>
          <p className="font-semibold">{t("batch.failureTitle")}</p>
          <p>{b.failure_row_no ? t("batch.failureRow", { row: sheetRow(b.failure_row_no) }) : t("batch.failureNoRow")}</p>
          <details className="mt-1">
            <summary className="cursor-pointer">{t("batch.failureDetail")}</summary>
            <p dir="ltr" className="mt-1 font-mono text-xs break-all">
              {code ?? ""} {b.failure}
            </p>
          </details>
        </Alert>
      ) : null}

      {b.status === "committed" && results.length > 0 ? (
        <Card className="space-y-2">
          <CardTitle>{t("batch.resultTitle")}</CardTitle>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            {results.map(([key, value]) => (
              <div key={key} className="flex justify-between gap-3 border-b py-1">
                <dt>{t.has(`result.${key}`) ? t(`result.${key}`) : key}</dt>
                <dd className="tabular-nums">{key === "total_amount" ? format.number(value, "egp") : format.number(value)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      ) : null}

      <BatchActions batchId={b.id} locale={locale} status={b.status} rowCount={b.row_count} allowed={allowed} />

      {rejects ? (
        <section aria-labelledby="import-rejects" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="import-rejects" className="text-lg font-semibold">
              {t("rejects.title", { count: b.error_count })}
            </h2>
            <a
              href={`/${locale}/imports/${b.id}/errors`}
              download
              className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted"
            >
              {t("rejects.download")}
            </a>
          </div>
          <p className="text-sm text-muted-foreground">{t("rejects.intro")}</p>
          {!rejects.ok ? (
            <ImportErrorMessage messageKey={rejects.error.messageKey} requestId={rejects.error.requestId} />
          ) : (
            <>
              <ul className="space-y-2" aria-label={t("rejects.listLabel")}>
                {rejects.data.map((row) => (
                  <li key={row.id} className="rounded-md border bg-card p-3 text-sm">
                    <p className="font-medium">{t("rejects.sheetRow", { row: sheetRow(row.row_no) })}</p>
                    <ul className="mt-1 space-y-1">
                      {row.errors.map((e) => {
                        const { code: errorCode, field } = parseRowError(e);
                        return (
                          <li key={e} className="flex flex-wrap items-baseline gap-x-2">
                            <code dir="ltr" className="text-xs">
                              {field}
                            </code>
                            <span>{t(`rowErrors.${rowErrorKey(errorCode)}`)}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
              {b.error_count > REJECTS_SHOWN ? <p className="text-sm text-muted-foreground">{t("rejects.more", { shown: REJECTS_SHOWN })}</p> : null}
            </>
          )}
        </section>
      ) : null}

      {b.status !== "discarded" ? (
        <section aria-labelledby="import-preview" className="space-y-3">
          <h2 id="import-preview" className="text-lg font-semibold">
            {t("preview.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("preview.intro", { shown: Math.min(PREVIEW_ROWS, b.row_count), total: b.row_count })}</p>
          {!preview.ok ? (
            <ImportErrorMessage messageKey={preview.error.messageKey} requestId={preview.error.requestId} />
          ) : preview.data.length === 0 ? (
            <Card className="text-center text-sm text-muted-foreground">{t("preview.empty")}</Card>
          ) : (
            <Table aria-label={t("preview.title")}>
              <thead>
                <tr>
                  <Th>{t("preview.sheetRow")}</Th>
                  <Th>{t("preview.status")}</Th>
                  {columns.map((c) => (
                    <Th key={c}>
                      <code dir="ltr">{c}</code>
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.data.map((row) => (
                  <tr key={row.id}>
                    <Td className="tabular-nums">{sheetRow(row.row_no)}</Td>
                    <Td>
                      <Badge tone={rowStatusTone(row.status)}>{t(`rowStatus.${row.status}`)}</Badge>
                    </Td>
                    {columns.map((c) => (
                      <Td key={c} className="whitespace-nowrap">
                        <bdi>{row.raw?.[c] ?? ""}</bdi>
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      ) : null}
    </div>
  );
}
