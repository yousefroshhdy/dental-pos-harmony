import { registerSender, type SenderOptions } from "@/lib/offline/sync";
import type { JsonObject, Sender } from "@/lib/offline/types";
import { saveDraftOnDevice } from "./actions";
import { ORDER_QUEUED_COMMANDS, type DraftPayload } from "./offline-logic";

/**
 * Offline queue sender for order drafts. It replays the stored payload through
 * the same server action the online path calls, unchanged: the action
 * re-validates it (draftPayloadSchema, strict: no prices) and
 * api.save_order_draft is replay-safe under (order id, base version), so a
 * replay applies at most once and answers `replayed: true`.
 *
 * - idempotent: an ambiguous failure (connection lost, outcome unknown) is re-sent.
 * - versionArg "version": on a version conflict, /sync can re-send "mine" on the
 *   server's current version.
 *
 * Registered app-wide by src/modules/offline/senders.ts. Submitting an order is
 * never queued (A-05: it needs the server's pricing, stock and credit checks).
 */

type Register = (command: string, send: Sender, opts?: SenderOptions) => () => void;

const sendDraft: Sender = async (args: JsonObject) => saveDraftOnDevice(args as unknown as DraftPayload);

export function registerOrderSenders(register: Register = registerSender): () => void {
  return register(ORDER_QUEUED_COMMANDS.saveDraft, sendDraft, { idempotent: true, versionArg: "version" });
}
