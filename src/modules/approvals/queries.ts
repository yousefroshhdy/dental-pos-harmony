import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { MARK_READ_MAX } from "./schemas";
import type { ApprovalRequestRow, ApprovalStepRow, InboxTab, NotificationRow } from "./types";

/**
 * Approvals and notifications reads. All go through the user's session against
 * api.v_* views (security_invoker), so RLS decides what comes back.
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null; count?: number | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "approvals.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "approvals.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

const REQUEST_COLUMNS = [
  "request_id, workflow_code, workflow_name, entity_type, entity_id, payload, status, current_stage",
  "stage_count, stage_approver_type, stage_permission, stage_required_approvals, stage_approvals, stage_started_at",
  "created_at, decided_at, requested_by, requester_name_en, requester_name_ar",
  "subject_employee_id, subject_name_en, subject_name_ar, is_mine, can_decide, my_verdict",
  "decided_by_me, my_decision, my_decided_at, customer_no, customer_name",
  "from_employee_name_en, from_employee_name_ar, to_employee_name_en, to_employee_name_ar",
  "warehouse_code, warehouse_name, variant_sku, variant_name",
].join(", ");

/** Rows per inbox tab (the decide tab is the actionable queue; the others are history). */
export const INBOX_LIMIT = 100;

export async function listInbox(tab: InboxTab): Promise<Result<ApprovalRequestRow[]>> {
  const db = await createClient();
  const base = db.from("v_approval_requests").select(REQUEST_COLUMNS);
  const query =
    tab === "decide"
      ? base.eq("can_decide", true).order("stage_started_at", { ascending: true })
      : tab === "mine"
        ? base.eq("is_mine", true).order("created_at", { ascending: false })
        : base.eq("decided_by_me", true).order("my_decided_at", { ascending: false });
  return run("v_approval_requests", query.limit(INBOX_LIMIT), []);
}

/** How many requests wait for the caller's decision (for the tab label). */
export async function countToDecide(): Promise<Result<number>> {
  const db = await createClient();
  try {
    const { count, error } = await db.from("v_approval_requests").select("request_id", { count: "exact", head: true }).eq("can_decide", true);
    if (error) return fail(parseDbError(error));
    return ok(count ?? 0);
  } catch (cause) {
    return fail(networkError(cause));
  }
}

export async function getRequest(requestId: string): Promise<Result<ApprovalRequestRow | null>> {
  const db = await createClient();
  return run("v_approval_requests", db.from("v_approval_requests").select(REQUEST_COLUMNS).eq("request_id", requestId).maybeSingle(), null);
}

export async function listSteps(requestId: string): Promise<Result<ApprovalStepRow[]>> {
  const db = await createClient();
  return run(
    "v_approval_steps",
    db
      .from("v_approval_steps")
      .select(
        "id, request_id, stage_no, decision, comment, decided_at, approver_id, approver_name_en, approver_name_ar, on_behalf_of, on_behalf_of_name_en, on_behalf_of_name_ar",
      )
      .eq("request_id", requestId)
      .order("decided_at", { ascending: true }),
    [],
  );
}

/** Notifications page size; also the most that "mark all read" marks at once. */
export const NOTIFICATIONS_LIMIT = MARK_READ_MAX;

export async function listNotifications(filter: "unread" | "all"): Promise<Result<NotificationRow[]>> {
  const db = await createClient();
  let query = db.from("v_notifications").select("id, type, title, body, link, data, read_at, created_at");
  if (filter === "unread") query = query.is("read_at", null);
  return run("v_notifications", query.order("created_at", { ascending: false }).limit(NOTIFICATIONS_LIMIT), []);
}

export async function countUnreadNotifications(): Promise<Result<number>> {
  const db = await createClient();
  try {
    const { count, error } = await db.from("v_notifications").select("id", { count: "exact", head: true }).is("read_at", null);
    if (error) return fail(parseDbError(error));
    return ok(count ?? 0);
  } catch (cause) {
    return fail(networkError(cause));
  }
}

/** Ids of the caller's unread notifications (newest first, capped), for "mark all read". */
export async function listUnreadNotificationIds(): Promise<Result<string[]>> {
  const db = await createClient();
  const result = await run<{ id: string }[]>(
    "v_notifications",
    db.from("v_notifications").select("id").is("read_at", null).order("created_at", { ascending: false }).limit(MARK_READ_MAX),
    [],
  );
  return result.ok ? ok(result.data.map((r) => r.id)) : result;
}
