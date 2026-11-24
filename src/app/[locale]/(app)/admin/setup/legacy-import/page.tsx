import type { Metadata } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui/page-header";
import { Alert, Badge, Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { localizedName } from "@/modules/admin/logic";
import { listGovernorates } from "@/modules/admin/queries";
import { MANSOURA } from "@/modules/admin/setup";
import { getSetupOverview, listWarehouses } from "@/modules/admin/setup-queries";
import { allStepsDone, stepGates, type StepGate, type StepState } from "@/modules/imports/legacy/flow";
import { LegacyError } from "@/modules/imports/legacy/components/legacy-error";
import { Reconciliation } from "@/modules/imports/legacy/components/reconciliation";
import { AbandonForm, RestageForm, StepActions } from "@/modules/imports/legacy/components/step-actions";
import { UploadFlow } from "@/modules/imports/legacy/components/upload-flow";
import { getLatestSession, listQuality, listSteps, stepRejects } from "@/modules/imports/legacy/queries";
import type { QualityRow } from "@/modules/imports/legacy/schemas";
import { parseRowError, rowErrorKey, sheetRow } from "@/modules/imports/logic";

type Params = Promise<{ locale: string }>;

const REJECTS_SHOWN = 50;
const QUALITY_SHOWN = 500;
const STATE_TONE: Record<StepState, "neutral" | "success" | "warning" | "danger" | "info"> = {
  empty: "neutral",
  locked: "neutral",
  staged: "warning",
  checked: "info",
  rejected: "danger",
  committed: "success",
  discarded: "neutral",
};

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "legacyImport" });
  return { title: t("title") };
}

/**
 * Browser import of the old-system workbook (owner only). The page gate is UX: the upload route
 * and every command check owner + admin.import.run (+ MFA) in Postgres, and the views return
 * nothing to anyone else. Steps run in order (DB-enforced) through the existing import batches.
 */
