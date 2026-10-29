import { requestVisitException, visitCheckIn, visitCheckOut } from "./actions";
import type { CheckInPayload, CheckOutPayload, VisitExceptionPayload } from "./schemas";

/**
 * Device commands: the ONLY place the browser sends a field command. Each
 * sender takes a payload that was fully built before the first attempt (ids,
 * GPS fix, device timestamp; see payloads.ts), so the offline queue can persist
 * the payload and wrap these functions without changing them. Sending the same
 * payload twice is safe: the server replays the first answer for the same
 * visit id. A failure with `retryable: true` may be re-sent unchanged.
 */
export const sendVisitCheckIn = (payload: CheckInPayload) => visitCheckIn(payload);
export const sendVisitCheckOut = (payload: CheckOutPayload) => visitCheckOut(payload);
export const sendVisitException = (payload: VisitExceptionPayload) => requestVisitException(payload);

/** Command name → sender, for the offline queue's replay loop. */
export const FIELD_DEVICE_COMMANDS = {
  "field.visit_check_in": sendVisitCheckIn,
  "field.visit_check_out": sendVisitCheckOut,
  "field.visit_exception": sendVisitException,
} as const;
export type FieldDeviceCommand = keyof typeof FIELD_DEVICE_COMMANDS;
