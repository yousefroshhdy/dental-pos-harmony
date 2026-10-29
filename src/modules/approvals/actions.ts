"use server";

import { revalidatePath } from "next/cache";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { errorKeyFor } from "./logic";
import { listUnreadNotificationIds } from "./queries";
import { decideSchema, formToObject, markReadSchema } from "./schemas";
import type { ActionResult, ActionState, RequestStatus } from "./types";

/**
 * Approvals and notifications mutations. Each action validates FormData and
 * calls exactly one api.* command as the signed-in user (callCommand).
 * Authorization is NOT decided here: the request id is untrusted, and
 * api.decide_approval re-checks self-approval, stage, scope, limit and state.
 */

const failed = (error: AppError): ActionResult => ({ ok: false, messageKey: errorKeyFor(error), requestId: error.requestId });

function refreshApprovals() {
  revalidatePath("/[locale]/approvals", "page");
  revalidatePath("/[locale]/approvals/[id]", "page");
  revalidatePath("/[locale]/notifications", "page");
}

export async function decideApproval(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = decideSchema.safeParse(formToObject(form));
  if (!parsed.success) {
    const commentIssue = parsed.error.issues.some((i) => i.path[0] === "comment");
    return { ok: false, messageKey: commentIssue ? "COMMENT_REQUIRED" : "VALIDATION" };
  }
  const { request_id, decision, comment } = parsed.data;
  const result = await callCommand<{ status?: RequestStatus; current_stage?: number }>("decide_approval", {
    p_request_id: request_id,
    p_decision: decision,
    p_comment: comment ?? null,
  });
  if (!result.ok) return failed(result.error);
  refreshApprovals();
  return { ok: true, status: result.data?.status, currentStage: result.data?.current_stage };
}

export async function markNotificationsRead(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = markReadSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, messageKey: "VALIDATION" };
  const result = await callCommand<number>("mark_notifications_read", { p_ids: parsed.data.ids });
  if (!result.ok) return failed(result.error);
  // The unread badge lives in the app layout.
  revalidatePath("/[locale]", "layout");
  return { ok: true };
}

/** Marks the caller's unread notifications (up to one page). The command only touches the caller's own rows. */
export async function markAllNotificationsRead(): Promise<ActionResult> {
  const ids = await listUnreadNotificationIds();
  if (!ids.ok) return failed(ids.error);
  if (ids.data.length === 0) return { ok: true };
  const result = await callCommand<number>("mark_notifications_read", { p_ids: ids.data });
  if (!result.ok) return failed(result.error);
  revalidatePath("/[locale]", "layout");
  return { ok: true };
}
