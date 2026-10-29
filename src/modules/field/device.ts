import { completeTask, requestVisitException, visitCheckIn, visitCheckOut } from "./actions";
import type { CheckInPayload, CheckOutPayload, CompleteTaskPayload, VisitExceptionPayload } from "./schemas";

/**
 * Device commands: the ONLY place the browser sends a field command. Each
 * sender takes a payload that was fully built before the first attempt (ids,
 * GPS fix, device timestamp; see payloads.ts), so the offline queue can persist
 * the payload and replay it through these same functions (offline.ts).
 * Sending the same payload twice is safe: the server replays the first answer
 * for the same visit id / task id. A failure with `retryable: true` may be
 * re-sent unchanged.
 *
 * The exception request is online-only. api.request_visit_exception has no
 * client ref: it answers "replayed" only while the approval request is still
 * pending. After a manager decides, a late replay fails with INVALID_STATE, so
 * a queued copy could end up "failed" although it was applied. It also needs
 * the server's verdict first, which the rep only sees online.
 */
export const sendVisitCheckIn = (payload: CheckInPayload) => visitCheckIn(payload);
export const sendVisitCheckOut = (payload: CheckOutPayload) => visitCheckOut(payload);
export const sendCompleteTask = (payload: CompleteTaskPayload) => completeTask(payload);
export const sendVisitException = (payload: VisitExceptionPayload) => requestVisitException(payload);
