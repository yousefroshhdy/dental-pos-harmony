import { registerSender, type SenderOptions } from "@/lib/offline/sync";
import type { JsonObject, Sender } from "@/lib/offline/types";
import { sendCompleteTask, sendVisitCheckIn, sendVisitCheckOut } from "./device";
import { deviceToSendResult, FIELD_QUEUED_COMMANDS } from "./logic";
import type { CheckInPayload, CheckOutPayload, CompleteTaskPayload } from "./schemas";

/**
 * Offline queue senders for the field module. Each one replays a stored
 * payload through the same server action the online path calls, unchanged:
 * the action re-validates it with its zod schema and the api.* command is
 * idempotent on the payload's visit id / task id, so a replay applies at most
 * once and answers `replayed: true`. Registered app-wide by
 * src/modules/offline/senders.ts.
 */

type Register = (command: string, send: Sender, opts?: SenderOptions) => () => void;

const FIELD_SENDERS: Record<string, Sender> = {
  [FIELD_QUEUED_COMMANDS.checkIn]: async (args: JsonObject) => deviceToSendResult(await sendVisitCheckIn(args as unknown as CheckInPayload)),
  [FIELD_QUEUED_COMMANDS.checkOut]: async (args: JsonObject) => deviceToSendResult(await sendVisitCheckOut(args as unknown as CheckOutPayload)),
  [FIELD_QUEUED_COMMANDS.completeTask]: async (args: JsonObject) =>
    deviceToSendResult(await sendCompleteTask(args as unknown as CompleteTaskPayload)),
};

/** Registers the field senders (idempotent by key: re-registering replaces). Returns the unregister function. */
export function registerFieldSenders(register: Register = registerSender): () => void {
  const offs = Object.entries(FIELD_SENDERS).map(([command, send]) => register(command, send, { idempotent: true }));
  return () => {
    for (const off of offs) off();
  };
}
