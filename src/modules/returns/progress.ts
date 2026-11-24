import type { ReturnStatus } from "./types";

/**
 * The progress strip on the return page: requested → approved → received →
 * credited. Display only; the status itself comes from api.v_returns and every
 * step is a server-checked command.
 */
export const RETURN_STEPS = ["requested", "approved", "received", "credited"] as const;
export type ReturnStep = (typeof RETURN_STEPS)[number];
export type StepState = "done" | "current" | "todo" | "stopped";

/** How far the return got: index of the first step not yet done. */
const REACHED: Record<Exclude<ReturnStatus, "rejected" | "cancelled">, number> = {
  requested: 1,
  pending_approval: 1,
  approved: 2,
  received: 3,
  credited: 4,
};

export function returnProgress(
  status: ReturnStatus,
  opts: { approved?: boolean } = {},
): { ended: "rejected" | "cancelled" | null; steps: { step: ReturnStep; state: StepState }[] } {
  if (status === "rejected" || status === "cancelled") {
    // A rejection stops at the approval; a cancellation where the return then stood.
    const stoppedAt = status === "cancelled" && opts.approved ? 2 : 1;
    return {
      ended: status,
      steps: RETURN_STEPS.map((step, i) => ({ step, state: i < stoppedAt ? "done" : i === stoppedAt ? "stopped" : "todo" })),
    };
  }
  const reached = REACHED[status];
  return {
    ended: null,
    steps: RETURN_STEPS.map((step, i) => ({ step, state: i < reached ? "done" : i === reached ? "current" : "todo" })),
  };
}
