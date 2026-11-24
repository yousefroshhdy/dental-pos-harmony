"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Card, Input, Label, Select } from "@/components/ui/primitives";
import { missingDecisions, type Analysis, type NegativeDecision } from "../flow";
import type { LegacyUploadResponse } from "../schemas";
import { MAX_SHEET_ROWS, MAX_WORKBOOK_BYTES } from "../upload";
import { LegacyError } from "./legacy-error";
import { Reconciliation } from "./reconciliation";

type Failure = Extract<LegacyUploadResponse, { ok: false }>;

const failureOf = (body: LegacyUploadResponse | null): Failure =>
  body && !body.ok ? body : { ok: false, code: "UNAVAILABLE", messageKey: "UNAVAILABLE" };

/** POST the workbook to the route handler (it converts in memory; the database decides access). */
export async function postWorkbook(fields: Record<string, string>, file: File): Promise<LegacyUploadResponse> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set("file", file);
  try {
    const res = await fetch("/api/legacy-import", { method: "POST", body: form, credentials: "same-origin" });
    return ((await res.json().catch(() => null)) as LegacyUploadResponse | null) ?? failureOf(null);
  } catch {
    return failureOf(null);
  }
}

/**
 * Upload → reconciliation and decisions → start. Nothing is stored until "Start": the first
 * request only converts and reports. The file stays in this page's memory so "Start" can send
 * it again with the decisions (the server converts again and stages the rows).
 */
