"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useActionState, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { abandonSession, commitStep, dryRunStep } from "../actions";
import type { LegacyUploadResponse, StepActionResult, StepActionState } from "../schemas";
import { LegacyError } from "./legacy-error";
import { postWorkbook } from "./upload-flow";

type Action = (prev: StepActionState, form: FormData) => Promise<StepActionResult>;

function useStepForm(action: Action, confirmText?: string) {
  const [state, dispatch, pending] = useActionState<StepActionState, FormData>(action, null);
  const [, startTransition] = useTransition();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (confirmText && !window.confirm(confirmText)) return;
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  };
  return { state, pending, onSubmit };
}

function Failed({ state }: { state: StepActionState }) {
  if (!state || state.ok) return null;
  return <LegacyError code={state.code} messageKey={state.messageKey} requestId={state.requestId} className="mt-2" />;
}

/** Dry run (api.import_validate) and commit (api.import_commit) of one step's batch. */
export function StepActions({ batchId, rowCount, canDryRun, canCommit, checked }: { batchId: string; rowCount: number; canDryRun: boolean; canCommit: boolean; checked: boolean }) {
  const t = useTranslations("legacyImport.steps");
  const confirmId = useId();
  const dryRun = useStepForm(dryRunStep);
  const commit = useStepForm(commitStep, t("commitConfirm"));
  if (!canDryRun && !canCommit) return null;
  return (
    <div className="space-y-3">
      {canCommit ? (
        <form method="post" onSubmit={commit.onSubmit} className="space-y-2" aria-label={t("commit")}>
          <input type="hidden" name="batch_id" value={batchId} />
          <label htmlFor={confirmId} className="flex min-h-11 items-start gap-3 text-sm">
            <input id={confirmId} name="confirm" type="checkbox" required className="mt-1 size-5 shrink-0" />
            <span>{t("commitCheckbox", { count: rowCount })}</span>
          </label>
          <Button type="submit" disabled={commit.pending} aria-busy={commit.pending || undefined} className="w-full sm:w-auto">
            {commit.pending ? t("committing") : t("commit")}
          </Button>
          {commit.state?.ok ? (
            <Alert tone={commit.state.status === "committed" ? "success" : "danger"} role="status">
              {commit.state.status === "committed" ? t("outcome.committed") : t("outcome.commitRefused")}
            </Alert>
          ) : (
            <Failed state={commit.state} />
          )}
        </form>
      ) : null}
      {canDryRun ? (
        <form method="post" onSubmit={dryRun.onSubmit}>
          <input type="hidden" name="batch_id" value={batchId} />
          <Button type="submit" variant={canCommit ? "outline" : "default"} disabled={dryRun.pending} aria-busy={dryRun.pending || undefined} className="w-full sm:w-auto">
            {dryRun.pending ? t("dryRunning") : checked ? t("dryRunAgain") : t("dryRun")}
          </Button>
          {dryRun.state?.ok ? (
            <Alert tone={dryRun.state.status === "validated" ? "success" : "danger"} role="status" className="mt-2">
              {dryRun.state.status === "validated" ? t("outcome.validated") : t("outcome.rejected")}
            </Alert>
          ) : (
            <Failed state={dryRun.state} />
          )}
        </form>
      ) : null}
    </div>
  );
}

/** Replace the current step's rows with those of a corrected workbook (api.legacy_import_restage). */
export function RestageForm({ sessionId, step }: { sessionId: string; step: number }) {
  const t = useTranslations("legacyImport.steps");
  const router = useRouter();
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Extract<LegacyUploadResponse, { ok: false }> | null>(null);
  const key = useRef<string | null>(null);
  return (
    <details className="rounded-md border p-3">
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">{t("restage")}</summary>
      <form
        className="mt-2 space-y-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!file) return;
          key.current ??= crypto.randomUUID();
          setPending(true);
          setError(null);
          const body = await postWorkbook({ mode: "restage", session_id: sessionId, step: String(step), idempotency_key: key.current }, file);
          setPending(false);
          if (body.ok) {
            key.current = null;
            router.refresh();
          } else setError(body);
        }}
      >
        <p className="text-xs text-muted-foreground">{t("restageHint")}</p>
        <Label htmlFor={fileId} className="sr-only">
          {t("restage")}
        </Label>
        <Input
          id={fileId}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          required
          className="py-2 file:me-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1"
          onChange={(e) => {
            key.current = null;
            setFile(e.currentTarget.files?.[0] ?? null);
          }}
        />
        <Button type="submit" variant="outline" disabled={pending || !file} aria-busy={pending || undefined} className="w-full sm:w-auto">
          {pending ? t("restaging") : t("restageSubmit")}
        </Button>
        {error ? <LegacyError code={error.code} messageKey={error.messageKey} requestId={error.requestId} problem={error.problem} /> : null}
      </form>
    </details>
  );
}

/** Close an open import: uncommitted steps are discarded, committed ones stay. */
export function AbandonForm({ sessionId }: { sessionId: string }) {
  const t = useTranslations("legacyImport.session");
  const confirmId = useId();
  const form = useStepForm(abandonSession, t("abandonConfirm"));
  return (
    <form method="post" onSubmit={form.onSubmit} className="space-y-2" aria-label={t("abandon")}>
      <input type="hidden" name="session_id" value={sessionId} />
      <label htmlFor={confirmId} className="flex min-h-11 items-start gap-3 text-sm">
        <input id={confirmId} name="confirm" type="checkbox" required className="mt-1 size-5 shrink-0" />
        <span>{t("abandonCheckbox")}</span>
      </label>
      <Button type="submit" variant="destructive" disabled={form.pending} aria-busy={form.pending || undefined} className="w-full sm:w-auto">
        {t("abandon")}
      </Button>
      <Failed state={form.state} />
    </form>
  );
}
