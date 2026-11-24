import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { CommissionError } from "@/modules/commissions/components/commission-error";
import { CreatePlanForm } from "@/modules/commissions/components/plan-forms";
import { formatDay } from "@/modules/commissions/format";
import { commissionErrorCode, planStatusTone } from "@/modules/commissions/logic";
import { listPlans } from "@/modules/commissions/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "commissions.plans" });
  return { title: t("title") };
}

/**
 * Commission plans. Readable with perf.commission_plan.read (sales director, owner); creating
 * a plan and every rate change need perf.commission_plan.manage (the owner, with MFA).
 */
export default async function CommissionPlansPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "perf.commission_plan.read") && !can(ctx, "perf.commission_plan.manage")) return <Forbidden />;
  const canManage = can(ctx, "perf.commission_plan.manage", "all");
  const t = await getTranslations("commissions.plans");
  const format = await getFormatter();
  const plans = await listPlans();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>

      <section className="space-y-3" aria-labelledby="plans-list">
        <h2 id="plans-list" className="text-lg font-semibold">
          {t("list")}
        </h2>
        {!plans.ok ? (
          <CommissionError code={commissionErrorCode(plans.error)} requestId={plans.error.requestId} />
        ) : plans.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {plans.data.map((p) => (
              <li key={p.id}>
                <Link href={`/commissions/plans/${p.id}`} className="flex min-h-11 flex-col gap-1 px-3 py-3 hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium" dir="ltr">
                        {p.code}
                      </span>
                      <Badge tone={planStatusTone(p.status)}>{t(`status.${p.status}`)}</Badge>
                      {p.is_default ? <Badge tone="info">{t("default")}</Badge> : null}
                    </span>
                    <span className="block text-sm text-muted-foreground break-words">{p.name}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground sm:text-end">
                    {p.status === "draft" ? t("notActive") : t("fromDay", { day: formatDay(format, p.effective_from) })}
                    {p.effective_to ? ` · ${t("toDay", { day: formatDay(format, p.effective_to) })}` : null}
                    {" · "}
                    {t("rateCount", { count: p.current_rate_count })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage ? (
        <Card className="space-y-4">
          <CardTitle>{t("newPlan")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("newPlanHint")}</p>
          <CreatePlanForm />
        </Card>
      ) : null}
    </div>
  );
}
