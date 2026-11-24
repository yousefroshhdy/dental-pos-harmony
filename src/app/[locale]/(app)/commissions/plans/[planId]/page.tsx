import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Forbidden } from "@/components/forbidden";
import { Alert, Badge, Card, CardTitle } from "@/components/ui/primitives";
import { BackLink } from "@/components/page-kit/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { directionOf } from "@/i18n/routing";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { CommissionError } from "@/modules/commissions/components/commission-error";
import { ActivatePlanForm, DeactivatePlanForm, RateForm } from "@/modules/commissions/components/plan-forms";
import { RuleList, UnratedList } from "@/modules/commissions/components/plan-parts";
import { CAIRO_DATE_TIME, formatDay } from "@/modules/commissions/format";
import { cairoToday, canEditPlan, commissionErrorCode, historyRules, liveRules, planStatusTone } from "@/modules/commissions/logic";
import { getPlan, listPlanRules, listRateTargets, listUnrated, RULE_LIMIT } from "@/modules/commissions/queries";
import { parsePlanId } from "@/modules/commissions/schemas";
import { RATE_TARGETS, type RateTarget } from "@/modules/commissions/types";

type Params = Promise<{ locale: string; planId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "commissions.plans" });
  return { title: t("editorTitle") };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * One commission plan: status (draft → active → retired), the rates in force and scheduled
 * (most specific first: product > category > brand > plan default), the "no rate" list, the
 * history, and, for the owner, the forms. `?target=&target_id=` pre-fills the rate form.
 */
export default async function CommissionPlanPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locale, planId: raw } = await params;
  setRequestLocale(locale);
  const planId = parsePlanId(raw);
  if (!planId) notFound();
  const ctx = await getUserContext();
  if (!can(ctx, "perf.commission_plan.read") && !can(ctx, "perf.commission_plan.manage")) return <Forbidden />;
  const canManage = can(ctx, "perf.commission_plan.manage", "all");

  const t = await getTranslations("commissions.plans");
  const format = await getFormatter();
  const today = cairoToday();
  const plan = await getPlan(planId);
  const back = <BackLink href="/commissions/plans">{t("back")}</BackLink>;
  if (!plan.ok)
    return (
      <div className="space-y-6">
        {back}
        <CommissionError code={commissionErrorCode(plan.error)} requestId={plan.error.requestId} />
      </div>
    );
  if (!plan.data) notFound();
  const p = plan.data;
  const editable = canManage && canEditPlan(p.status);

  const [rules, unrated, targets] = await Promise.all([
    listPlanRules(planId),
    listUnrated(planId),
    editable ? listRateTargets(locale) : Promise.resolve(null),
  ]);

  const sp = await searchParams;
  const wanted = first(sp.target);
  const target: RateTarget = wanted && (RATE_TARGETS as readonly string[]).includes(wanted) ? (wanted as RateTarget) : "brand";
  const targetId = parsePlanId(first(sp.target_id) ?? "");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={back}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span dir="ltr">{p.code}</span>
            <Badge tone={planStatusTone(p.status)}>{t(`status.${p.status}`)}</Badge>
            {p.is_default ? <Badge tone="info">{t("default")}</Badge> : null}
          </span>
        }
        description={
          <span className="flex flex-col gap-1">
            <span className="break-words">{p.name}</span>
            <span className="text-xs">
              {p.status === "draft" ? t("notActive") : t("fromDay", { day: formatDay(format, p.effective_from) })}
              {p.effective_to ? ` · ${t("toDay", { day: formatDay(format, p.effective_to) })}` : null}
              {p.activated_at ? ` · ${t("activatedAt", { at: format.dateTime(new Date(p.activated_at), CAIRO_DATE_TIME) })}` : null}
              {p.status !== "draft" ? ` · ${t("assignedCount", { count: p.assigned_count })}` : null}
            </span>
          </span>
        }
      />
      <Alert tone="info" role="status">
        {t("rulesExplained")}
      </Alert>

      {canManage && p.status === "draft" ? (
        <Card className="space-y-3 border-warning/60">
          <CardTitle>{t("activateTitle")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("activateHint")}</p>
          <ActivatePlanForm planId={p.id} code={p.code} today={today} />
        </Card>
      ) : null}

      {/* Remounts when a "set rate" link changes ?target=, so the rate tab opens with the form filled in. */}
      <Tabs key={`${wanted ?? ""}:${targetId ?? ""}`} defaultValue="rates" dir={directionOf(locale)}>
        <TabsList className="w-full justify-start sm:w-auto">
          <TabsTrigger value="rates">{t("rulesLive")}</TabsTrigger>
          <TabsTrigger value="unrated">
            {t("unratedTitle")}
            {unrated.ok && unrated.data.length > 0 ? (
              <span className="rounded-full bg-warning/25 px-1.5 text-xs tabular-nums">{unrated.data.length}</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="history">{t("historyTitle")}</TabsTrigger>
        </TabsList>

        <TabsContent value="rates" className="space-y-4">
      <section className="space-y-3" aria-labelledby="rates-live">
        <h2 id="rates-live" className="text-lg font-semibold">
          {t("rulesLive")}
        </h2>
        {rules.ok ? <RuleList rules={liveRules(rules.data)} emptyKey="rulesEmpty" /> : <CommissionError code={commissionErrorCode(rules.error)} requestId={rules.error.requestId} />}
      </section>

      {editable ? (
        <Card className="space-y-4">
          <CardTitle>{t("rateTitle")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("rateHint")}</p>
          {targets && targets.ok ? (
            <RateForm planId={p.id} today={today} options={targets.data} defaults={{ target, targetId }} />
          ) : targets && !targets.ok ? (
            <CommissionError code={commissionErrorCode(targets.error)} requestId={targets.error.requestId} />
          ) : null}
        </Card>
      ) : canManage && p.status === "retired" ? (
        <Alert tone="info" role="status">
          {t("retiredReadOnly")}
        </Alert>
      ) : null}
        </TabsContent>

        <TabsContent value="unrated">
      <section className="space-y-3" aria-labelledby="rates-unrated">
        <h2 id="rates-unrated" className="text-lg font-semibold">
          {t("unratedTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("unratedHint")}</p>
        {unrated.ok ? (
          <UnratedList rows={unrated.data} planId={p.id} canEdit={editable} />
        ) : (
          <CommissionError code={commissionErrorCode(unrated.error)} requestId={unrated.error.requestId} />
        )}
      </section>

        </TabsContent>

        <TabsContent value="history">
      <section className="space-y-3" aria-labelledby="rates-history">
        <h2 id="rates-history" className="text-lg font-semibold">
          {t("historyTitle")}
        </h2>
        {rules.ok ? (
          <>
            <RuleList rules={historyRules(rules.data)} emptyKey="historyEmpty" />
            {rules.data.length >= RULE_LIMIT ? <p className="text-xs text-muted-foreground">{t("limited", { count: RULE_LIMIT })}</p> : null}
          </>
        ) : null}
      </section>
        </TabsContent>
      </Tabs>

      {canManage && p.status === "active" ? (
        <Card className="space-y-3 border-destructive/40">
          <CardTitle>{t("deactivateTitle")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("deactivateHint")}</p>
          <DeactivatePlanForm planId={p.id} code={p.code} today={today} />
        </Card>
      ) : null}
      {p.status === "retired" && p.retire_reason ? (
        <p className="text-xs text-muted-foreground">{t("retiredBecause", { reason: p.retire_reason })}</p>
      ) : null}
    </div>
  );
}
