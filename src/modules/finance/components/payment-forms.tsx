"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useId, useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { DatePicker } from "@/components/ui/date-picker";
import { FormField } from "@/components/ui/form-field";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { StickyActionBar } from "@/modules/orders/kit/sticky-bar";
import { allocatePayment, confirmPayment, recordPayment, rejectPayment, reverseAllocation, reversePayment } from "../actions";
import { checkAllocations, fifoPreview, parseAmount, type OpenInvoice } from "../logic";
import { RECORDABLE_METHODS, type CustomerOption, type RecordableMethod } from "../types";
import { FinanceActionMessage } from "./finance-error";

const EGP = { style: "currency", currency: "EGP", numberingSystem: "latn" } as const;
import { useIdempotentAction } from "./use-idempotent-action";

/**
 * Record money received. Built for a phone in the field: a searchable customer
 * picker, a big amount field with the numeric keypad, the method as large
 * choices, and the submit button kept in reach (sticky above the bottom bar).
 * The client_ref is generated once per attempt so a retry never records twice.
 */
export function RecordPaymentForm({
  customers,
  defaultCustomerId,
  locale,
  aboveBottomNav = false,
}: {
  customers: CustomerOption[];
  defaultCustomerId: string | null;
  locale: string;
  /** The shell shows its phone bottom bar: the sticky submit bar sits above it. */
  aboveBottomNav?: boolean;
}) {
  const t = useTranslations("finance.record");
  const tm = useTranslations("finance.method");
  const [method, setMethod] = useState<RecordableMethod>("cash");
  const [customerId, setCustomerId] = useState<string | null>(defaultCustomerId);
  const [chequeDue, setChequeDue] = useState<string | null>(null);
  const [localError, setLocalError] = useState<{ field: "customer" | "amount" | "cheque" | "received"; text: string } | null>(null);
  const { state, submit: send, pending } = useIdempotentAction(recordPayment, "client_ref");
  const ids = { customer: useId(), amount: useId(), method: useId(), reference: useId(), due: useId(), received: useId() };
  const customerOptions = useMemo(
    () => customers.map((c) => ({ value: c.id, label: c.display_name, description: c.customer_no ?? undefined, keywords: c.customer_no ? [c.customer_no] : [] })),
    [customers],
  );

  function submit(form: FormData) {
    setLocalError(null);
    if (!customerId) {
      setLocalError({ field: "customer", text: t("chooseCustomer") });
      return;
    }
    const amount = parseAmount(String(form.get("amount") ?? ""));
    if (amount === null) {
      setLocalError({ field: "amount", text: t("invalidAmount") });
      return;
    }
    if (method === "cheque" && !chequeDue) {
      setLocalError({ field: "cheque", text: t("chequeDueRequired") });
      return;
    }
    form.set("amount", amount.toFixed(2));
    // datetime-local is the device's wall clock; send an exact instant.
    const local = String(form.get("received_local") ?? "");
    form.delete("received_local");
    if (local) {
      const at = new Date(local);
      if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 10 * 60_000) {
        setLocalError({ field: "received", text: t("invalidReceivedAt") });
        return;
      }
      form.set("received_at", at.toISOString());
    }
    send(form);
  }

  if (customers.length === 0) return <Alert tone="info">{t("noCustomers")}</Alert>;
  const errorFor = (field: "customer" | "amount" | "cheque" | "received") => (localError?.field === field ? localError.text : undefined);

  return (
    <form action={submit} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <FormField id={ids.customer} label={t("customer")} error={errorFor("customer")} required>
        <Combobox
          name="customer_id"
          options={customerOptions}
          value={customerId}
          onValueChange={setCustomerId}
          placeholder={t("chooseCustomer")}
          searchPlaceholder={t("customerSearch")}
          emptyText={t("noCustomerMatch")}
          clearable={false}
        />
      </FormField>
      <FormField id={ids.amount} label={t("amount")} error={errorFor("amount")} required>
        <Input name="amount" inputMode="decimal" autoComplete="off" required placeholder="0.00" dir="ltr" className="min-h-14 text-start text-2xl font-semibold tabular-nums sm:text-2xl" />
      </FormField>
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">{t("method")}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {RECORDABLE_METHODS.map((m) => (
            <label
              key={m}
              className="flex min-h-11 cursor-pointer items-center justify-center rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-accent has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:text-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
            >
              <input type="radio" name="method" value={m} checked={method === m} onChange={() => setMethod(m)} className="sr-only" />
              {tm(m)}
            </label>
          ))}
        </div>
      </fieldset>
      <FormField id={ids.reference} label={method === "cheque" ? t("chequeNo") : t("reference")} required={method === "cheque"}>
        <Input name="reference" maxLength={100} autoComplete="off" required={method === "cheque"} dir="ltr" />
      </FormField>
      {method === "cheque" ? (
        <FormField id={ids.due} label={t("chequeDueDate")} error={errorFor("cheque")} required>
          <DatePicker name="cheque_due_date" value={chequeDue} onChange={setChequeDue} lang={locale === "ar" ? "ar" : "en"} placeholder={t("chooseDate")} />
        </FormField>
      ) : null}
      <FormField id={ids.received} label={t("receivedAt")} hint={t("receivedAtHelp")} error={errorFor("received")}>
        <Input name="received_local" type="datetime-local" dir="ltr" />
      </FormField>
      <Alert tone="info" role="note">
        {t("verificationNote")}
      </Alert>
      <FinanceActionMessage state={state} />
      <StickyActionBar aboveBottomNav={aboveBottomNav}>
        <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
          {pending ? t("saving") : t("submit")}
        </Button>
      </StickyActionBar>
    </form>
  );
}

