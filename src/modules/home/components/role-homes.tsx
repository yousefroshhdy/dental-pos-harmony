import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can, type UserContext } from "@/lib/authz/can";
import { cairoToday, monthRange } from "@/modules/dashboards/logic";
import type { KpiCode, Period } from "@/modules/dashboards/types";
import type { HomeRole } from "../logic";
import { AgingCard, ApprovalsCard, KpiStrip, LeadsCard, PipelineCard, PlanTodayCard, ReceiptsTodayCard, TeamActivityCard, VisitsTodayCard } from "./widgets";

const REP_KPIS: readonly KpiCode[] = ["VISITS_COMPLETED", "ORDERS_BOOKED", "BOOKED_SALES", "CASH_COLLECTED"];
const MANAGER_KPIS: readonly KpiCode[] = ["BOOKED_SALES", "ORDERS_BOOKED", "VISITS_COMPLETED", "CASH_COLLECTED"];
const OWNER_KPIS: readonly KpiCode[] = ["BOOKED_SALES", "CASH_COLLECTED", "AR_OPEN", "AR_OVERDUE", "STOCK_ALERTS", "PENDING_APPROVALS", "NET_REVENUE", "ORDERS_BOOKED"];

function periods(now: Date = new Date()): { today: Period; month: Period } {
  const day = cairoToday(now);
  const m = monthRange(day);
  return { today: { kind: "today", from: day, to: day }, month: { kind: "month", from: m.from, to: m.to } };
}

/**
 * The page for one home role. Cards appear only for data the user can read (the
 * same permission that opens the matching screen); each card shows its own empty
 * or error state, so one failed read never blanks the page.
 */
export async function RoleHome({ role, ctx, name }: { role: HomeRole; ctx: UserContext; name: string }) {
  const t = await getTranslations("home");
  const { today, month } = periods();
  const kpis = can(ctx, "perf.kpi.read");
  const approvals = can(ctx, "wf.approval.read");

  const header = (
    <PageHeader
      title={name ? t("greeting", { name }) : t("greetingNoName")}
      description={t(`subtitle.${role}`)}
      actions={
        role === "rep" && can(ctx, "field.visit.create") ? (
          <Link href="/today" className={buttonVariants()}>
            {t("rep.startDay")}
          </Link>
        ) : kpis && role !== "general" ? (
          <Link href="/dashboard" className={buttonVariants({ variant: "outline" })}>
            {t("kpis.openDashboard")}
          </Link>
        ) : null
      }
    />
  );

  switch (role) {
    case "rep":
      return (
        <div className="space-y-6">
          {header}
          <div className="grid gap-4 lg:grid-cols-2">
            <PlanTodayCard />
            <VisitsTodayCard employeeId={ctx.employee?.id ?? null} />
            <LeadsCard />
          </div>
          {kpis ? <KpiStrip codes={REP_KPIS} period={month} title={t("kpis.myMonth")} /> : null}
        </div>
      );
    case "manager":
      return (
        <div className="space-y-6">
          {header}
          <div className="grid gap-4 lg:grid-cols-2">
            <TeamActivityCard today={today} href={can(ctx, "field.tracking.read") ? "/tracking" : "/dashboard"} />
            {approvals ? <ApprovalsCard /> : null}
            {can(ctx, "crm.opportunity.read") ? <PipelineCard /> : null}
          </div>
          <KpiStrip codes={MANAGER_KPIS} period={month} title={t("kpis.teamMonth")} />
        </div>
      );
    case "finance":
      return (
        <div className="space-y-6">
          {header}
          <div className="grid gap-4 lg:grid-cols-2">
            {can(ctx, "finance.payment.read") ? <ReceiptsTodayCard /> : null}
            <AgingCard />
            {approvals ? <ApprovalsCard /> : null}
          </div>
        </div>
      );
    case "owner":
      return (
        <div className="space-y-6">
          {header}
          <KpiStrip codes={OWNER_KPIS} period={month} title={t("kpis.companyMonth")} />
          <div className="grid gap-4 lg:grid-cols-2">
            <TeamActivityCard today={today} href="/tracking" />
            <ApprovalsCard />
            <AgingCard />
            <PipelineCard />
          </div>
        </div>
      );
    default:
      return (
        <div className="space-y-6">
          {header}
          <GeneralHome ctx={ctx} />
        </div>
      );
  }
}

/** Everyone else (admin, inventory, …): their access, as before Phase P. The sidebar has their screens. */
async function GeneralHome({ ctx }: { ctx: UserContext }) {
  const t = await getTranslations("home");
  const tScopes = await getTranslations("scopes");
  const permissions = Object.entries(ctx.permissions).sort(([a], [b]) => a.localeCompare(b));

  if (permissions.length === 0) return <EmptyState title={t("noRoles")} />;
  return (
    <Card className="space-y-3">
      <CardTitle>{t("yourAccess")}</CardTitle>
      <p className="text-sm text-muted-foreground">{t("permissionCount", { count: permissions.length })}</p>
      <ul className="grid gap-1 text-sm sm:grid-cols-2">
        {permissions.map(([code, grant]) => (
          <li key={code} className="flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1">
            <code dir="ltr" className="truncate">
              {code}
            </code>
            <span className="flex gap-1">
              <Badge>{tScopes(grant.scope)}</Badge>
              {grant.limit !== null ? <Badge tone="warning">≤ {Number(grant.limit)}</Badge> : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
