import type { TranslatedCode } from "@/lib/errors";

/**
 * Offline command queue types (docs/ARCHITECTURE.md §6). A queued item is one
 * device-retried `api.*` command. Its `id` is a client uuid that doubles as the
 * command's idempotency key / client ref, so replaying it is exactly-once.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const QUEUE_STATUSES = ["pending", "syncing", "failed", "conflict", "done"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/** Why the last attempt did not succeed. Only translatable keys; raw SQL text never lands here. */
export interface QueueError {
  /** Business code, e.g. INSUFFICIENT_STOCK, or an engine code (NO_SENDER, UNAVAILABLE). */
  code: string;
  /** Fallback translation under `errors.*`. */
  messageKey: TranslatedCode;
  requestId?: string;
  /** ISO time of the attempt. */
  at: string;
  conflict?: ConflictPayload;
}

export interface QueueItem {
  /** Client uuid = idempotency key / client ref of the command. */
  id: string;
  /** Owner of the item; the store is also per user (see queue.ts). */
  userId: string;
  /** Id of a registered sender, e.g. "field.visit_check_in". */
  command: string;
  /** JSON arguments handed to the sender. */
  args: JsonObject;
  /**
   * Items sharing a group (e.g. one visit id for check-in then check-out) are applied
   * strictly in order: a later item waits while an earlier one is unresolved.
   */
  groupKey: string | null;
  /** Optional synthetic, human summary for the sync screen (e.g. a clinic name). */
  summary: string | null;
  /** ISO time the item was queued on the device. */
  createdAt: string;
  /** Monotonic order key (createdAt order, ties broken by queue order). */
  seq: number;
  /** Number of sends tried. */
  attempts: number;
  status: QueueStatus;
  lastError: QueueError | null;
  /** "stale": older than the queue max age (7 days); never auto-applied. */
  flag: "stale" | null;
  /** The user reviewed a stale item and asked to send it anyway. */
  staleAcknowledged: boolean;
  /** Server answer for done items (e.g. { verification_status, replayed }). */
  result: Json | null;
  updatedAt: string;
}

/** What a sender returns. Build it on the server with `toSendResult()` (result.ts). */
export type SendResult = { ok: true; data?: Json | null } | { ok: false; error: SendError };

export interface SendError {
  code: string;
  messageKey: TranslatedCode;
  /** The server certainly rolled the attempt back (serialization failure, deadlock): safe to re-run. */
  retryable: boolean;
  /** The outcome is unknown (connection lost mid-request). Safe to re-run only for idempotent commands. */
  ambiguous?: boolean;
  requestId?: string;
  /** Present for a version conflict (someone else changed the record). */
  conflict?: ConflictPayload;
}

/** A version conflict, shown as "server vs yours". All fields are optional and generic. */
export interface ConflictPayload {
  /** The record's current version on the server, when known. */
  currentVersion?: number;
  /** Server-side values (flat or nested JSON). */
  server?: JsonObject;
  /** The values the user sent; defaults to the item's args. */
  yours?: JsonObject;
}

export interface SendMeta {
  /** The item id: pass it as p_client_ref / p_idempotency_key / the entity id. */
  id: string;
  /** ISO time the item was queued (use as captured_at when the args don't carry one). */
  createdAt: string;
  /** 1 for the first send. */
  attempt: number;
}

export type Sender<A extends JsonObject = JsonObject> = (args: A, meta: SendMeta) => Promise<SendResult>;

/** Storage behind the queue: IndexedDB in the browser, an in-memory map in tests. */
export interface QueueStore {
  /** Whether items survive a reload (false for the in-memory fallback). */
  readonly persistent: boolean;
  getAll(): Promise<QueueItem[]>;
  get(id: string): Promise<QueueItem | undefined>;
  /** Inserts unless an item with that id exists. Returns the stored item. */
  add(item: QueueItem): Promise<QueueItem>;
  put(item: QueueItem): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}
