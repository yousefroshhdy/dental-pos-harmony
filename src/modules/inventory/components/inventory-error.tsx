"use client";

import { useTranslations } from "next-intl";
import { useActionState, useTransition, type FormEvent } from "react";
import { Alert } from "@/components/ui/primitives";
import { errorMessageRef } from "../logic";

/**
 * Translated error line. Inventory business codes (INSUFFICIENT_STOCK,
 * EXPIRED_LOT, …) have their own text under inventory.errors.*; everything
 * else falls back to the shared errors.* text. Only the request id is shown.
 */
export function InventoryError({
  code,
  messageKey,
  requestId,
  className,
}: {
  code: string;
  messageKey: string;
  requestId?: string;
  className?: string;
}) {
  const tInventory = useTranslations("inventory.errors");
  const tErrors = useTranslations("errors");
  const ref = errorMessageRef(code, messageKey);
  const t = ref.namespace === "inventory.errors" ? tInventory : tErrors;
  return <Alert className={className}>{t(ref.key, { requestId: requestId ?? "—" })}</Alert>;
}

/** Error or success line for an inventory action result; nothing before the first submit. */
export function InventoryActionMessage({
  state,
  success,
  className,
}: {
  state: { ok: true } | { ok: false; code: string; messageKey: string; requestId?: string } | null;
  success?: string;
  className?: string;
}) {
  if (!state) return null;
  if (!state.ok) return <InventoryError code={state.code} messageKey={state.messageKey} requestId={state.requestId} className={className} />;
  return success ? (
    <Alert tone="success" role="status" className={className}>
      {success}
    </Alert>
  ) : null;
}

/**
 * useActionState without React's automatic form reset: the form is submitted
 * from onSubmit, so a failed submit keeps every line the user typed.
 */
export function useKeepValuesAction<S>(action: (prev: Awaited<S>, form: FormData) => Promise<S>, initial: Awaited<S>) {
  const [state, dispatch, pending] = useActionState<S, FormData>(action, initial);
  const [transitionPending, startTransition] = useTransition();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  };
  return [state, onSubmit, pending || transitionPending] as const;
}
