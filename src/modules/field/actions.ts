"use server";

import { revalidatePath } from "next/cache";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import {
  checkInSchema,
  checkOutSchema,
  completeTaskSchema,
  createTaskSchema,
  formToObject,
  invalidFieldsOf,
  visitExceptionSchema,
} from "./schemas";
import type {
  ActionResult,
  ActionState,
  CheckInResult,
  CheckOutResult,
  CompleteTaskResult,
  DeviceResult,
  ExceptionResult,
} from "./types";

/**
 * Field and task mutations. Each action validates its input, calls exactly one
 * api.* command as the signed-in user (callCommand) and refreshes the pages
 * that show the result. Authorization is NOT decided here: ids are untrusted
 * and the database re-checks permission, scope, state and the GPS verdict.
 *
 * The device commands (check-in, check-out, exception, task completion) take a
 * plain, serializable payload that is fully built on the device before the
 * first attempt — ids, fix and device timestamp included — so the offline
 * queue can store it and replay it unchanged (src/modules/field/offline.ts).
 * Replays are idempotent on the visit id / task id.
 */

const PAGES = {
  today: "/[locale]/today",
  visits: "/[locale]/visits",
  visit: "/[locale]/visits/[id]",
  tasks: "/[locale]/tasks",
} as const;

function refresh(...pages: (keyof typeof PAGES)[]) {
  for (const page of new Set(pages)) revalidatePath(PAGES[page], "page");
}

function deviceFailure<T>(error: AppError): DeviceResult<T> {
  return {
    ok: false,
    code: error.code,
    messageKey: error.messageKey,
    // Network loss or a rolled-back attempt: the same payload may be sent again.
    retryable: error.retryable || error.code === "UNAVAILABLE",
    requestId: error.requestId,
  };
}

const invalidDevice = <T>(): DeviceResult<T> => ({ ok: false, code: "VALIDATION", messageKey: "VALIDATION", retryable: false });

export async function visitCheckIn(payload: unknown): Promise<DeviceResult<CheckInResult>> {
  const parsed = checkInSchema.safeParse(payload);
  if (!parsed.success) return invalidDevice();
  const p = parsed.data;
  const result = await callCommand<CheckInResult>("visit_check_in", {
    p_visit_id: p.visit_id,
    p_customer_id: p.customer_id,
    p_lat: p.lat,
    p_lng: p.lng,
    p_accuracy_m: p.accuracy_m,
    p_captured_at: p.captured_at,
    p_device: p.device,
  });
  if (!result.ok) return deviceFailure(result.error);
  // No revalidation: it would re-render the calling page and unmount the card
  // that shows the verdict. All field pages are dynamic, so the next visit to
  // /today or /visits reads fresh data anyway.
  return { ok: true, data: result.data };
}

export async function visitCheckOut(payload: unknown): Promise<DeviceResult<CheckOutResult>> {
  const parsed = checkOutSchema.safeParse(payload);
  if (!parsed.success) return invalidDevice();
  const p = parsed.data;
  const result = await callCommand<CheckOutResult>("visit_check_out", {
    p_visit_id: p.visit_id,
    p_outcome: p.outcome,
    p_notes: p.notes,
    p_lat: p.lat,
    p_lng: p.lng,
    p_accuracy_m: p.accuracy_m,
    p_captured_at: p.captured_at,
    p_next_follow_up_at: p.next_follow_up_at,
  });
  if (!result.ok) return deviceFailure(result.error);
  refresh("today", "visits", "visit", "tasks");
  return { ok: true, data: result.data };
}

export async function requestVisitException(payload: unknown): Promise<DeviceResult<ExceptionResult>> {
  const parsed = visitExceptionSchema.safeParse(payload);
  if (!parsed.success) {
    const reasonMissing = invalidFieldsOf(parsed.error).includes("reason");
    return reasonMissing
      ? { ok: false, code: "REASON_REQUIRED", messageKey: "REASON_REQUIRED", retryable: false }
      : invalidDevice();
  }
  const result = await callCommand<ExceptionResult>("request_visit_exception", {
    p_visit_id: parsed.data.visit_id,
    p_reason: parsed.data.reason,
  });
  if (!result.ok) return deviceFailure(result.error);
  // Not revalidated, like check-in: the form shows the result; a caller may router.refresh().
  return { ok: true, data: result.data };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const failed = (error: AppError): ActionResult => ({
  ok: false,
  messageKey: error.messageKey,
  code: error.code,
  requestId: error.requestId,
});

export async function createTask(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = createTaskSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, messageKey: "VALIDATION", code: "VALIDATION" };
  const { title, due_local, kind, customer_id, client_ref } = parsed.data;
  const result = await callCommand("create_task", {
    p_title: title,
    p_due_at: due_local,
    p_customer_id: customer_id ?? null,
    p_kind: kind,
    p_assignee_employee_id: null, // the command defaults to the caller
    p_client_ref: client_ref ?? null,
  });
  if (!result.ok) return failed(result.error);
  refresh("tasks", "today");
  return { ok: true };
}

/**
 * Task completion, a device command like check-in: the payload is built once
 * and may be replayed by the offline queue (a replay of a done task answers
 * `replayed: true`).
 */
export async function completeTask(payload: unknown): Promise<DeviceResult<CompleteTaskResult>> {
  const parsed = completeTaskSchema.safeParse(payload);
  if (!parsed.success) {
    const outcomeMissing = invalidFieldsOf(parsed.error).includes("outcome");
    return { ok: false, code: "VALIDATION", messageKey: outcomeMissing ? "REASON_REQUIRED" : "VALIDATION", retryable: false };
  }
  const result = await callCommand<CompleteTaskResult>("complete_task", { p_task_id: parsed.data.task_id, p_outcome: parsed.data.outcome });
  if (!result.ok) return deviceFailure(result.error);
  refresh("tasks", "today");
  return { ok: true, data: result.data };
}
