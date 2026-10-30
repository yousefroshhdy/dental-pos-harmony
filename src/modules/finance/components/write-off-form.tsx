"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { requestWriteOff } from "../actions";
import { checkWriteOffAmount } from "../logic";
import { FinanceActionMessage } from "./finance-error";
import { useIdempotentAction } from "./use-idempotent-action";

/**
 * Request a write-off of (part of) what is still open on an invoice. The server checks the
 * amount against the open amount again, routes the request to a second person, and posts
 * the ledger entry only once it is approved.
 */
export function WriteOffForm({
  invoiceId,
  locale,
  openAmount,
  openLabel,
}: {
  invoiceId: string;
  locale: string;
  openAmount: number;
  openLabel: string;
}) {
  const t = useTranslations("finance.writeOff");
  const [localError, setLocalError] = useState<string | null>(null);
  const { state, submit: send, pending } = useIdempotentAction(requestWriteOff);
  const ids = { amount: useId(), reason: useId(), help: useId() };

  function submit(form: FormData) {
    setLocalError(null);
    const check = checkWriteOffAmount(String(form.get("amount") ?? ""), openAmount);
    if (!check.ok) {
      setLocalError(t(`check.${check.reason}`, { open: openLabel }));
      return;
    }
    send(form);
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <input type="hidden" name="locale" value={locale} />
      <div className="flex flex-col gap-1">
        <Label htmlFor={ids.amount}>{t("amount")}</Label>
        <Input
          id={ids.amount}
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          required
          defaultValue={openAmount.toFixed(2)}
          aria-describedby={ids.help}
        />
        <p id={ids.help} className="text-xs text-muted-foreground">
          {t("amountHelp", { open: openLabel })}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={ids.reason}>{t("reason")}</Label>
        <Input id={ids.reason} name="reason" required minLength={3} maxLength={500} autoComplete="off" placeholder={t("reasonPlaceholder")} />
      </div>
      <Button type="submit" variant="outline" disabled={pending} className="min-h-11">
        {pending ? t("submitting") : t("submit")}
      </Button>
      {localError ? <Alert>{localError}</Alert> : null}
      <FinanceActionMessage state={state} />
    </form>
  );
}
