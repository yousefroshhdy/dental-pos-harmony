"use client";

import { useTranslations } from "next-intl";
import { createContext, useActionState, useContext, useRef, useState, useTransition, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import type { TranslatedCode } from "@/lib/errors";
import { catalogErrorCode } from "../logic";
import type { ActionResult, ActionState } from "../types";

type Action = (prev: ActionState, form: FormData) => Promise<ActionResult>;

const PendingContext = createContext(false);

/**
 * Form wrapper for catalogue Server Actions.
 *  - Keeps what the user typed when the server refuses (no automatic form reset).
 *  - `newIdField`: a client-generated id for "create" forms, renewed after each
 *    success so a second create never reuses the first id (commands are idempotent by id).
 *  - `resetOnSuccess` clears "add" forms; `confirmText` asks before destructive steps.
 * Hidden fields only identify records; the database decides what the user may do.
 */
export function ActionForm({
  action,
  children,
  success,
  newIdField,
  initialId,
  resetOnSuccess = false,
  confirmText,
  className,
  messageClassName = "mt-2 col-span-full",
  "aria-label": ariaLabel,
}: {
  action: Action;
  children: ReactNode;
  success?: string;
  newIdField?: string;
  initialId?: string;
  resetOnSuccess?: boolean;
  confirmText?: string;
  className?: string;
  messageClassName?: string;
  "aria-label"?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [newId, setNewId] = useState(initialId ?? "");
  const [, startTransition] = useTransition();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(async (prev, form) => {
    const result = await action(prev, form);
    if (result.ok) {
      if (resetOnSuccess) formRef.current?.reset();
      if (newIdField) setNewId(crypto.randomUUID());
    }
    return result;
  }, null);

  return (
    <PendingContext value={pending}>
      <form
        ref={formRef}
        method="post"
        aria-label={ariaLabel}
        className={className}
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmText && !window.confirm(confirmText)) return;
          const submitter = (event.nativeEvent as SubmitEvent).submitter;
          const data = new FormData(event.currentTarget, submitter instanceof HTMLElement ? submitter : null);
          startTransition(() => formAction(data));
        }}
      >
        {newIdField ? <input type="hidden" name={newIdField} value={newId} /> : null}
        {children}
        <ActionMessage state={state} success={success} className={messageClassName} />
      </form>
    </PendingContext>
  );
}

/** Submit button that disables itself while its ActionForm is running. */
export function SubmitButton({ disabled, ...props }: ButtonProps) {
  const pending = useContext(PendingContext);
  return <Button type="submit" disabled={pending || disabled} aria-busy={pending || undefined} {...props} />;
}

/** Translated error: catalog.errors.<code> when the module has one, otherwise errors.<messageKey>. */
export function CatalogErrorMessage({
  code,
  messageKey,
  requestId,
  className,
}: {
  code?: string;
  messageKey: TranslatedCode;
  requestId?: string;
  className?: string;
}) {
  const tErrors = useTranslations("errors");
  const tCatalog = useTranslations("catalog.errors");
  const specific = code ? catalogErrorCode(code) : null;
  return <Alert className={className}>{specific ? tCatalog(specific) : tErrors(messageKey, { requestId: requestId ?? "—" })}</Alert>;
}

export function ActionMessage({ state, success, className }: { state: ActionState; success?: string; className?: string }) {
  if (!state) return null;
  if (!state.ok) {
    return <CatalogErrorMessage code={state.code} messageKey={state.messageKey} requestId={state.requestId} className={className ?? "mt-2"} />;
  }
  return success ? (
    <Alert tone="success" role="status" className={className}>
      {success}
    </Alert>
  ) : null;
}
