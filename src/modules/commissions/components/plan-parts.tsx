import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { formatDay, formatEgp, formatRate } from "../format";
import { groupUnrated, ruleStateTone, statementFunnel } from "../logic";
import type { RuleRow, StatementTotalsRow, UnratedRow } from "../types";

/**
 * Read-only parts of the rate editor and the rep statement (server components). Lists, not
 * wide tables, so they read on a 360 px phone.
 */

function targetLabel(rule: RuleRow, lang: string): string | null {
  const name = (lang === "ar" ? rule.target_name_ar : null) ?? rule.target_name_en;
  if (!name) return rule.target_code;
  return rule.target_code && rule.target_code !== name ? `${name} (${rule.target_code})` : name;
}

/** Rate rows: target, rate, the days it applies, its state. */
export async function RuleList({ rules, emptyKey }: { rules: readonly RuleRow[]; emptyKey: "rulesEmpty" | "historyEmpty" }) {
  const t = await getTranslations("commissions.plans");
  const format = await getFormatter();
  const lang = await getLocale();
  if (rules.length === 0) return <p className="text-sm text-muted-foreground">{t(emptyKey)}</p>;
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {rules.map((r) => (
        <li key={r.id} className="flex flex-col gap-1 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{t(`targetType.${r.target_type}`)}</Badge>
              <span className="text-sm font-medium break-words">{r.target_type === "default" ? t("planDefault") : targetLabel(r, lang)}</span>
              <Badge tone={ruleStateTone(r.state)}>{t(`state.${r.state}`)}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {r.effective_from ? t("fromDay", { day: formatDay(format, r.effective_from) }) : t("fromPlanStart")}
              {r.effective_to ? ` · ${t("toDay", { day: formatDay(format, r.effective_to) })}` : null}
              {r.note ? ` · ${r.note}` : null}
            </p>
          </div>
          <p className="shrink-0 text-base font-semibold tabular-nums sm:text-end">{formatRate(format, r.rate_pct)}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Products that earn 0 because no rate applies to them today (for example bone grafts and
 * membranes until the owner sets a rate), grouped by brand, each with a link that opens the
 * rate form for that brand or product.
 */
export async function UnratedList({ rows, planId, canEdit }: { rows: readonly UnratedRow[]; planId: string; canEdit: boolean }) {
  const t = await getTranslations("commissions.plans");
  const lang = await getLocale();
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t("unratedEmpty")}</p>;
  const groups = groupUnrated(rows);
  const setLink = (target: "brand" | "variant", id: string) =>
    `/commissions/plans/${planId}?target=${target}&target_id=${id}#rate-form`;
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <section key={g.brandCode} className="rounded-lg border bg-card" aria-label={g.brandName}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <h3 className="text-sm font-semibold">
              {g.brandName} <span className="text-muted-foreground" dir="ltr">({g.brandCode})</span> · {t("unratedCount", { count: g.items.length })}
            </h3>
            {canEdit ? (
              <Link href={setLink("brand", g.brandId)} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
                {t("setBrandRate")}
              </Link>
            ) : null}
          </div>
          <ul className="divide-y">
            {g.items.map((r) => (
              <li key={r.variant_id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm break-words">{(lang === "ar" ? r.product_name_ar : null) ?? r.product_name_en}</p>
                  <p className="text-xs text-muted-foreground">
                    <span dir="ltr">{r.sku}</span> · {lang === "ar" ? r.category_name_ar : r.category_name_en}
                  </p>
                </div>
                {canEdit ? (
                  <Link href={setLink("variant", r.variant_id)} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
                    {t("setProductRate")}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The rep statement in steps: collected cash (incl. VAT) → VAT out → commissionable amount
 * → (without a rate) → commission → clawbacks → adjustments → net. Figures from
 * api.v_commission_statement_totals.
 */
export async function StatementFunnel({ totals }: { totals: StatementTotalsRow | null }) {
  const t = await getTranslations("commissions.statement.funnel");
  const format = await getFormatter();
  const steps = statementFunnel(totals);
  return (
    <dl className="divide-y rounded-lg border bg-card text-sm">
      {steps.map((s) => (
        <div
          key={s.key}
          className={`flex items-baseline justify-between gap-3 px-3 py-2 ${s.detail ? "ps-6 text-muted-foreground" : ""} ${s.key === "net" ? "font-semibold" : ""}`}
        >
          <dt className="min-w-0">{t(s.key)}</dt>
          <dd className={`shrink-0 tabular-nums ${s.value < 0 && !s.detail ? "text-destructive" : ""}`}>{formatEgp(format, s.value)}</dd>
        </div>
      ))}
    </dl>
  );
}
