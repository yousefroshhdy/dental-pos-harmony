import { getTranslations } from "next-intl/server";
import { NavIcon } from "@/components/app-shell/nav-icons";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can, type UserContext } from "@/lib/authz/can";
import { navIcon, navLabelKey, visibleNavGroups } from "@/lib/nav";
import { cairoToday, monthRange } from "@/modules/dashboards/logic";
import type { KpiCode, Period } from "@/modules/dashboards/types";
import type { HomeRole } from "../logic";
import { countTodo } from "../queries";
import { buildTodos, visibleTodos, type TodoCounts } from "../todo";
import {
  AgingCard,
  ApprovalsCard,
  KpiStrip,
  PipelineCard,
  PlanTodayCard,
  ReceiptsTodayCard,
  SetupProgressCard,
  TeamActivityCard,
  TodoCard,
  VisitsTodayCard,
} from "./widgets";

const REP_KPIS: readonly KpiCode[] = ["VISITS_COMPLETED", "ORDERS_BOOKED", "BOOKED_SALES", "CASH_COLLECTED"];
const MANAGER_KPIS: readonly KpiCode[] = ["BOOKED_SALES", "ORDERS_BOOKED", "VISITS_COMPLETED", "CASH_COLLECTED"];
const OWNER_KPIS: readonly KpiCode[] = ["BOOKED_SALES", "CASH_COLLECTED", "AR_OPEN", "AR_OVERDUE", "STOCK_ALERTS", "PENDING_APPROVALS", "NET_REVENUE", "ORDERS_BOOKED"];

function periods(now: Date = new Date()): { today: Period; month: Period } {
  const day = cairoToday(now);
  const m = monthRange(day);
  return { today: { kind: "today", from: day, to: day }, month: { kind: "month", from: m.from, to: m.to } };
}

/** The role's to-do entries with their counts, read in parallel (each failure stays on its own row). */
async function loadTodos(role: HomeRole, ctx: UserContext) {
  const specs = visibleTodos(role, ctx);
  const counts: TodoCounts = Object.fromEntries(await Promise.all(specs.map(async (s) => [s.key, await countTodo(s.key)] as const)));
  return buildTodos(specs, counts);
}

/**
 * The page for one home role (Phase P step 2; H1 UI pass). Each home answers "what do I do
 * now?": the role's one primary action where it has one (the rep's "Start my day", the owner's
 * setup until it is complete), then a short ordered to-do list with live counts, then the
 * role's cards. Cards appear only for data the user can read (the same permission that opens
 * the matching screen); each card shows its own empty or error state, so one failed read never
 * blanks the page.
 */
export async function RoleHome({ role, ctx, name }: { role: HomeRole; ctx: UserContext; name: string }) {
  const t = await getTranslations("home");
  const { today, month } = periods();
  const kpis = can(ctx, "perf.kpi.read");
  const approvals = can(ctx, "wf.approval.read");
  const todos = await loadTodos(role, ctx);

  const header = (
    <PageHeader
      title={name ? t("greeting", { name }) : t("greetingNoName")}
      description={t(`subtitle.${role}`)}
      actions={
        role === "rep" && can(ctx, "field.visit.create") ? (
          <Link href="/today" className={buttonVariants({ size: "lg", className: "w-full sm:w-auto" })}>
            {t("rep.startDay")}
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
          <TodoCard items={todos} />
          <div className="grid gap-4 lg:grid-cols-2">
            <PlanTodayCard />
            <VisitsTodayCard employeeId={ctx.employee?.id ?? null} />
          </div>
          {kpis ? <KpiStrip ctx={ctx} codes={REP_KPIS} period={month} title={t("kpis.myMonth")} /> : null}
        </div>
      );
    case "manager":
      return (
        <div className="space-y-6">
          {header}
          <div className="grid gap-4 lg:grid-cols-2">
            <TodoCard items={todos} />
            <TeamActivityCard today={today} href={can(ctx, "field.tracking.read") ? "/tracking" : "/dashboard"} />
            {approvals ? <ApprovalsCard /> : null}
            {can(ctx, "crm.opportunity.read") ? <PipelineCard /> : null}
          </div>
          <KpiStrip ctx={ctx} codes={MANAGER_KPIS} period={month} title={t("kpis.teamMonth")} />
        </div>
      );
    case "finance":
      return (
        <div className="space-y-6">
          {header}
          <div className="grid gap-4 lg:grid-cols-2">
            <TodoCard items={todos} />
            {can(ctx, "finance.payment.read") ? <ReceiptsTodayCard /> : null}
            <AgingCard />
            {approvals ? <ApprovalsCard /> : null}
          </div>
        </div>
      );
    case "inventory":
      return (
        <div className="space-y-6">
          {header}
          <div className="grid gap-4 lg:grid-cols-2">
            <TodoCard items={todos} />
            <ScreensCard ctx={ctx} />
          </div>
        </div>
      );
    case "owner":
      return (
        <div className="space-y-6">
          {header}
          <SetupProgressCard />
          <div className="grid gap-4 lg:grid-cols-2">
            <TodoCard items={todos} />
            <ApprovalsCard />
          </div>
          <KpiStrip ctx={ctx} codes={OWNER_KPIS} period={month} title={t("kpis.companyMonth")} />
          <div className="grid gap-4 lg:grid-cols-2">
            <TeamActivityCard today={today} href="/tracking" />
            <AgingCard />
            <PipelineCard />
          </div>
        </div>
      );
    default:
      return (
        <div className="space-y-6">
          {header}
          {todos.length > 0 ? <TodoCard items={todos} /> : null}
          <GeneralHome ctx={ctx} />
        </div>
      );
  }
}

/**
 * The user's screens as shortcuts, by department (the same permission-filtered groups as the
 * menu), so a role without a dedicated home still lands one tap from its work.
 */
async function ScreensCard({ ctx }: { ctx: UserContext }) {
  const t = await getTranslations("home");
  const tAll = await getTranslations();
  const groups = visibleNavGroups(ctx)
    .map((g) => ({ ...g, items: g.items.filter((i) => i.href !== "/") }))
    .filter((g) => g.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <section aria-labelledby="home-screens" className="rounded-lg border bg-card p-4 shadow-sm">
      <h2 id="home-screens" className="mb-3 text-base font-semibold">
        {t("shortcuts")}
      </h2>
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.id}>
            <p className="mb-1 text-xs font-medium text-muted-foreground">{tAll(g.labelKey)}</p>
            <ul className="grid gap-1 sm:grid-cols-2">
              {g.items.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="flex min-h-11 items-center gap-3 rounded-md px-2 text-sm font-medium hover:bg-muted hover:text-primary">
                    <NavIcon icon={navIcon(item.href)} className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">{tAll(navLabelKey(ctx, item))}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Everyone else (admin, …): their screens as shortcuts, in plain words. The permission codes a
 * person holds are shown on the admin user and role screens, not on a home (docs/DECISIONS.md
 * Part C, plain language on screens).
 */
async function GeneralHome({ ctx }: { ctx: UserContext }) {
  const t = await getTranslations("home");
  if (Object.keys(ctx.permissions).length === 0) return <EmptyState title={t("noRoles")} />;
  return <ScreensCard ctx={ctx} />;
}
