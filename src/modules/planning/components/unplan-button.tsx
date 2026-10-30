"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { unplanVisit } from "../actions";
import type { ActionState } from "../types";
import { PlanningError } from "./planning-error";

/** Remove one planned visit (api.unplan_visit cancels it; only while it is planned and not checked in). */
export function UnplanButton({ visitId, customerName }: { visitId: string; customerName: string }) {
  const t = useTranslations("planning.week");
  const [state, formAction, pending] = useActionState<ActionState, FormData>(unplanVisit, null);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="visit_id" value={visitId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending} className="min-h-11" aria-label={t("removeLabel", { name: customerName })}>
        {pending ? t("removing") : t("remove")}
      </Button>
      {state && !state.ok ? <PlanningError code={state.code} messageKey={state.messageKey} requestId={state.requestId} /> : null}
    </form>
  );
}
