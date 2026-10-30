"use client";

import { useActionState, useEffect, useRef } from "react";
import type { CommissionActionResult, CommissionActionState } from "../types";

type Action = (prev: CommissionActionState, form: FormData) => Promise<CommissionActionResult>;

/**
 * Server Action state plus a device-generated idempotency key: the key is created at
 * the first attempt and reused for every retry of the same attempt, so a retry after a
 * lost response replays the request instead of filing it twice. A new key is taken
 * after a success. (Same pattern as the finance module, kept local to this module.)
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
