import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { formatDay } from "../format";
import { MAX_PERIOD_DAYS, periodHref } from "../logic";
import type { Period, PeriodKind } from "../types";

const QUICK: PeriodKind[] = ["today", "week", "month"];

/**
 * Period choice: today, this Sunday–Thursday week, this month (all Cairo calendar),
 * or a custom range. Works without JavaScript: links plus a GET form.
 */
export async function PeriodPicker({ period, employeeId }: { period: Period; employeeId: string | null }) {
  const t = await getTranslations("dashboards.period");
  const format = await getFormatter();
  const locale = await getLocale();
  const employee = employeeId ?? undefined;

  return (
    <section aria-label={t("label")} className="space-y-3">
      <nav aria-label={t("quick")} className="flex flex-wrap gap-2">
        {QUICK.map((kind) => (
          <Link
            key={kind}
            href={periodHref({ kind, from: period.from, to: period.to }, { employee })}
            aria-current={period.kind === kind ? "page" : undefined}
            className={cn(buttonVariants({ variant: period.kind === kind ? "default" : "outline", size: "sm" }), "min-h-11")}
          >
            {t(kind)}
          </Link>
        ))}
      </nav>
      <details open={period.kind === "custom"} className="rounded-md border bg-card px-3">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">{t("custom")}</summary>
        <form method="get" action={`/${locale}/dashboard`} className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-end">
          <input type="hidden" name="period" value="custom" />
          {employee ? <input type="hidden" name="employee" value={employee} /> : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor="period-from">{t("from")}</Label>
            <Input id="period-from" name="from" type="date" required defaultValue={period.from} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="period-to">{t("to")}</Label>
            <Input id="period-to" name="to" type="date" required defaultValue={period.to} />
          </div>
          <Button type="submit" variant="outline">
            {t("apply")}
          </Button>
        </form>
        <p className="pb-3 text-xs text-muted-foreground">{t("customHint", { days: MAX_PERIOD_DAYS })}</p>
      </details>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {period.from === period.to
          ? t("showingDay", { day: formatDay(format, period.from) })
          : t("showingRange", { from: formatDay(format, period.from), to: formatDay(format, period.to) })}
      </p>
    </section>
  );
}
