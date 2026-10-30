import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { formatMonth } from "../format";
import { addMonths } from "../logic";

/**
 * Month choice for a commission page: previous / next links plus a GET form with the
 * recent months. Works without JavaScript. `extra` keeps other query parameters
 * (e.g. the employee being viewed).
 */
export async function MonthPicker({
  month,
  months,
  path,
  extra = {},
}: {
  month: string;
  months: readonly string[];
  path: string;
  extra?: Record<string, string | undefined>;
}) {
  const t = await getTranslations("commissions.period");
  const format = await getFormatter();
  const locale = await getLocale();
  const newest = months[0];
  const href = (m: string) => {
    const q = new URLSearchParams({ period: m });
    for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
    return `${path}?${q.toString()}`;
  };
  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  const options = months.includes(month) ? months : [month, ...months];

  return (
    <section aria-label={t("label")} className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <nav aria-label={t("label")} className="flex gap-2">
        <Link href={href(prev)} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-11")}>
          {t("previous")}
        </Link>
        {newest && next <= newest ? (
          <Link href={href(next)} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-11")}>
            {t("next")}
          </Link>
        ) : null}
      </nav>
      <form method="get" action={`/${locale}${path}`} className="flex items-end gap-2">
        {Object.entries(extra).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="commission-month">{t("choose")}</Label>
          <Select id="commission-month" name="period" defaultValue={month} className="min-h-11">
            {options.map((m) => (
              <option key={m} value={m}>
                {formatMonth(format, m)}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline">
          {t("apply")}
        </Button>
      </form>
    </section>
  );
}