/**
 * One-tap confirm (finance verified the money). The date the money was received is shown
 * above the button, flagged when it is not the Cairo day the payment was recorded on:
 * confirming books it in that day's period.
 */
export function ConfirmPaymentForm({
  paymentId,
  locale,
  receivedLabel,
  daysBeforeRecording,
}: {
  paymentId: string;
  locale: string;
  /** received_at, formatted in Africa/Cairo. */
  receivedLabel: string;
  /** Cairo days between received_at and the recording (0 = same day). */
  daysBeforeRecording: number;
}) {
  const t = useTranslations("finance.paymentActions");
  const [state, action, pending] = useActionState(confirmPayment, null);
  const backdated = daysBeforeRecording > 0;
  const receivedId = useId();
  return (
    <form action={action} className="flex flex-col gap-2" aria-describedby={receivedId}>
      <input type="hidden" name="payment_id" value={paymentId} />
      <input type="hidden" name="locale" value={locale} />
      <div
        id={receivedId}
        className={cn("rounded-md border px-3 py-2", backdated ? "border-destructive/40 bg-destructive/10" : "bg-card")}
      >
        <p className="text-xs text-muted-foreground">{t("receivedAt")}</p>
        <p className="text-lg font-semibold">{receivedLabel}</p>
        {backdated ? <p className="text-sm font-medium">{t("backdated", { count: daysBeforeRecording })}</p> : null}
      </div>
      <Button type="submit" disabled={pending}>
        {t("confirm")}
      </Button>
      <FinanceActionMessage state={state} />
    </form>
  );
}

/** Reject a pending payment, or reverse a confirmed one (optionally as a bounced cheque). Folded in <details>. */
export function PaymentReasonForm({ paymentId, locale, kind }: { paymentId: string; locale: string; kind: "reject" | "reverse" }) {
  const t = useTranslations("finance.paymentActions");
  const [state, action, pending] = useActionState(kind === "reject" ? rejectPayment : reversePayment, null);
  const reasonId = useId();
  const bouncedId = useId();
  return (
    <details className="min-w-0">
      <summary className={cn(buttonVariants({ variant: "outline" }), "w-full cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden")}>
        {t(kind)}
      </summary>
      <form action={action} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="payment_id" value={paymentId} />
        <input type="hidden" name="locale" value={locale} />
        <Label htmlFor={reasonId}>{t("reason")}</Label>
        <Input id={reasonId} name="reason" required minLength={3} maxLength={500} autoComplete="off" />
        {kind === "reverse" ? (
          <label htmlFor={bouncedId} className="flex min-h-11 items-center gap-2 text-sm">
            <input id={bouncedId} type="checkbox" name="bounced" />
            {t("bounced")}
          </label>
        ) : null}
        <Button type="submit" variant="destructive" disabled={pending}>
          {t(`${kind}Confirm`)}
        </Button>
        <FinanceActionMessage state={state} />
      </form>
    </details>
  );
}

export interface AllocationInvoice extends OpenInvoice {
  label: string;
  openLabel: string;
}

/**
 * Allocate a confirmed payment. "Oldest first" sends no split: the server applies
 * FIFO under row locks. A manual split is checked here for typos and again on the server.
 */
