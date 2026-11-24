import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { FormSheet } from "@/components/page-kit/form-sheet";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { CommissionError } from "@/modules/commissions/components/commission-error";
import { PlansTable, type PlanListRow } from "@/modules/commissions/components/commission-tables";
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

  const tc = await getTranslations("commissions.tables");
  const rows: PlanListRow[] = (plans.ok ? plans.data : []).map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    status: p.status,
    statusTone: planStatusTone(p.status),
    isDefault: p.is_default,
    window:
      (p.status === "draft" ? t("notActive") : t("fromDay", { day: formatDay(format, p.effective_from) })) +
      (p.effective_to ? ` · ${t("toDay", { day: formatDay(format, p.effective_to) })}` : ""),
    rates: Number(p.current_rate_count),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("intro")}
        actions={
          canManage ? (
            <FormSheet trigger={t("newPlan")} title={t("newPlan")} description={t("newPlanHint")} closeLabel={tc("close")}>
              <CreatePlanForm />
            </FormSheet>
          ) : null
        }
      />

      <PlansTable
        rows={rows}
        empty={t("empty")}
        error={plans.ok ? undefined : <CommissionError code={commissionErrorCode(plans.error)} requestId={plans.error.requestId} />}
      />
    </div>
  );
}