export default async function LegacyImportPage({ params }: { params: Params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!ctx.is_owner) return <Forbidden />;

  const t = await getTranslations("legacyImport");
  const format = await getFormatter();
  const [latest, overview, governorates, warehouses] = await Promise.all([getLatestSession(), getSetupOverview(), listGovernorates(), listWarehouses()]);

  const header = (
    <PageHeader
      title={t("title")}
      description={t("intro")}
      eyebrow={
        <Link href="/admin/setup" className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
          {t("back")}
        </Link>
      }
    />
  );
  if (!latest.ok) {
    return (
      <div className="space-y-6">
        {header}
        <LegacyError code={latest.error.code} messageKey={latest.error.messageKey} requestId={latest.error.requestId} />
      </div>
    );
  }

  const session = latest.data;
  const missingCatalog = overview.ok && overview.data ? overview.data.legacy_catalog_missing : [];
  const governorateChoices = (governorates.ok ? governorates.data : []).map((g) => ({ code: g.code, name: localizedName(locale, g.name_en, g.name_ar) }));
  const warehouseChoices = (warehouses.ok ? warehouses.data : [])
    .filter((w) => w.is_active && w.kind !== "transit")
    .sort((a, b) => Number(b.kind === "main") - Number(a.kind === "main") || a.code.localeCompare(b.code))
    .map((w) => ({ code: w.code, name: w.name }));
  const upload = <UploadFlow governorates={governorateChoices} warehouses={warehouseChoices} defaultGovernorate={MANSOURA.governorateCode} />;

  const steps = session && session.status !== "abandoned" ? await listSteps(session.id) : null;
  const gates = steps?.ok && session ? stepGates(steps.data, session.status === "open") : [];
  const rejected = gates.filter((g) => g.step.batch_id && (g.step.error_count ?? 0) > 0 && g.state !== "committed" && g.state !== "discarded");
  const rejects = new Map(
    await Promise.all(rejected.map(async (g) => [g.step.batch_id as string, await stepRejects(g.step.batch_id as string, REJECTS_SHOWN)] as const)),
  );
  const finished = !!session && (session.status === "completed" || (steps?.ok === true && allStepsDone(steps.data)));
  const quality = finished && session ? await listQuality(session.id, QUALITY_SHOWN) : null;
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="space-y-8">
      {header}

      {missingCatalog.length > 0 ? (
        <Alert tone="warning">
          {t("catalogMissing", { codes: missingCatalog.join(", ") })}{" "}
          <Link href="/admin/setup#setup-imports" className="tap-link font-medium text-primary underline underline-offset-4">
            {t("catalogLink")}
          </Link>
        </Alert>
      ) : null}

      {!session || session.status === "abandoned" ? (
        upload
      ) : (
        <>
          <Card className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <p className="font-medium break-all">{session.file_name ?? "—"}</p>
                <p className="text-sm text-muted-foreground">
                  {t("session.startedBy", {
                    at: when(session.created_at),
                    by: (locale === "ar" ? session.created_by_name_ar : null) ?? session.created_by_name_en ?? "—",
                  })}
                </p>
              </div>
              <Badge tone={session.status === "completed" ? "success" : "info"}>{t(`session.status.${session.status}`)}</Badge>
            </div>
            <p className="text-sm">{session.credits_mode === "import" ? t("credits.imported") : t("credits.held")}</p>
            {session.negative_stock.length > 0 ? (
              <details className="rounded-md border p-3 text-sm">
                <summary className="min-h-11 cursor-pointer py-2 font-medium">
                  {t("negative.recorded")} ({format.number(session.negative_stock.length)})
                </summary>
                <ul className="mt-2 space-y-1">
                  {session.negative_stock.map((d) => (
                    <li key={d.sku} className="flex flex-wrap items-baseline gap-x-2">
                      <code dir="ltr" className="text-xs">
                        {d.sku}
                      </code>
                      {d.name ? <bdi>{d.name}</bdi> : null}
                      <span className="text-muted-foreground tabular-nums">{format.number(d.quantity)}</span>
                      <Badge tone={d.decision === "zero" ? "info" : "neutral"}>{t(`negative.${d.decision}`)}</Badge>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("notStored")}</p>
          </Card>

          <Reconciliation rows={session.summary.reconciliation ?? []} />

          <section aria-labelledby="legacy-steps" className="space-y-3">
            <div className="space-y-1">
              <h2 id="legacy-steps" className="text-lg font-semibold">
                {t("steps.title")}
              </h2>
              <p className="text-sm text-muted-foreground">{t("steps.intro")}</p>
            </div>
            {steps && !steps.ok ? (
              <LegacyError code={steps.error.code} messageKey={steps.error.messageKey} requestId={steps.error.requestId} />
            ) : (
              <ol className="space-y-3">
                {gates.map((g) => (
                  <StepCard key={g.step.step_no} gate={g} sessionId={session.id} rejects={g.step.batch_id ? rejects.get(g.step.batch_id) : undefined} />
                ))}
              </ol>
            )}
            {session.status === "open" ? (
              <Card>
                <AbandonForm sessionId={session.id} />
              </Card>
            ) : (
              <Alert tone="success" role="status">
                {t("session.completed")}
              </Alert>
            )}
          </section>

          {quality ? (
            <section aria-labelledby="legacy-quality" className="space-y-3">
              <div className="space-y-1">
                <h2 id="legacy-quality" className="text-lg font-semibold">
                  {t("quality.title")}
                </h2>
                <p className="text-sm text-muted-foreground">{t("quality.intro")}</p>
              </div>
              {!quality.ok ? (
                <LegacyError code={quality.error.code} messageKey={quality.error.messageKey} requestId={quality.error.requestId} />
              ) : quality.data.length === 0 ? (
                <Card className="text-center text-sm text-muted-foreground">{t("quality.empty")}</Card>
              ) : (
                <>
                  {(["phone_missing", "location_missing", "cost_unknown"] as const).map((issue) => {
                    const rows = quality.data.filter((q) => q.issue === issue);
                    if (rows.length === 0) return null;
                    return <QualityGroup key={issue} title={`${t(`quality.issues.${issue}`)} (${format.number(rows.length)})`} rows={rows} openLabel={t("quality.open")} />;
                  })}
                  {quality.data.length >= QUALITY_SHOWN ? <p className="text-sm text-muted-foreground">{t("quality.more", { shown: QUALITY_SHOWN })}</p> : null}
                </>
              )}
            </section>
          ) : null}

          {session.status === "completed" ? (
            <details className="rounded-md border p-3">
              <summary className="min-h-11 cursor-pointer py-2 font-medium">{t("session.newImport")}</summary>
              <div className="mt-3">{upload}</div>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

function StepCard({ gate, sessionId, rejects: rows }: { gate: StepGate; sessionId: string; rejects?: Awaited<ReturnType<typeof stepRejects>> }) {
  const t = useTranslations("legacyImport");
  const tImports = useTranslations("imports");
  const format = useFormatter();
  const s = gate.step;
  const checked = s.batch_status === "validated" || s.batch_status === "failed";
  return (
    <li>
      <Card className={gate.current ? "space-y-3 border-primary" : "space-y-3"} aria-current={gate.current ? "step" : undefined}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="font-medium">
            {s.step_no}. {t(`steps.kinds.${s.kind}`)}
          </h3>
          <Badge tone={STATE_TONE[gate.state]}>{t(`steps.states.${gate.state}`)}</Badge>
        </div>
        {gate.state === "empty" ? <p className="text-sm text-muted-foreground">{t("steps.emptyHint")}</p> : null}
        {gate.state === "locked" ? <p className="text-sm text-muted-foreground">{t("steps.lockedHint")}</p> : null}
        {gate.state === "discarded" ? <p className="text-sm text-muted-foreground">{t("steps.discardedHint")}</p> : null}
        {s.batch_id && gate.state !== "discarded" ? (
          <dl className="grid grid-cols-3 gap-2 text-center text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">{t("steps.rows")}</dt>
              <dd className="font-semibold tabular-nums">{format.number(s.row_count ?? 0)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("steps.ok")}</dt>
              <dd className="font-semibold text-success tabular-nums">{checked || gate.state === "committed" ? format.number(s.valid_count ?? 0) : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("steps.errors")}</dt>
              <dd className="font-semibold text-destructive tabular-nums">{checked || gate.state === "committed" ? format.number(s.error_count ?? 0) : "—"}</dd>
            </div>
          </dl>
        ) : null}
        {s.failure && gate.state !== "committed" ? (
          <Alert>{s.failure_row_no ? t("steps.failure", { row: sheetRow(s.failure_row_no) }) : t("steps.failureNoRow")}</Alert>
        ) : null}
        {rows ? (
          rows.ok ? (
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">{t("steps.rejectsTitle")}</h4>
              <ul className="space-y-2">
                {rows.data.map((r) => (
                  <li key={r.row_no} className="rounded-md border bg-card p-2 text-sm">
                    <p className="font-medium">{t("steps.sheetRow", { row: sheetRow(r.row_no) })}</p>
                    <ul className="mt-1 space-y-1">
                      {r.errors.map((e) => {
                        const { code, field } = parseRowError(e);
                        return (
                          <li key={e} className="flex flex-wrap items-baseline gap-x-2">
                            <code dir="ltr" className="text-xs">
                              {field}
                            </code>
                            <span>{tImports(`rowErrors.${rowErrorKey(code)}`)}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
              {(s.error_count ?? 0) > REJECTS_SHOWN ? <p className="text-sm text-muted-foreground">{t("steps.rejectsMore", { shown: REJECTS_SHOWN })}</p> : null}
            </div>
          ) : (
            <LegacyError code={rows.error.code} messageKey={rows.error.messageKey} requestId={rows.error.requestId} />
          )
        ) : null}
        {s.batch_id ? (
          <StepActions batchId={s.batch_id} rowCount={s.row_count ?? 0} canDryRun={gate.canDryRun} canCommit={gate.canCommit} checked={checked} />
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {s.batch_id ? (
            <Link href={`/imports/${s.batch_id}`} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
              {t("steps.openBatch")}
            </Link>
          ) : null}
          {s.restaged_count > 0 ? <span className="text-xs text-muted-foreground">{t("steps.restaged", { count: s.restaged_count })}</span> : null}
        </div>
        {gate.canRestage ? <RestageForm sessionId={sessionId} step={s.step_no} /> : null}
      </Card>
    </li>
  );
}

function QualityGroup({ title, rows, openLabel }: { title: string; rows: QualityRow[]; openLabel: string }) {
  return (
    <details className="rounded-md border p-3" open>
      <summary className="min-h-11 cursor-pointer py-2 font-medium">{title}</summary>
      <ul className="mt-2 divide-y">
        {rows.map((q) => (
          <li key={`${q.issue}-${q.entity_id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-1 text-sm">
            <span className="min-w-0">
              <code dir="ltr" className="me-2 text-xs">
                {q.code}
              </code>
              <bdi className="break-words">{q.label}</bdi>
            </span>
            <Link
              href={q.entity_type === "customer" ? `/customers/${q.customer_id}` : `/catalog/products/${q.product_id}`}
              className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
            >
              {openLabel}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
