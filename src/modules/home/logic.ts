import { can, type UserContext } from "@/lib/authz/can";

/**
 * Role homes on /[locale] (Phase P step 2). Pure, unit-tested in
 * tests/unit/ui-home-role.test.ts. The home is a layout choice only; every number
 * on it comes from api.* views and functions that apply the caller's own scope.
 */
export const HOME_ROLES = ["owner", "finance", "manager", "rep", "general"] as const;
export type HomeRole = (typeof HOME_ROLES)[number];

/**
 * Which home to show, by the user's grants, in the owner's priority order
 * owner > finance > manager > rep:
 * - owner: the owner flag (every permission implicitly);
 * - finance: may open the receivables aging page (finance and collection officers);
 * - manager: reads KPIs at team scope or wider (area managers, the sales director);
 * - rep: may check in at a clinic;
 * - general: none of these (admin, inventory, …): the access summary.
 */
export function selectHome(ctx: UserContext): HomeRole {
  if (!ctx.active) return "general";
  if (ctx.is_owner) return "owner";
  if (can(ctx, "finance.page.aging")) return "finance";
  if (can(ctx, "perf.kpi.read", "team")) return "manager";
  if (can(ctx, "field.visit.create")) return "rep";
  return "general";
}

type Num = number | string | null | undefined;

const toNum = (v: Num): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Receipts that count as money in: everything except reversed and bounced payments. */
export function receiptsSummary(rows: readonly { amount: Num; status: string }[]): { count: number; total: number; pending: number } {
  let count = 0;
  let total = 0;
  let pending = 0;
  for (const r of rows) {
    if (r.status === "reversed" || r.status === "bounced") continue;
    count += 1;
    total += toNum(r.amount);
    if (r.status === "pending_verification") pending += 1;
  }
  // Two-decimal money: avoid float dust in the display total.
  return { count, total: Math.round(total * 100) / 100, pending };
}

export const OPEN_STAGES = ["new", "qualified", "proposal", "negotiation"] as const;
export type OpenStage = (typeof OPEN_STAGES)[number];

/** Open opportunities per stage: count and expected value, in pipeline order (closed ones ignored). */
export function pipelineByStage(rows: readonly { stage: string; expected_value: Num }[]): { stage: OpenStage; count: number; value: number }[] {
  const out = OPEN_STAGES.map((stage) => ({ stage, count: 0, value: 0 }));
  for (const r of rows) {
    const slot = out.find((s) => s.stage === r.stage);
    if (!slot) continue;
    slot.count += 1;
    slot.value += toNum(r.expected_value);
  }
  return out.map((s) => ({ ...s, value: Math.round(s.value * 100) / 100 }));
}

/** Greeting name: Arabic name on Arabic pages when there is one, else the English name. */
export function displayName(ctx: UserContext, locale: string): string {
  return (locale === "ar" ? ctx.employee?.full_name_ar : null) ?? ctx.employee?.full_name_en ?? "";
}
