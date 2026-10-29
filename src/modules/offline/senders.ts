import { clearOtherUsers } from "@/lib/offline/client";
import { registerFieldSenders } from "@/modules/field/offline";

/**
 * Client-side start of the offline queue, in one place:
 * - registers every module's queue senders (src/lib/offline/sync.ts `senders`);
 *   importing this module does it, in the browser only. A queued item whose
 *   sender is not registered on the current page waits ("NO_SENDER").
 * - `startOfflineDevice(userId)`: also, once per page load and signed-in user,
 *   deletes every OTHER user's offline queue on this device (shared devices: a
 *   session that expired instead of signing out leaves its queue behind).
 *
 * Called by the header SyncIndicator (every page) and the field components.
 *
 * Senders registered here, each opted in as idempotent (audit #15, F9):
 * - field.visit_check_in, field.visit_check_out, work.complete_task (field module)
 */

let registered = false;

export function ensureSendersRegistered(): void {
  if (registered || typeof window === "undefined") return;
  registered = true;
  registerFieldSenders();
}

const started = new Set<string>();

/** Registers the senders and wipes other users' queues (once per user per page load). */
export function startOfflineDevice(userId: string): void {
  ensureSendersRegistered();
  if (typeof window === "undefined" || started.has(userId)) return;
  started.add(userId);
  void clearOtherUsers(userId).catch(() => {
    started.delete(userId); // try again on the next start
  });
}

ensureSendersRegistered();
