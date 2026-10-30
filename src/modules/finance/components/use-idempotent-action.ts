"use client";

import { useActionState, useEffect, useRef } from "react";
import type { FinanceActionResult, FinanceActionState } from "../types";

type Action = (prev: FinanceActionState, form: FormData) => Promise<FinanceActionResult>;

/**
 * Server Action state plus a device-generated idempotency key: the key is created
 * at the first attempt and reused for every retry of the same attempt, so a retry
 * after a lost response replays the command instead of applying it twice. A new
 * key is taken after a success (the next submit is a new attempt).
 */
export function useIdempotentAction(action: Action, field = "idempotency_key") {
  const [state, dispatch, pending] = useActionState(action, null);
  const keyRef = useRef<string | null>(null);
  useEffect(() => {
    if (state?.ok) keyRef.current = null;
  }, [state]);
  function submit(form: FormData) {
    keyRef.current ??= crypto.randomUUID();
    form.set(field, keyRef.current);
    dispatch(form);
  }
  return { state, submit, pending };
}
