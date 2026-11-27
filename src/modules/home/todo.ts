import { can, canAny, type UserContext } from "@/lib/authz/can";
import { decidesApprovals } from "@/modules/approvals/nav";
import type { HomeRole } from "./logic";

/**
 * "What do I do now?" (Phase P H1 UI pass): each role home opens with a short, ordered
 * to-do list. Pure and unit-tested (tests/unit/home-todo.test.ts). Every entry is a
 * count read from an existing api.* view as the signed-in user (src/modules/home/queries.ts),
 * so RLS decides what is counted; the permission here only decides whether the entry is
 * shown (UX only, the same permission that opens or acts on the target screen).
 */
export const TODO_KEYS = [
  "planToday",
  "leadsNew",
  "draftOrders",
  "tasksToday",
  "approvals",
  "repsNeedingAttention",
  "paymentsToVerify",
  "ordersToInvoice",
  "overdueInvoices",
  "returnsToCredit",
  "ordersToReserve",
  "ordersToFulfil",
  "returnsToReceive",
  "draftReceipts",
  "lowStock",
] as const;
export type TodoKey = (typeof TODO_KEYS)[number];

export interface TodoSpec {
  key: TodoKey;
  /** The screen that holds the work, filtered where the list supports it. */
  href: string;
  /** Shown only to holders (the owner holds every permission). */
  permission: string;
  /** Optional: the entry also needs at least one of these. */
  anyPermission?: readonly string[];
  /** Waiting costs money or a customer (overdue, stuck, short): the count shows in the danger colour. */
  urgent?: boolean;
  /** Only for people who can decide some approval (holding wf.approval.read alone decides nothing). */
  decidersOnly?: boolean;
}

const SPECS: Record<TodoKey, TodoSpec> = {
  planToday: { key: "planToday", href: "/today", permission: "field.visit.create" },
  leadsNew: { key: "leadsNew", href: "/leads", permission: "crm.lead.read" },
  draftOrders: { key: "draftOrders", href: "/orders?status=draft", permission: "sales.order.create" },
  tasksToday: { key: "tasksToday", href: "/tasks", permission: "work.task.read" },
  approvals: { key: "approvals", href: "/approvals", permission: "wf.approval.read", decidersOnly: true },
  repsNeedingAttention: { key: "repsNeedingAttention", href: "/tracking", permission: "field.tracking.read", urgent: true },
  paymentsToVerify: { key: "paymentsToVerify", href: "/finance/payments?status=pending", permission: "finance.payment.confirm" },
  ordersToInvoice: { key: "ordersToInvoice", href: "/finance/invoices/new", permission: "finance.invoice.issue" },
  overdueInvoices: { key: "overdueInvoices", href: "/finance/invoices?status=overdue", permission: "finance.invoice.read", urgent: true },
  returnsToCredit: { key: "returnsToCredit", href: "/returns?status=received", permission: "sales.return.credit" },
  ordersToReserve: { key: "ordersToReserve", href: "/orders?status=approved", permission: "sales.order.fulfil" },
  ordersToFulfil: { key: "ordersToFulfil", href: "/orders?status=approved", permission: "sales.order.fulfil" },
  returnsToReceive: { key: "returnsToReceive", href: "/returns?status=approved", permission: "sales.return.receive" },
  draftReceipts: { key: "draftReceipts", href: "/inventory/receipts?status=draft", permission: "inventory.receipt.post" },
  lowStock: { key: "lowStock", href: "/inventory?alert=below_reorder", permission: "inventory.module.access", urgent: true },
};

/**
 * The to-do entries of each home, in the order the role works through them. The owner's
 * setup steps are a card of their own (until setup is complete), not an entry here.
 */
export const ROLE_TODOS: Record<HomeRole, readonly TodoKey[]> = {
  rep: ["planToday", "leadsNew", "draftOrders", "tasksToday"],
  manager: ["approvals", "repsNeedingAttention"],
  finance: ["paymentsToVerify", "ordersToInvoice", "overdueInvoices", "returnsToCredit", "approvals"],
  inventory: ["ordersToReserve", "ordersToFulfil", "returnsToReceive", "draftReceipts", "lowStock", "approvals"],
  owner: ["approvals", "overdueInvoices", "repsNeedingAttention"],
  general: ["approvals"],
};

/** The entries this user may see on this home (UX only). */
export function visibleTodos(role: HomeRole, ctx: UserContext): TodoSpec[] {
  return ROLE_TODOS[role]
    .map((k) => SPECS[k])
    .filter(
      (s) =>
        can(ctx, s.permission) &&
        (s.anyPermission === undefined || canAny(ctx, s.anyPermission)) &&
        (!s.decidersOnly || decidesApprovals(ctx)),
    );
}

/** A count that did not load is `null` (shown as "couldn't load", never as zero). */
export type TodoCounts = Partial<Record<TodoKey, number | null>>;

export type TodoState = "todo" | "done" | "error";

export interface TodoItem extends TodoSpec {
  count: number | null;
  state: TodoState;
}

/**
 * The list as shown: open work first (in the role's order), then entries that failed to
 * load, then the ones with nothing waiting. An entry missing from `counts` is left out.
 */
export function buildTodos(specs: readonly TodoSpec[], counts: TodoCounts): TodoItem[] {
  const items: TodoItem[] = [];
  for (const s of specs) {
    if (!(s.key in counts)) continue;
    const raw = counts[s.key];
    const count = raw === null || raw === undefined || !Number.isFinite(raw) ? null : Math.max(0, Math.trunc(raw));
    items.push({ ...s, count, state: count === null ? "error" : count > 0 ? "todo" : "done" });
  }
  const rank: Record<TodoState, number> = { todo: 0, error: 1, done: 2 };
  // Array.prototype.sort is stable, so the role's order holds inside each state.
  return items.sort((a, b) => rank[a.state] - rank[b.state]);
}

/** Setup steps still open, in checklist order (the owner's setup card; empty once setup is complete). */
export function remainingSteps<T extends { done: boolean }>(steps: readonly T[]): T[] {
  return steps.filter((s) => !s.done);
}

/** A setup step's link from the home: anchors point into /admin/setup, import links stay as they are. */
export function setupStepHref(href: string): string {
  return href.startsWith("#") ? `/admin/setup${href}` : href;
}