export function AllocateForm({
  paymentId,
  locale,
  invoices,
  unallocated,
  limit,
}: {
  paymentId: string;
  locale: string;
  invoices: AllocationInvoice[];
  unallocated: number;
  limit: number | null;
}) {
  const t = useTranslations("finance.allocate");
  const format = useFormatter();
  const money = (n: number) => format.number(n, EGP);
  const fifo = useIdempotentAction(allocatePayment);
  const manual = useIdempotentAction(allocatePayment);
  const [localError, setLocalError] = useState<string | null>(null);
  const preview = useMemo(() => fifoPreview(invoices, unallocated), [invoices, unallocated]);
  const byId = new Map(invoices.map((i) => [i.id, i]));

  function submitManual(form: FormData) {
    setLocalError(null);
    const inputs: Record<string, string> = {};
    for (const inv of invoices) inputs[inv.id] = String(form.get(`amt_${inv.id}`) ?? "");
    const check = checkAllocations(inputs, invoices, unallocated, limit);
    if (!check.ok) {
      const inv = check.invoiceId ? byId.get(check.invoiceId) : undefined;
      setLocalError(t(`check.${check.reason}`, { invoice: inv?.invoice_no ?? "" }));
      return;
    }
    for (const inv of invoices) form.delete(`amt_${inv.id}`);
    form.set("allocations", JSON.stringify(check.lines));
    manual.submit(form);
  }

  if (invoices.length === 0) return <Alert tone="info">{t("noOpenInvoices")}</Alert>;

  return (
    <div className="space-y-4">
      <form action={fifo.submit} className="space-y-2 rounded-md border p-3">
        <input type="hidden" name="payment_id" value={paymentId} />
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="mode" value="fifo" />
        <p className="text-sm font-medium">{t("fifoTitle")}</p>
        <ul className="space-y-1 text-sm">
          {preview.map((p) => (
            <li key={p.invoice_id} className="flex justify-between gap-2">
              <span dir="ltr">{byId.get(p.invoice_id)?.invoice_no}</span>
              <span className="font-medium">{money(p.amount)}</span>
            </li>
          ))}
        </ul>
        <Button type="submit" disabled={fifo.pending} className="w-full sm:w-auto">
          {t("fifoSubmit")}
        </Button>
        <FinanceActionMessage state={fifo.state} />
      </form>

      <form action={submitManual} className="space-y-2 rounded-md border p-3">
        <input type="hidden" name="payment_id" value={paymentId} />
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="mode" value="manual" />
        <p className="text-sm font-medium">{t("manualTitle")}</p>
        <ul className="space-y-2">
          {invoices.map((inv) => (
            <li key={inv.id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
              <Label htmlFor={`amt_${inv.id}`} className="flex-1">
                <span dir="ltr">{inv.label}</span> <span className="text-muted-foreground">({t("open", { amount: inv.openLabel })})</span>
              </Label>
              <Input id={`amt_${inv.id}`} name={`amt_${inv.id}`} inputMode="decimal" autoComplete="off" placeholder="0.00" className="sm:w-36" />
            </li>
          ))}
        </ul>
        {limit !== null ? <p className="text-xs text-muted-foreground">{t("limit", { amount: money(limit) })}</p> : null}
        <Button type="submit" variant="outline" disabled={manual.pending} className="w-full sm:w-auto">
          {t("manualSubmit")}
        </Button>
        {localError ? <Alert>{localError}</Alert> : null}
        <FinanceActionMessage state={manual.state} />
      </form>
    </div>
  );
}

/** Undo one allocation (a negative row is added; the original stays). */
export function ReverseAllocationForm({ allocationId, paymentId, locale }: { allocationId: string; paymentId: string; locale: string }) {
  const t = useTranslations("finance.allocate");
  const [state, action, pending] = useActionState(reverseAllocation, null);
  const reasonId = useId();
  return (
    <details className="min-w-0">
      <summary className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "min-h-11 cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden")}>
        {t("reverse")}
      </summary>
      <form action={action} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="allocation_id" value={allocationId} />
        <input type="hidden" name="payment_id" value={paymentId} />
        <input type="hidden" name="locale" value={locale} />
        <Label htmlFor={reasonId}>{t("reverseReason")}</Label>
        <Input id={reasonId} name="reason" required minLength={3} maxLength={500} autoComplete="off" />
        <Button type="submit" variant="destructive" size="sm" disabled={pending}>
          {t("reverseConfirm")}
        </Button>
        <FinanceActionMessage state={state} />
      </form>
    </details>
  );
}
