"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { closePeriod, recalculatePeriod } from "../actions";
import { CommissionActionMessage } from "./action-message";

/** Recalculate one open month now (finance's refresh; the cron runs nightly). */
export function RecalculateForm({ period, label }: { period: string; label: string }) {
  const t = useTranslations("commissions.periods");
  const [state, action, pending] = useActionState(recalculatePeriod, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="period" value={period} />
      <Button type="submit" variant="outline" disabled={pending} aria-label={t("recalculateMonth", { month: label })}>
        {pending ? t("recalculating") : t("recalculate")}
      </Button>
      <CommissionActionMessage state={state} />
    </form>
  );
}

/**
 * Close (freeze) the oldest open month. The person confirms first: a closed month is
 * final, and later returns or bounces post in the month they happen.
 */
export function ClosePeriodForm({ period, label }: { period: string; label: string }) {
  const t = useTranslations("commissions.periods");
  const [state, action, pending] = useActionState(closePeriod, null);
  const [confirmed, setConfirmed] = useState(false);
  const confirmId = useId();
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="period" value={period} />
      <label htmlFor={confirmId} className="flex min-h-11 items-start gap-2 text-sm">
        <input
          id={confirmId}
          type="checkbox"
          className="mt-1 size-5 shrink-0"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <span>{t("confirmClose", { month: label })}</span>
      </label>
      <Button type="submit" disabled={pending || !confirmed} className="w-full sm:w-auto">
        {pending ? t("closing") : t("close", { month: label })}
      </Button>
      <CommissionActionMessage state={state} />
    </form>
  );
}
