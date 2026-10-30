"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { verifyStepUp } from "../actions";
import type { SecurityErrorKey } from "../types";

/**
 * Reusable step-up prompt: a modal that asks for a TOTP code and raises this
 * session to aal2 (`verifyStepUp` → supabase.auth.mfa.challengeAndVerify).
 * Usually rendered by `useStepUpAction`, which also retries the refused action.
 * The database decides whether aal2 is needed; this only collects the code.
 */
export function StepUpPrompt({ open, onVerified, onCancel }: { open: boolean; onVerified: () => void; onCancel: () => void }) {
  const t = useTranslations("security.stepUp");
  const te = useTranslations("security.errors");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();
  const [error, setError] = useState<SecurityErrorKey | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      formRef.current?.reset();
      setError(null);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await verifyStepUp(form);
      if (result.ok) {
        setError(null);
        onVerified();
      } else {
        setError(result.messageKey);
      }
    });
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-lg border bg-card p-4 text-foreground shadow-lg backdrop:bg-black/50 sm:p-6"
    >
      <form ref={formRef} onSubmit={submit} className="flex flex-col gap-3">
        <h2 id={titleId} className="text-lg font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("body")}</p>
        <Label htmlFor={inputId}>{t("codeLabel")}</Label>
        <Input
          id={inputId}
          name="code"
          required
          dir="ltr"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9٠-٩۰-۹ -]{6,9}"
          maxLength={9}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="text-center text-lg tracking-widest"
          autoFocus
        />
        {error ? (
          <Alert id={errorId}>
            {te(error)}
            {error === "NO_FACTOR" ? (
              <>
                {" "}
                <Link href="/account/security" className="text-primary underline underline-offset-4">
                  {t("enrolLink")}
                </Link>
              </>
            ) : null}
          </Alert>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? t("verifying") : t("verify")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
