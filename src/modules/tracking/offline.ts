import { registerSender, type SenderOptions } from "@/lib/offline/sync";
import type { JsonObject, Sender } from "@/lib/offline/types";
import { endShift, recordLocationPings, startShift } from "./actions";
import { TRACKING_QUEUED_COMMANDS, trackingToSendResult } from "./logic";

/**
 * Offline queue senders for work-hours tracking. Each replays the stored payload
 * through the same server action as the online path; the api.* commands are
 * idempotent (start/end by client ref, points by point id), so all three are
 * registered `idempotent: true` and a lost answer is simply re-sent. Registered
 * app-wide by src/modules/offline/senders.ts.
 */

type Register = (command: string, send: Sender, opts?: SenderOptions) => () => void;

const TRACKING_SENDERS: Record<string, Sender> = {
  [TRACKING_QUEUED_COMMANDS.startShift]: async (args: JsonObject) => trackingToSendResult(await startShift(args)),
  [TRACKING_QUEUED_COMMANDS.endShift]: async (args: JsonObject) => trackingToSendResult(await endShift(args)),
  [TRACKING_QUEUED_COMMANDS.recordPings]: async (args: JsonObject) => trackingToSendResult(await recordLocationPings(args)),
};

export function registerTrackingSenders(register: Register = registerSender): () => void {
  const offs = Object.entries(TRACKING_SENDERS).map(([command, send]) => register(command, send, { idempotent: true }));
  return () => {
    for (const off of offs) off();
  };
}
