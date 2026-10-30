"use client";

import { useTranslations } from "next-intl";
import { useActionState, useCallback, useRef, useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { needsStepUp } from "../logic";
import { StepUpPrompt } from "./step-up-prompt";

/**
 * `useActionState` with MFA step-up. When the Server Action's result asks for
 * step-up (`mfaRequired: true` or `code: "MFA_REQUIRED"`, see `needsStepUp` in
 * ../logic.ts), the prompt opens; after the code is verified the SAME FormData is
 * submitted again. Used by RemoveFactorButton; other modules show `StepUpLink`
 * next to their MFA_REQUIRED error instead (one line per module error display).
 *
 * Only wrap actions whose MFA_REQUIRED failure means nothing happened: the
 * database raises it inside authz.require, before any write, and rolls back.
 *
 *   const { state, formAction, pending, prompt, awaitingStepUp } = useStepUpAction(reverseAction, null);
 *   <form action={formAction}>…</form>
 *   {awaitingStepUp ? null : <ActionMessage state={state} />}
 *   {prompt}
 */
export function useStepUpAction<S>(
  action: (prev: Awaited<S>, form: FormData) => Promise<S>,
  initialState: S,
): { state: Awaited<S>; formAction: (form: FormData) => void; pending: boolean; prompt: ReactNode; awaitingStepUp: boolean } {
  const t = useTranslations("security.stepUp");
  const [phase, setPhase] = useState<"idle" | "prompting" | "cancelled">("idle");
  const savedForm = useRef<FormData | null>(null);
  const [retrying, startRetry] = useTransition();

  const [state, formAction, pending] = useActionState<S, FormData>(async (prev, form) => {
    const next = await action(prev, form);
    if (needsStepUp(next)) {
      savedForm.current = form;
      setPhase("prompting");
    } else {
      savedForm.current = null;
      setPhase("idle");
    }
    return next;
  }, initialState as Awaited<S>);

  const onVerified = useCallback(() => {
    setPhase("idle");
    const form = savedForm.current;
    if (form) startRetry(() => formAction(form));
  }, [formAction]);

  const onCancel = useCallback(() => setPhase("cancelled"), []);

  const prompt = (
    <>
      <StepUpPrompt open={phase === "prompting"} onVerified={onVerified} onCancel={onCancel} />
      {phase === "cancelled" ? (
        <Alert tone="info" className="flex flex-wrap items-center justify-between gap-2">
          <span>{t("cancelled")}</span>
          <Button type="button" size="sm" variant="outline" className="min-h-11" onClick={() => setPhase("prompting")}>
            {t("retry")}
          </Button>
        </Alert>
      ) : null}
    </>
  );

  return { state, formAction, pending: pending || retrying, prompt, awaitingStepUp: phase !== "idle" && needsStepUp(state) };
}
