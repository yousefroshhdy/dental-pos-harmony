"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { cancelReturn, creditReturn, receiveReturn, requestReturn } from "../actions";
import { checkRequestLines, lineKey } from "../logic";
import { REASON_CODES, type WarehouseOption } from "../types";
import { ReturnsActionMessage } from "./returns-error";
import { useIdempotentAction } from "./use-idempotent-action";

export interface RequestRowOption {
  order_item_id: string;
  lot_id: string;
  returnable_qty: number;
  /** "SKU — name" */
  label: string;
  /** "Lot L2026A · expires …" */
  lotLabel: string;
}

/**
 * Choose the lines, lots and quantities to take back, with a reason each. The
 * server re-checks every quantity against what was delivered and invoiced, and
 * sends the request to approval.
 */
export function RequestReturnForm({ orderId, locale, rows }: { orderId: string; locale: string; rows: RequestRowOption[] }) {
  const t = useTranslations("returns.request");
  const reasons = useTranslations("returns.reasons");
  const { state, submit: send, pending } = useIdempotentAction(requestReturn, "client_ref");
  const [localError, setLocalError] = useState<string | null>(null);
  const notesId = useId();

  function submit(form: FormData) {
    setLocalError(null);
    const quantities: Record<string, string> = {};
    const chosen: Record<string, string> = {};
    for (const r of rows) {
      const key = lineKey(r);
      quantities[key] = String(form.get(`qty_${key}`) ?? "");
      chosen[key] = String(form.get(`reason_${key}`) ?? "");
    }
    const check = checkRequestLines(quantities, chosen, rows, String(form.get("notes") ?? ""));
    if (!check.ok) {
      setLocalError(t(`check.${check.reason}`));
      return;
    }
    form.set("lines", JSON.stringify(check.lines));
    for (const r of rows) {
      form.delete(`qty_${lineKey(r)}`);
      form.delete(`reason_${lineKey(r)}`);
    }
    send(form);
  }

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="order_id" value={orderId} />
      <input type="hidden" name="locale" value={locale} />
      <ul className="space-y-3">
        {rows.map((r) => {
          const key = lineKey(r);
          return (
            <li key={key} className="space-y-2 rounded-lg border bg-card p-3">
              <div className="min-w-0">
                <div className="break-words font-medium" dir="ltr">
                  {r.label}
                </div>
                <div className="text-xs text-muted-foreground">{r.lotLabel}</div>
                <div className="text-xs text-muted-foreground">{t("returnable", { count: r.returnable_qty })}</div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`qty_${key}`}>{t("quantity")}</Label>
                  <Input
                    id={`qty_${key}`}
                    name={`qty_${key}`}
                    inputMode="numeric"
                    pattern="[0-9٠-٩]*"
                    autoComplete="off"
                    placeholder="0"
                    aria-describedby={`max_${key}`}
                  />
                  <span id={`max_${key}`} className="sr-only">
                    {t("returnable", { count: r.returnable_qty })}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`reason_${key}`}>{t("reason")}</Label>
                  <Select id={`reason_${key}`} name={`reason_${key}`} defaultValue="" className="w-full">
                    <option value="">{t("chooseReason")}</option>
                    {REASON_CODES.map((c) => (
                      <option key={c} value={c}>
                        {reasons(c)}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-1">
        <Label htmlFor={notesId}>{t("notes")}</Label>
        <textarea
          id={notesId}
          name="notes"
          rows={3}
          maxLength={1000}
          placeholder={t("notesPlaceholder")}
          className="w-full rounded-md border bg-card px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
        />
        <p className="text-xs text-muted-foreground">{t("notesHelp")}</p>
      </div>

      <div className="sticky bottom-0 z-[1] -mx-4 flex flex-col gap-2 border-t bg-card/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
        <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
          {pending ? t("submitting") : t("submit")}
        </Button>
        {localError ? <Alert>{localError}</Alert> : null}
        <ReturnsActionMessage state={state} />
      </div>
    </form>
  );
}

/** Receive an approved return into a quarantine warehouse (the only kind the server accepts). */
export function ReceiveReturnForm({ returnId, warehouses }: { returnId: string; warehouses: WarehouseOption[] }) {
  const t = useTranslations("returns.receive");
  const { state, submit, pending } = useIdempotentAction(receiveReturn);
  const whId = useId();
  if (warehouses.length === 0) return <Alert tone="info">{t("noQuarantine")}</Alert>;
  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="return_id" value={returnId} />
      <div className="flex flex-col gap-1">
        <Label htmlFor={whId}>{t("warehouse")}</Label>
        <Select id={whId} name="warehouse_id" required defaultValue={warehouses.length === 1 ? (warehouses[0]?.id ?? "") : ""} className="w-full">
          {warehouses.length > 1 ? <option value="">{t("chooseWarehouse")}</option> : null}
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} — {w.name}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t("help")}</p>
      </div>
      <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
        {pending ? t("submitting") : t("submit")}
      </Button>
      <ReturnsActionMessage state={state} />
    </form>
  );
}

/**
 * Withdraw a pending return or cancel an approved one that never arrived. It releases the
 * held quantity; the server decides who may cancel in which state.
 */
export function CancelReturnForm({ returnId }: { returnId: string }) {
  const t = useTranslations("returns.cancel");
  const { state, submit, pending } = useIdempotentAction(cancelReturn);
  const reasonId = useId();
  const helpId = useId();
  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="return_id" value={returnId} />
      <div className="flex flex-col gap-1">
        <Label htmlFor={reasonId}>{t("reason")}</Label>
        <textarea
          id={reasonId}
          name="reason"
          rows={2}
          required
          minLength={3}
          maxLength={500}
          aria-describedby={helpId}
          placeholder={t("reasonPlaceholder")}
          className="w-full rounded-md border bg-card px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
        />
        <p id={helpId} className="text-xs text-muted-foreground">
          {t("help")}
        </p>
      </div>
      <Button type="submit" variant="destructive" size="lg" disabled={pending} className="w-full sm:w-auto">
        {pending ? t("submitting") : t("submit")}
      </Button>
      <ReturnsActionMessage state={state} />
    </form>
  );
}

/** Issue the credit note(s) of a received return; the amounts come from the invoice on the server. */
export function CreditReturnForm({ returnId }: { returnId: string }) {
  const t = useTranslations("returns.credit");
  const { state, submit, pending } = useIdempotentAction(creditReturn);
  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="return_id" value={returnId} />
      <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
        {pending ? t("submitting") : t("submit")}
      </Button>
      <ReturnsActionMessage state={state} />
    </form>
  );
}