export function UploadFlow({
  governorates,
  warehouses,
  defaultGovernorate,
}: {
  governorates: { code: string; name: string }[];
  warehouses: { code: string; name: string }[];
  defaultGovernorate: string;
}) {
  const t = useTranslations("legacyImport");
  const format = useFormatter();
  const router = useRouter();
  const fileId = useId();
  const govId = useId();
  const whId = useId();
  const creditsId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [governorate, setGovernorate] = useState(defaultGovernorate);
  const [warehouse, setWarehouse] = useState(warehouses[0]?.code ?? "");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [decisions, setDecisions] = useState<Record<string, NegativeDecision>>({});
  const [credits, setCredits] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [pending, setPending] = useState<"analyze" | "start" | null>(null);
  const startKey = useRef<string | null>(null);

  const reset = () => {
    setAnalysis(null);
    setDecisions({});
    setCredits(false);
    setError(null);
    startKey.current = null;
  };

  const analyze = async () => {
    if (!file) return setError({ ok: false, code: "UPLOAD_PROBLEM", messageKey: "VALIDATION", problem: "no_file" });
    if (file.size > MAX_WORKBOOK_BYTES) return setError({ ok: false, code: "UPLOAD_PROBLEM", messageKey: "VALIDATION", problem: "too_large" });
    setPending("analyze");
    setError(null);
    const body = await postWorkbook({ mode: "analyze", governorate_code: governorate, warehouse_code: warehouse }, file);
    setPending(null);
    if (body.ok && body.mode === "analyze") {
      setAnalysis(body.analysis);
      setDecisions({});
      startKey.current = null;
    } else setError(failureOf(body));
  };

  const missing = analysis ? missingDecisions(analysis.negativeStock, decisions) : [];

  const start = async () => {
    if (!file || !analysis || missing.length > 0) return;
    startKey.current ??= crypto.randomUUID();
    setPending("start");
    setError(null);
    const body = await postWorkbook(
      {
        mode: "start",
        governorate_code: governorate,
        warehouse_code: warehouse,
        idempotency_key: startKey.current,
        decisions: JSON.stringify(decisions),
        credits_mode: credits ? "import" : "hold",
      },
      file,
    );
    setPending(null);
    if (body.ok) router.refresh();
    else setError(failureOf(body));
  };

  const decideAll = (d: NegativeDecision) => {
    if (!analysis) return;
    startKey.current = null;
    setDecisions(Object.fromEntries(analysis.negativeStock.map((i) => [i.sku, d])));
  };

  return (
    <div className="space-y-6">
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">{t("upload.title")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor={fileId}>{t("upload.file")}</Label>
            <Input
              id={fileId}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-describedby={`${fileId}-hint`}
              className="py-2 file:me-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1"
              onChange={(e) => {
                setFile(e.currentTarget.files?.[0] ?? null);
                reset();
              }}
            />
            <p id={`${fileId}-hint`} className="text-xs text-muted-foreground">
              {t("upload.fileHint", { mb: MAX_WORKBOOK_BYTES / (1024 * 1024), rows: MAX_SHEET_ROWS })} {t("notStored")}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={govId}>{t("upload.governorate")}</Label>
            <Select
              id={govId}
              value={governorate}
              className="w-full"
              aria-describedby={`${govId}-hint`}
              onChange={(e) => {
                setGovernorate(e.currentTarget.value);
                reset();
              }}
            >
              {governorates.map((g) => (
                <option key={g.code} value={g.code}>
                  {g.name} ({g.code})
                </option>
              ))}
            </Select>
            <p id={`${govId}-hint`} className="text-xs text-muted-foreground">
              {t("upload.governorateHint")}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={whId}>{t("upload.warehouse")}</Label>
            {warehouses.length === 0 ? (
              <p className="text-sm text-destructive">{t("upload.noWarehouse")}</p>
            ) : (
              <Select
                id={whId}
                value={warehouse}
                className="w-full"
                aria-describedby={`${whId}-hint`}
                onChange={(e) => {
                  setWarehouse(e.currentTarget.value);
                  reset();
                }}
              >
                {warehouses.map((w) => (
                  <option key={w.code} value={w.code}>
                    {w.name} ({w.code})
                  </option>
                ))}
              </Select>
            )}
            <p id={`${whId}-hint`} className="text-xs text-muted-foreground">
              {t("upload.warehouseHint")}
            </p>
          </div>
        </div>
        <Button type="button" onClick={analyze} disabled={pending !== null || !file || warehouses.length === 0} aria-busy={pending === "analyze" || undefined} className="w-full sm:w-auto">
          {pending === "analyze" ? t("upload.analyzing") : t("upload.analyze")}
        </Button>
        {error && !analysis ? <LegacyError code={error.code} messageKey={error.messageKey} requestId={error.requestId} problem={error.problem} /> : null}
      </Card>

      {analysis ? (
        <>
          <Reconciliation rows={analysis.reconciliation} />

          <section aria-labelledby="legacy-counts" className="space-y-2">
            <h2 id="legacy-counts" className="text-lg font-semibold">
              {t("counts.title")}
            </h2>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {analysis.steps.map((s) => (
                <li key={s.kind} className="rounded-md border bg-card p-3 text-sm">
                  <span className="block text-muted-foreground">
                    {s.stepNo}. {t(`steps.kinds.${s.kind}`)}
                  </span>
                  <span className="block font-semibold tabular-nums">{t("counts.rows", { count: s.rows })}</span>
                </li>
              ))}
            </ul>
            {analysis.barcodesToVerify > 0 ? <p className="text-sm text-muted-foreground">{t("counts.barcodes", { count: analysis.barcodesToVerify })}</p> : null}
            {analysis.warnings.length > 0 ? (
              <details className="rounded-md border p-3 text-sm">
                <summary className="min-h-11 cursor-pointer py-2 font-medium">{t("recon.notes")}</summary>
                <ul dir="ltr" className="mt-2 list-disc space-y-1 ps-5 text-xs text-muted-foreground">
                  {analysis.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>

          <section aria-labelledby="legacy-negative" className="space-y-3">
            <h2 id="legacy-negative" className="text-lg font-semibold">
              {t("negative.title")}
            </h2>
            {analysis.negativeStock.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("negative.empty")}</p>
            ) : (
              <>
                <p className="text-sm">{t("negative.intro")}</p>
                <ul className="list-disc space-y-1 ps-5 text-sm text-muted-foreground">
                  <li>{t("negative.zeroHint")}</li>
                  <li>{t("negative.skipHint")}</li>
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={() => decideAll("zero")}>
                    {t("negative.allZero")}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => decideAll("skip")}>
                    {t("negative.allSkip")}
                  </Button>
                </div>
                <ul className="space-y-2">
                  {analysis.negativeStock.map((item) => (
                    <li key={item.sku} className="rounded-md border bg-card p-3 text-sm">
                      <fieldset className="space-y-2">
                        <legend className="flex w-full flex-wrap items-baseline gap-x-2">
                          <code dir="ltr" className="text-xs">
                            {item.sku}
                          </code>
                          <bdi className="font-medium break-words">{item.name}</bdi>
                          <span className="text-muted-foreground tabular-nums">
                            {t("negative.quantity")}: {format.number(item.quantity)}
                          </span>
                        </legend>
                        <div className="flex flex-wrap gap-2">
                          {(["zero", "skip"] as const).map((d) => (
                            <label key={d} className="flex min-h-11 min-w-28 cursor-pointer items-center gap-2 rounded-md border px-3 has-[:checked]:border-primary has-[:checked]:bg-primary/10">
                              <input
                                type="radio"
                                name={`decision-${item.sku}`}
                                value={d}
                                checked={decisions[item.sku] === d}
                                onChange={() => {
                                  startKey.current = null;
                                  setDecisions((prev) => ({ ...prev, [item.sku]: d }));
                                }}
                                className="size-5"
                              />
                              {t(`negative.${d}`)}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    </li>
                  ))}
                </ul>
                {missing.length > 0 ? (
                  <p className="text-sm font-medium" role="status">
                    {t("negative.missing", { count: missing.length })}
                  </p>
                ) : null}
              </>
            )}
          </section>

          <section aria-labelledby="legacy-credits" className="space-y-2">
            <h2 id="legacy-credits" className="text-lg font-semibold">
              {t("credits.title")}
            </h2>
            {analysis.credits.rows === 0 ? (
              <p className="text-sm text-muted-foreground">{t("credits.none")}</p>
            ) : (
              <>
                <p className="text-sm">{t("credits.intro", { count: analysis.credits.rows, total: format.number(analysis.credits.total, "egp") })}</p>
                <label htmlFor={creditsId} className="flex min-h-11 items-start gap-3 text-sm">
                  <input
                    id={creditsId}
                    type="checkbox"
                    checked={credits}
                    onChange={(e) => {
                      startKey.current = null;
                      setCredits(e.currentTarget.checked);
                    }}
                    className="mt-1 size-5 shrink-0"
                  />
                  <span>{t("credits.import")}</span>
                </label>
              </>
            )}
          </section>

          <Card className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("upload.startHint")}</p>
            <Button type="button" onClick={start} disabled={pending !== null || missing.length > 0} aria-busy={pending === "start" || undefined} className="w-full sm:w-auto">
              {pending === "start" ? t("upload.starting") : t("upload.start")}
            </Button>
            {error ? <LegacyError code={error.code} messageKey={error.messageKey} requestId={error.requestId} problem={error.problem} /> : null}
            {missing.length > 0 ? <Alert tone="warning">{t("problems.decisions_incomplete")}</Alert> : null}
          </Card>
        </>
      ) : null}
    </div>
  );
}
