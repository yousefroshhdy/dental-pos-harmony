"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { requestAdjustment } from "../actions";
import { kindMatchesSign, parseSignedAmount } from "../logic";
import { ADJUSTMENT_KINDS, type AdjustmentKind, type EmployeeOption } from "../types";
import { CommissionActionMessage } from "./action-message";
import { useIdempotentAction } from "./use-idempotent-action";

interface MonthChoice {
  value: string;
  label: string;
}

/**
 * Request a bonus, clawback or correction for one employee and open month. It goes to
 * the approval workflow; the commission is posted only when approved. The idempotency
 * key is generated once per attempt, so a retry never files it twice. On a phone the
 * submit button stays at the bottom of the screen.
 */
export function AdjustmentForm({ employees, months }: { employees: readonly EmployeeOption[]; months: readonly MonthChoice[] }) {
  const t = useTranslations("commissions.adjust");
  const tk = useTranslations("commissions.kind");
  const { state, submit: send, pending } = useIdempotentAction(requestAdjustment);
  const [kind, setKind] = useState<AdjustmentKind>("bonus");
  const [localError, setLocalError] = useState<string | null>(null);
  const ids = { employee: useId(), period: useId(), kind: useId(), amount: useId(), reason: useId() };

  function submit(form: FormData) {
    setLocalError(null);
    const amount = parseSignedAmount(String(form.get("amount") ?? ""));
    if (amount === null || !kindMatchesSign(kind, amount)) {
      setLocalError(t(kind === "clawback" ? "amountNegative" : kind === "bonus" ? "amountPositive" : "amountInvalid"));
      return;
    }
    form.set("amount", amount.toFixed(2));
    send(form);
  }

  if (employees.length === 0) return <Alert tone="info">{t("noEmployees")}</Alert>;
  if (months.length === 0) return <Alert tone="info">{t("noOpenMonth")}</Alert>;

  return (
    <form action={submit} className="flex flex-col gap-4 pb-24 sm:grid sm:grid-cols-2 sm:pb-0">
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Label htmlFor={ids.employee}>{t("employee")}</Label>
        <Select id={ids.employee} name="employee_id" required defaultValue="" className="w-full">
          <option value="" disabled>
            {t("chooseEmployee")}
          </option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={ids.period}>{t("period")}</Label>
        <Select id={ids.period} name="period" required defaultValue={months[0]?.value} className="w-full">
          {months.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={ids.kind}>{t("kind")}</Label>
        <Select id={ids.kind} name="kind" value={kind} onChange={(e) => setKind(e.target.value as AdjustmentKind)} className="w-full">
          {ADJUSTMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {tk(k)}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={ids.amount}>{t("amount")}</Label>
        <Input
          id={ids.amount}
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          required
          dir="ltr"
          placeholder={kind === "clawback" ? "-0.00" : "0.00"}
          aria-describedby={`${ids.amount}-hint`}
        />
        <p id={`${ids.amount}-hint`} className="text-xs text-muted-foreground">
          {t(`amountHint.${kind}`)}
        </p>
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Label htmlFor={ids.reason}>{t("reason")}</Label>
        <Input id={ids.reason} name="reason" required minLength={3} maxLength={500} aria-describedby={`${ids.reason}-hint`} />
        <p id={`${ids.reason}-hint`} className="text-xs text-muted-foreground">
          {t("reasonHint")}
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:col-span-2">
        {localError ? <Alert>{localError}</Alert> : null}
        <CommissionActionMessage state={state} />
      </div>
      <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-card p-3 sm:static sm:col-span-2 sm:border-0 sm:bg-transparent sm:p-0">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? t("submitting") : t("submit")}
        </Button>
      </div>
    </form>
  );
}
