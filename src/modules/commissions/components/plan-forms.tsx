"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { useStepUpAction } from "@/modules/security/components/use-step-up-action";
import { activatePlan, createPlan, deactivatePlan, setRate } from "../actions";
import { parseRatePct } from "../logic";
import { RATE_TARGETS, type CommissionActionState, type RateTarget, type TargetOption } from "../types";
import { CommissionActionMessage } from "./action-message";

/**
 * The owner's rate-editor forms. Each one calls a single api.* command through a Server
 * Action; Postgres decides permission (perf.commission_plan.manage), MFA, the closed months
 * and every rule. When the session needs a second factor the step-up prompt opens and the
 * same form is sent again once verified (nothing was written by the refused attempt).
 */

function useEditorAction(action: (prev: CommissionActionState, form: FormData) => Promise<CommissionActionState>, keyed: boolean) {
  const { state, formAction, pending, prompt, awaitingStepUp } = useStepUpAction<CommissionActionState>(action, null);
  const keyRef = useRef<string | null>(null);
  useEffect(() => {
    if (state?.ok) keyRef.current = null;
  }, [state]);
  function submit(form: FormData) {
    if (keyed) {
      keyRef.current ??= crypto.randomUUID();
      form.set("idempotency_key", keyRef.current);
    }
    formAction(form);
  }
  const message = awaitingStepUp ? null : <CommissionActionMessage state={state} />;
  return { state, submit, pending, prompt, message };
}

/** A new draft plan: code and name. */
export function CreatePlanForm() {
  const t = useTranslations("commissions.plans");
  const { submit, pending, prompt, message } = useEditorAction(createPlan, false);
  const ids = { code: useId(), name: useId() };
  return (
    <>
      <form action={submit} className="flex flex-col gap-4 sm:grid sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.code}>{t("code")}</Label>
          <Input id={ids.code} name="code" required dir="ltr" autoComplete="off" pattern="[A-Za-z0-9][A-Za-z0-9_\-]{1,39}" placeholder="STD-2027" />
          <p className="text-xs text-muted-foreground">{t("codeHint")}</p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.name}>{t("name")}</Label>
          <Input id={ids.name} name="name" required minLength={3} maxLength={120} />
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2">
          {message}
          <Button type="submit" disabled={pending} className="min-h-11 w-full sm:w-auto">
            {pending ? t("creating") : t("create")}
          </Button>
        </div>
      </form>
      {/* The step-up dialog has its own <form>: outside this one (forms cannot nest). */}
      {prompt}
    </>
  );
}

export interface RateFormDefaults {
  target: RateTarget;
  targetId: string | null;
}

/**
 * Set a rate for the plan default, a brand, a category or a product from a day on, or remove
 * the rate from that day. The database closes the rate in force the day before and keeps it
 * as history; a closed month never changes.
 */
export function RateForm({
  planId,
  today,
  options,
  defaults,
}: {
  planId: string;
  today: string;
  options: Record<Exclude<RateTarget, "default">, readonly TargetOption[]>;
  defaults: RateFormDefaults;
}) {
  const t = useTranslations("commissions.plans");
  const { submit: send, pending, prompt, message } = useEditorAction(setRate, true);
  const [target, setTarget] = useState<RateTarget>(defaults.target);
  const [clear, setClear] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const ids = { target: useId(), targetId: useId(), rate: useId(), clear: useId(), from: useId(), note: useId() };
  const choices = target === "default" ? [] : options[target];

  function submit(form: FormData) {
    setLocalError(null);
    if (!clear && parseRatePct(String(form.get("rate") ?? "")) === null) {
      setLocalError(t("rateInvalid"));
      return;
    }
    if (target !== "default" && !form.get("target_id")) {
      setLocalError(t("targetRequired"));
      return;
    }
    send(form);
  }

  return (
    <>
      <form action={submit} className="flex flex-col gap-4 sm:grid sm:grid-cols-2" id="rate-form">
        <input type="hidden" name="plan_id" value={planId} />
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.target}>{t("target")}</Label>
          <Select id={ids.target} name="target" value={target} onChange={(e) => setTarget(e.target.value as RateTarget)} className="w-full">
            {RATE_TARGETS.map((k) => (
              <option key={k} value={k}>
                {t(`targetType.${k}`)}
              </option>
            ))}
          </Select>
        </div>
        {target === "default" ? (
          <p className="self-end text-xs text-muted-foreground">{t("defaultHint")}</p>
        ) : (
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.targetId}>{t(`targetType.${target}`)}</Label>
            <Select
              id={ids.targetId}
              name="target_id"
              required
              key={target}
              defaultValue={defaults.target === target && defaults.targetId ? defaults.targetId : ""}
              className="w-full"
            >
              <option value="" disabled>
                {t("chooseTarget")}
              </option>
              {choices.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.rate}>{t("rate")}</Label>
          <Input id={ids.rate} name="rate" inputMode="decimal" dir="ltr" autoComplete="off" placeholder="5.00" disabled={clear} required={!clear} />
          <label htmlFor={ids.clear} className="flex min-h-11 items-center gap-2 text-sm">
            <input id={ids.clear} type="checkbox" name="clear" value="1" className="size-5 shrink-0" checked={clear} onChange={(e) => setClear(e.target.checked)} />
            <span>{t("clear")}</span>
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.from}>{t("effectiveFrom")}</Label>
          <Input id={ids.from} name="effective_from" type="date" required defaultValue={today} dir="ltr" />
          <p className="text-xs text-muted-foreground">{t("effectiveFromHint")}</p>
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label htmlFor={ids.note}>{t("note")}</Label>
          <Input id={ids.note} name="note" maxLength={500} />
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2">
          {localError ? <Alert>{localError}</Alert> : null}
          {message}
          <Button type="submit" disabled={pending} className="min-h-11 w-full sm:w-auto">
            {pending ? t("saving") : clear ? t("clearSubmit") : t("save")}
          </Button>
        </div>
      </form>
      {/* The step-up dialog has its own <form>: outside this one (forms cannot nest). */}
      {prompt}
    </>
  );
}

