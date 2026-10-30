"use client";

import { useTranslations } from "next-intl";
import { useActionState, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Badge } from "@/components/ui/primitives";
import { useRouter } from "@/i18n/navigation";
import { BottomActions } from "@/modules/field/components/layout-bits";
import { saveGeneratedPlan } from "../actions";
import { MAX_VISITS_PER_PLAN } from "../schemas";
import type { ActionState } from "../types";
import { PlanningError } from "./planning-error";

export interface ReviewDay {
  date: string;
  /** Formatted on the server (Cairo, locale). */
  label: string;
  /** e.g. "2 already planned · 5 proposed · cap 8" */
  load: string;
  items: { value: string; title: string; detail: string; classLabel: string }[];
}

/**
 * Review a generated month plan before anything is written: every proposal is a checkbox
 * (all checked). Saving sends the checked ones to api.plan_visits in one all-or-nothing call
 * with a device-generated client ref, then opens the week of the first saved visit.
 */
export function PlanReviewForm({ employeeId, employeeQuery, days }: { employeeId: string; employeeQuery: string; days: ReviewDay[] }) {
  const t = useTranslations("planning.generate");
  const router = useRouter();
  const all = days.flatMap((d) => d.items.map((i) => i.value));
  const [checked, setChecked] = useState<Set<string>>(() => new Set(all));
  const clientRef = useRef<string | null>(null);

  const [state, formAction, pending] = useActionState(async (prev: ActionState, form: FormData) => {
    clientRef.current ??= crypto.randomUUID();
    form.set("client_ref", clientRef.current);
    const result = await saveGeneratedPlan(prev, form);
    if (result.ok) {
      clientRef.current = null;
      const week = result.from ? `&week=${result.from}` : "";
      router.push(`/planning?${employeeQuery}${week}`);
    }
    return result;
  }, null);

  const toggle = (value: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(value);
      else next.delete(value);
      return next;
    });

  const tooMany = checked.size > MAX_VISITS_PER_PLAN;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="employee_id" value={employeeId} />
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium" aria-live="polite">
          {t("selected", { count: checked.size, total: all.length })}
        </p>
        <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => setChecked(new Set(all))}>
          {t("selectAll")}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => setChecked(new Set())}>
          {t("selectNone")}
        </Button>
      </div>

      <ul className="space-y-3">
        {days.map((day) => (
          <li key={day.date} className="space-y-2 rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">{day.label}</h3>
              <span className="text-xs text-muted-foreground">{day.load}</span>
            </div>
            <ul className="space-y-1">
              {day.items.map((item) => (
                <li key={item.value}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-muted">
                    <input
                      type="checkbox"
                      name="visit"
                      value={item.value}
                      checked={checked.has(item.value)}
                      onChange={(e) => toggle(item.value, e.target.checked)}
                      className="size-5 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.title}</span>
                      <span className="block text-xs text-muted-foreground">{item.detail}</span>
                    </span>
                    <Badge tone="info">{item.classLabel}</Badge>
                  </label>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      {tooMany ? <Alert>{t("tooMany", { max: MAX_VISITS_PER_PLAN })}</Alert> : null}
      {state && !state.ok ? <PlanningError code={state.code} messageKey={state.messageKey} requestId={state.requestId} /> : null}
      {state?.ok ? (
        <Alert tone="success" role="status">
          {t("saved", { count: state.created ?? 0 })}
        </Alert>
      ) : null}

      <BottomActions label={t("actions")}>
        <Button type="submit" disabled={pending || checked.size === 0 || tooMany}>
          {pending ? t("saving") : t("save", { count: checked.size })}
        </Button>
      </BottomActions>
    </form>
  );
}
