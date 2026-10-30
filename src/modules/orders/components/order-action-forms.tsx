"use client";

import { useActionState, useId, useRef } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { useOnline } from "@/modules/offline/use-offline-queue";
import type { OrderActionResult, OrderActionState } from "../types";
import { OrderActionMessage } from "./order-error";

type Action = (prev: OrderActionState, form: FormData) => Promise<OrderActionResult>;

/**
 * Forms for the order detail actions. Hidden fields only identify the order;
 * the database decides whether the signed-in user may act on it.
 */

/** One-tap command (submit, approve). */
export function CommandForm({
  action,
  orderId,
  locale,
  label,
  success,
  variant = "default",
}: {
  action: Action;
  orderId: string;
  locale: string;
  label: string;
  success?: string;
  variant?: "default" | "outline";
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="order_id" value={orderId} />
      <input type="hidden" name="locale" value={locale} />
      <Button type="submit" variant={variant} disabled={pending}>
        {label}
      </Button>
      <OrderActionMessage state={state} success={success} />
    </form>
  );
}

/**
 * Submit: online only (docs/ARCHITECTURE.md §6, A-05). The server prices the
 * order and checks stock, discount authority and credit at submission, so the
 * button is disabled while the device is offline, with the reason next to it.
 * Never queued.
 */
export function OnlineOnlyCommandForm({
  action,
  orderId,
  locale,
  label,
  offlineHint,
}: {
  action: Action;
  orderId: string;
  locale: string;
  label: string;
  offlineHint: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const online = useOnline();
  const hintId = useId();
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="order_id" value={orderId} />
      <input type="hidden" name="locale" value={locale} />
      <Button type="submit" disabled={pending || !online} aria-describedby={online ? undefined : hintId}>
        {label}
      </Button>
      {!online ? (
        <p id={hintId} role="status" className="text-sm text-muted-foreground">
          {offlineHint}
        </p>
      ) : null}
      <OrderActionMessage state={state} />
    </form>
  );
}

/** A command that needs a reason (reject, cancel), folded inside <details>; works without JS. */
export function ReasonForm({
  action,
  orderId,
  locale,
  trigger,
  confirm,
  reasonLabel,
  reasonPlaceholder,
  success,
  requestedSuccess,
}: {
  action: Action;
  orderId: string;
  locale: string;
  trigger: string;
  confirm: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  success?: string;
  /** Shown instead of `success` when the command raised an approval request. */
  requestedSuccess?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const inputId = useId();
  const message = state?.ok && state.cancelRequested ? requestedSuccess : success;
  return (
    <details className="min-w-0">
      <summary className={cn(buttonVariants({ variant: "outline" }), "w-full cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden")}>
        {trigger}
      </summary>
      <form action={formAction} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="order_id" value={orderId} />
        <input type="hidden" name="locale" value={locale} />
        <Label htmlFor={inputId}>{reasonLabel}</Label>
        <Input id={inputId} name="reason" required minLength={3} maxLength={500} placeholder={reasonPlaceholder} autoComplete="off" />
        <Button type="submit" variant="destructive" disabled={pending}>
          {confirm}
        </Button>
        <OrderActionMessage state={state} success={message} />
      </form>
    </details>
  );
}

export interface WarehouseChoice {
  value: string;
  label: string;
}

/** Reserve stock from a chosen warehouse (FEFO, all-or-nothing in api.reserve_order). */
export function ReserveForm({
  action,
  orderId,
  locale,
  warehouses,
  label,
  warehouseLabel,
  selectLabel,
  emptyLabel,
}: {
  action: Action;
  orderId: string;
  locale: string;
  warehouses: WarehouseChoice[];
  label: string;
  warehouseLabel: string;
  selectLabel: string;
  emptyLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const selectId = useId();
  if (warehouses.length === 0) return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="order_id" value={orderId} />
      <input type="hidden" name="locale" value={locale} />
      <Label htmlFor={selectId}>{warehouseLabel}</Label>
      <Select id={selectId} name="warehouse_id" required defaultValue={warehouses[0]?.value ?? ""} className="w-full">
        <option value="" disabled>
          {selectLabel}
        </option>
        {warehouses.map((w) => (
          <option key={w.value} value={w.value}>
            {w.label}
          </option>
        ))}
      </Select>
      <Button type="submit" disabled={pending}>
        {label}
      </Button>
      <OrderActionMessage state={state} />
    </form>
  );
}

/**
 * Post the fulfilment. The idempotency key is generated on the device at the
 * first attempt and reused for every retry from this form, so a retry after a
 * lost response replays the same fulfilment instead of posting a second one.
 */
export function FulfilForm({ action, orderId, locale, label }: { action: Action; orderId: string; locale: string; label: string }) {
  const [state, dispatch, pending] = useActionState(action, null);
  const keyRef = useRef<string | null>(null);
  function submit(form: FormData) {
    keyRef.current ??= crypto.randomUUID();
    form.set("idempotency_key", keyRef.current);
    dispatch(form);
  }
  return (
    <form action={submit} className="flex flex-col gap-2">
      <input type="hidden" name="order_id" value={orderId} />
      <input type="hidden" name="locale" value={locale} />
      <Button type="submit" disabled={pending}>
        {label}
      </Button>
      <OrderActionMessage state={state} />
    </form>
  );
}