/** Draft → active from a day; every sales rep is assigned to the plan from that day (default on). */
export function ActivatePlanForm({ planId, code, today }: { planId: string; code: string; today: string }) {
  const t = useTranslations("commissions.plans");
  const { submit, pending, prompt, message } = useEditorAction(activatePlan, false);
  const [confirmed, setConfirmed] = useState(false);
  const ids = { from: useId(), assign: useId(), confirm: useId() };
  return (
    <>
      <form action={submit} className="flex flex-col gap-3">
        <input type="hidden" name="plan_id" value={planId} />
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.from}>{t("activeFrom")}</Label>
          <Input id={ids.from} name="effective_from" type="date" required defaultValue={today} dir="ltr" className="sm:max-w-xs" />
          <p className="text-xs text-muted-foreground">{t("activeFromHint")}</p>
        </div>
        <input type="hidden" name="assign_sales_reps" value="0" />
        <label htmlFor={ids.assign} className="flex min-h-11 items-start gap-2 text-sm">
          <input id={ids.assign} type="checkbox" name="assign_sales_reps" value="1" defaultChecked className="mt-1 size-5 shrink-0" />
          <span>{t("assignReps")}</span>
        </label>
        <label htmlFor={ids.confirm} className="flex min-h-11 items-start gap-2 text-sm">
          <input
            id={ids.confirm}
            type="checkbox"
            className="mt-1 size-5 shrink-0"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>{t("confirmActivate", { code })}</span>
        </label>
        {message}
        <Button type="submit" disabled={pending || !confirmed} className="min-h-11 w-full sm:w-auto">
          {pending ? t("activating") : t("activate", { code })}
        </Button>
      </form>
      {/* The step-up dialog has its own <form>: outside this one (forms cannot nest). */}
      {prompt}
    </>
  );
}

/** Active → retired: the plan applies up to and including the end day and never after. */
export function DeactivatePlanForm({ planId, code, today }: { planId: string; code: string; today: string }) {
  const t = useTranslations("commissions.plans");
  const { submit, pending, prompt, message } = useEditorAction(deactivatePlan, false);
  const [confirmed, setConfirmed] = useState(false);
  const ids = { to: useId(), reason: useId(), confirm: useId() };
  return (
    <>
      <form action={submit} className="flex flex-col gap-3">
        <input type="hidden" name="plan_id" value={planId} />
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.to}>{t("lastDay")}</Label>
          <Input id={ids.to} name="effective_to" type="date" required defaultValue={today} dir="ltr" className="sm:max-w-xs" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.reason}>{t("reason")}</Label>
          <Input id={ids.reason} name="reason" required minLength={3} maxLength={500} />
        </div>
        <label htmlFor={ids.confirm} className="flex min-h-11 items-start gap-2 text-sm">
          <input
            id={ids.confirm}
            type="checkbox"
            className="mt-1 size-5 shrink-0"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>{t("confirmDeactivate", { code })}</span>
        </label>
        {message}
        <Button type="submit" variant="outline" disabled={pending || !confirmed} className="min-h-11 w-full sm:w-auto">
          {pending ? t("deactivating") : t("deactivate", { code })}
        </Button>
      </form>
      {/* The step-up dialog has its own <form>: outside this one (forms cannot nest). */}
      {prompt}
    </>
  );
}
