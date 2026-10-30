"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId, useTransition, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { commitBatch, discardBatch, validateBatch } from "../actions";
import type { ActionResult, ActionState, BatchStatus } from "../types";
import { ActionMessage } from "./import-error";

type Action = (prev: ActionState, form: FormData) => Promise<ActionResult>;

function useForm(action: Action, confirmText?: string) {
  const [state, dispatch, pending] = useActionState<ActionState, FormData>(action, null);
  const [, startTransition] = useTransition();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (confirmText && !window.confirm(confirmText)) return;
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  };
  return { state, pending, onSubmit };
}

function Outcome({ state, kind }: { state: ActionState; kind: "validate" | "commit" }) {
  const t = useTranslations("imports.batch.outcome");
  if (!state) return null;
  if (!state.ok) return <ActionMessage state={state} className="mt-2" />;
  const status = state.status;
  if (kind === "validate") {
    return status === "validated" ? (
      <Alert tone="success" role="status" className="mt-2">
        {t("validated")}
      </Alert>
    ) : (
      <Alert className="mt-2">{t("rejected")}</Alert>
    );
  }
  return status === "committed" ? (
    <Alert tone="success" role="status" className="mt-2">
      {t("committed")}
    </Alert>
  ) : (
    <Alert className="mt-2">{t("commitRefused")}</Alert>
  );
}

function Hidden({ batchId, locale }: { batchId: string; locale: string }): ReactNode {
  return (
    <>
      <input type="hidden" name="batch_id" value={batchId} />
      <input type="hidden" name="locale" value={locale} />
    </>
  );
}

/**
 * Validate → commit (with an explicit confirmation) → or discard. Which buttons appear is
 * UX only; api.import_* refuses anything the batch status or the user's access does not allow.
 * On phones the bar sticks to the bottom so the next step stays in reach.
 */
export function BatchActions({
  batchId,
  locale,
  status,
  rowCount,
  allowed,
}: {
  batchId: string;
  locale: string;
  status: BatchStatus;
  rowCount: number;
  allowed: { validate: boolean; commit: boolean; discard: boolean };
}) {
  const t = useTranslations("imports.batch");
  const confirmId = useId();
  const validate = useForm(validateBatch);
  const commit = useForm(commitBatch, t("commitConfirm", { count: rowCount }));
  const discard = useForm(discardBatch, t("discardConfirm"));

  if (!allowed.validate && !allowed.commit && !allowed.discard) return null;

  return (
    <section
      aria-label={t("actions")}
      className="sticky bottom-0 z-10 -mx-4 space-y-3 border-t bg-card/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:rounded-lg sm:border sm:px-4"
    >
      {allowed.commit ? (
        <form method="post" onSubmit={commit.onSubmit} className="space-y-2" aria-label={t("commit")}>
          <Hidden batchId={batchId} locale={locale} />
          <label htmlFor={confirmId} className="flex min-h-11 items-start gap-3 text-sm">
            <input id={confirmId} name="confirm" type="checkbox" required className="mt-1 size-5 shrink-0" />
            <span>{t("commitCheckbox", { count: rowCount })}</span>
          </label>
          <Button type="submit" disabled={commit.pending} aria-busy={commit.pending || undefined} className="w-full sm:w-auto">
            {commit.pending ? t("committing") : t("commit")}
          </Button>
          <Outcome state={commit.state} kind="commit" />
        </form>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {allowed.validate ? (
          <form method="post" onSubmit={validate.onSubmit} className="flex-1 sm:flex-none">
            <Hidden batchId={batchId} locale={locale} />
            <Button
              type="submit"
              variant={allowed.commit ? "outline" : "default"}
              disabled={validate.pending}
              aria-busy={validate.pending || undefined}
              className="w-full sm:w-auto"
            >
              {validate.pending ? t("validating") : status === "uploaded" ? t("validate") : t("revalidate")}
            </Button>
          </form>
        ) : null}
        {allowed.discard ? (
          <form method="post" onSubmit={discard.onSubmit} className="flex-1 sm:flex-none">
            <Hidden batchId={batchId} locale={locale} />
            <Button type="submit" variant="ghost" disabled={discard.pending} className="w-full sm:w-auto">
              {t("discard")}
            </Button>
          </form>
        ) : null}
      </div>
      <Outcome state={validate.state} kind="validate" />
      {discard.state && !discard.state.ok ? <ActionMessage state={discard.state} className="mt-2" /> : null}
    </section>
  );
}
