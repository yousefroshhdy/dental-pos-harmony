"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { issueInvoice, requestCreditNote } from "../actions";
import { checkCreditLines, creditableQty, parseAmount, type CreditableLine } from "../logic";
import { FinanceActionMessage } from "./finance-error";
import { useIdempotentAction } from "./use-idempotent-action";

/** Issue the invoice for an order. The amounts come from the server; this only names the order. */
export function IssueInvoiceForm({ orderId, locale }: { orderId: string; locale: string }) {
  const t = useTranslations("finance.issue");
  const { state, submit, pending } = useIdempotentAction(issueInvoice);
  return (
    <form action={submit} className="flex flex-col gap-2">
      <input type="hidden" name="order_id" value={orderId} />
      <input type="hidden" name="locale" value={locale} />
      <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
        {pending ? t("issuing") : t("submit")}
      </Button>
      <FinanceActionMessage state={state} />
    </form>
  );
}

export interface CreditLineOption extends CreditableLine {
  label: string;
}

/**
 * Request a credit note: whole quantities per invoice line, or a goodwill amount
 * excluding VAT. The server computes the credit (and its VAT) and routes it to approval.
 */
export function CreditNoteForm({ invoiceId, locale, lines }: { invoiceId: string; locale: string; lines: CreditLineOption[] }) {
  const t = useTranslations("finance.credit");
  const creditable = lines.filter((l) => creditableQty(l) > 0);
  const [mode, setMode] = useState<"lines" | "amount">(creditable.length > 0 ? "lines" : "amount");
  const [localError, setLocalError] = useState<string | null>(null);
  const { state, submit: send, pending } = useIdempotentAction(requestCreditNote);
  const ids = { amount: useId(), reason: useId() };

  function submit(form: FormData) {
    setLocalError(null);
    if (mode === "lines") {
      const inputs: Record<string, string> = {};
      for (const l of creditable) inputs[l.invoice_item_id] = String(form.get(`qty_${l.invoice_item_id}`) ?? "");
      const check = checkCreditLines(inputs, creditable);
      if (!check.ok) {
        setLocalError(t(`check.${check.reason}`));
        return;
      }
      form.set("lines", JSON.stringify(check.lines));
      form.delete("amount");
    } else {
      if (parseAmount(String(form.get("amount") ?? "")) === null) {
        setLocalError(t("check.invalidAmount"));
        return;
      }
      form.delete("lines");
    }
    send(form);
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="mode" value={mode} />
      <fieldset className="flex flex-wrap gap-2">
        <legend className="mb-1 text-sm font-medium">{t("mode")}</legend>
        {(["lines", "amount"] as const).map((m) => (
          <label key={m} className="flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm">
            <input type="radio" name="mode_choice" value={m} checked={mode === m} onChange={() => setMode(m)} disabled={m === "lines" && creditable.length === 0} />
            {t(`modes.${m}`)}
          </label>
        ))}
      </fieldset>

      {mode === "lines" ? (
        <ul className="space-y-2">
          {creditable.map((l) => (
            <li key={l.invoice_item_id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
              <Label htmlFor={`qty_${l.invoice_item_id}`} className="flex-1">
                {l.label} <span className="text-muted-foreground">({t("creditable", { count: creditableQty(l) })})</span>
              </Label>
              <Input
                id={`qty_${l.invoice_item_id}`}
                name={`qty_${l.invoice_item_id}`}
                inputMode="numeric"
                pattern="[0-9٠-٩]*"
                autoComplete="off"
                className="sm:w-28"
                placeholder="0"
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.amount}>{t("amount")}</Label>
          <Input id={ids.amount} name="amount" inputMode="decimal" autoComplete="off" required placeholder="0.00" />
          <p className="text-xs text-muted-foreground">{t("amountHelp")}</p>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <Label htmlFor={ids.reason}>{t("reason")}</Label>
        <Input id={ids.reason} name="reason" required minLength={3} maxLength={500} autoComplete="off" placeholder={t("reasonPlaceholder")} />
      </div>
      <Button type="submit" disabled={pending}>
        {t("submit")}
      </Button>
      {localError ? <Alert>{localError}</Alert> : null}
      <FinanceActionMessage state={state} />
    </form>
  );
}
