import { fail, networkError, ok, type TranslatedCode } from "@/lib/errors";
import { withRetry } from "@/lib/retry";
import type { EnqueueInput, Queue } from "./queue";
import type { Json, JsonObject, QueueError, QueueItem, SendError, SendResult, Sender } from "./types";

/**
 * Sync engine for the offline command queue (docs/ARCHITECTURE.md §6, TESTING.md §2.6).
 *
 * - Items are sent one at a time in createdAt order. Exactly-once comes from the
 *   server: every queued command takes the item id as its idempotency key, so a
 *   replay answers `{ replayed: true }`, which is a success.
 * - Retries reuse src/lib/retry.ts. Only failures that are safe to re-run are
 *   retried: rolled-back attempts (serialization, deadlock) always; ambiguous ones
 *   (connection lost, outcome unknown — audit #15) only for senders that are
 *   idempotent by key, which queued commands are by contract.
 * - A transient failure stops the run (the device is probably offline) and keeps
 *   later items waiting, so order is preserved.
 * - Business errors move the item to `failed`, version conflicts to `conflict`;
 *   later items of the same group wait for the user to resolve them.
 * - Items older than 7 days are flagged `stale` and never applied automatically.
 */

export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Done items stay visible ("synced recently") for a day, then are dropped. */
export const DONE_RETENTION_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Sender registry
// ---------------------------------------------------------------------------

export interface SenderOptions {
  /**
   * The command is idempotent by the item id (it takes it as p_client_ref /
   * p_idempotency_key / entity id). Default true: every queued command must be.
   * When false, an ambiguous failure is never retried automatically.
   */
  idempotent?: boolean;
  /**
   * Name of the arg holding the record version (e.g. "p_version"). Enables
   * "keep mine" on a conflict: the item is re-sent with the server's current version.
   */
  versionArg?: string;
}

interface Registration {
  send: Sender;
  idempotent: boolean;
  versionArg?: string;
}

export interface SenderRegistry {
  register<A extends JsonObject>(command: string, send: Sender<A>, opts?: SenderOptions): () => void;
  get(command: string): Registration | undefined;
  clear(): void;
}

export function createSenderRegistry(): SenderRegistry {
  const map = new Map<string, Registration>();
  return {
    register(command, send, opts = {}) {
      const registration: Registration = { send: send as Sender, idempotent: opts.idempotent ?? true, versionArg: opts.versionArg };
      map.set(command, registration);
      return () => {
        if (map.get(command) === registration) map.delete(command);
      };
    },
    get: (command) => map.get(command),
    clear: () => map.clear(),
  };
}

/** The app-wide registry. Modules register their server-action senders here. */
export const senders = createSenderRegistry();

/**
 * Registers the function that sends one queued command to the server, usually a
 * server action returning `toSendResult(await callCommand(...))`. Re-registering
 * a command replaces the previous sender. Returns an unregister function.
 */
export function registerSender<A extends JsonObject>(command: string, send: Sender<A>, opts?: SenderOptions): () => void {
  return senders.register(command, send, opts);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type FailureKind = "transient" | "conflict" | "failed";

/** What to do with a failed send. Pure; see the module comment for the policy. */
export function classifyFailure(error: SendError, idempotent: boolean): FailureKind {
  if (error.conflict || error.code === "VERSION_CONFLICT") return "conflict";
  if (error.retryable) return "transient";
  if (error.ambiguous && idempotent) return "transient";
  return "failed";
}

/** Engine-level error codes, translated under `offline.codes.*`. */
export const ENGINE_CODES = ["NO_SENDER", "STALE"] as const;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface SyncReport {
  /** Sent and confirmed (includes replays). */
  done: number;
  /** Confirmed as an idempotent replay of an earlier send. */
  replayed: number;
  failed: number;
  conflicts: number;
  /** Newly flagged as older than 7 days. */
  stale: number;
  /** Waiting: an earlier item of the same group is unresolved, or no sender is registered. */
  held: number;
  /** Stopped early on a transient failure; the rest wait for the next run. */
  interrupted: boolean;
  /** Not run: the device is offline. */
  offline: boolean;
  /** Not run: another tab holds the sync lock. */
  busy: boolean;
}

const emptyReport = (): SyncReport => ({
  done: 0,
  replayed: 0,
  failed: 0,
  conflicts: 0,
  stale: 0,
  held: 0,
  interrupted: false,
  offline: false,
  busy: false,
});

export interface SyncEngineDeps {
  queue: Queue;
  registry?: SenderRegistry;
  now?: () => number;
  isOnline?: () => boolean;
  /** Runs `fn` under a cross-tab lock, or returns `null` when another tab holds it. */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T | null>;
  /** Passed to withRetry (tests inject a no-op sleep). */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Sends per item per run (withRetry attempts). */
  attemptsPerRun?: number;
  maxAgeMs?: number;
  /** Called after every queue change (UI refresh, cross-tab broadcast). */
  onChange?: () => void;
}

export interface SyncEngine {
  readonly queue: Queue;
  enqueue(input: EnqueueInput): Promise<QueueItem>;
  /** Enqueues, runs a sync, and returns the item's state afterwards (done → `result` holds the answer). */
  submit(input: EnqueueInput): Promise<QueueItem>;
  list(): Promise<QueueItem[]>;
  /** Runs a sync. Concurrent calls share the running pass and trigger one more pass after it. */
  sync(): Promise<SyncReport>;
  /** Puts a failed / conflict / stale item back in the queue (a stale one is then sent anyway) and syncs. */
  retry(id: string): Promise<SyncReport>;
  /** Conflict only: re-sends the item with the server's current version. False when not possible. */
  keepMine(id: string): Promise<boolean>;
  canKeepMine(item: QueueItem): boolean;
  /** Removes an item for good (the UI confirms first). */
  discard(id: string): Promise<void>;
  isSyncing(): boolean;
  subscribe(listener: () => void): () => void;
}

const nowIso = (now: () => number) => new Date(now()).toISOString();

function toQueueError(error: SendError, now: () => number): QueueError {
  return {
    code: error.code,
    messageKey: error.messageKey,
    at: nowIso(now),
    ...(error.requestId ? { requestId: error.requestId } : {}),
    ...(error.conflict ? { conflict: error.conflict } : {}),
  };
}

function engineError(code: (typeof ENGINE_CODES)[number], messageKey: TranslatedCode, now: () => number): QueueError {
  return { code, messageKey, at: nowIso(now) };
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const { queue } = deps;
  const registry = deps.registry ?? senders;
  const now = deps.now ?? Date.now;
  const isOnline = deps.isOnline ?? (() => true);
  const withLock = deps.withLock ?? (<T>(fn: () => Promise<T>) => fn());
  const maxAgeMs = deps.maxAgeMs ?? MAX_AGE_MS;
  const attempts = deps.attemptsPerRun ?? 3;
  const listeners = new Set<() => void>();
  let running: Promise<SyncReport> | null = null;
  let again = false;

  const changed = () => {
    deps.onChange?.();
    for (const listener of listeners) listener();
  };

  /** One send with in-run retries for safe-to-repeat failures. */
  async function send(item: QueueItem, registration: Registration): Promise<{ ok: true; data: Json | null } | { ok: false; error: SendError }> {
    let lastError: SendError | null = null;
    const result = await withRetry<Json | null>(
      async () => {
        const marked = await queue.markSyncing(item.id);
        changed();
        let outcome: SendResult;
        try {
          outcome = await registration.send(item.args, { id: item.id, createdAt: item.createdAt, attempt: marked?.attempts ?? 1 });
        } catch (cause) {
          // The request may have reached the server: the outcome is ambiguous (audit #15).
          const { code, messageKey } = networkError(cause);
          outcome = { ok: false, error: { code, messageKey, retryable: false, ambiguous: true } };
        }
        if (outcome.ok) return ok(outcome.data ?? null);
        lastError = outcome.error;
        // withRetry re-runs only errors marked retryable: here, exactly the transient ones.
        const transient = classifyFailure(outcome.error, registration.idempotent) === "transient";
        return fail({ code: outcome.error.code, messageKey: outcome.error.messageKey, detail: "", retryable: transient });
      },
      { attempts, sleep: deps.sleep, random: deps.random, baseDelayMs: 500 },
    );
    if (result.ok) return result;
    return { ok: false, error: lastError ?? { code: result.error.code, messageKey: result.error.messageKey, retryable: false } };
  }

  async function runOnce(): Promise<SyncReport> {
    const report = emptyReport();
    if (!isOnline()) return { ...report, offline: true };

    const result = await withLock(async () => {
      if ((await queue.recoverInterrupted()) > 0) changed();
      if ((await queue.pruneDone(DONE_RETENTION_MS)) > 0) changed();

      const blocked = new Set<string>();
      const block = (item: QueueItem) => item.groupKey && blocked.add(item.groupKey);

      for (const item of await queue.list()) {
        if (item.status === "done") continue;
        if (item.status === "failed" || item.status === "conflict") {
          block(item);
          continue;
        }
        if (item.groupKey && blocked.has(item.groupKey)) {
          report.held++;
          continue;
        }
        if (!item.staleAcknowledged && now() - Date.parse(item.createdAt) > maxAgeMs) {
          if (item.flag !== "stale") {
            await queue.markStale(item.id);
            report.stale++;
            changed();
          }
          block(item);
          continue;
        }
        const registration = registry.get(item.command);
        if (!registration) {
          // The module that owns this command is not loaded on this page: keep it for later.
          if (item.lastError?.code !== "NO_SENDER") {
            await queue.markPending(item.id, engineError("NO_SENDER", "UNKNOWN", now));
            changed();
          }
          report.held++;
          block(item);
          continue;
        }
        if (!isOnline()) {
          report.interrupted = true;
          break;
        }

        const outcome = await send(item, registration);
        if (outcome.ok) {
          await queue.markDone(item.id, outcome.data);
          report.done++;
          if (isReplay(outcome.data)) report.replayed++;
          changed();
          continue;
        }

        const error = toQueueError(outcome.error, now);
        const kind = classifyFailure(outcome.error, registration.idempotent);
        if (kind === "transient") {
          await queue.markPending(item.id, error);
          changed();
          report.interrupted = true;
          break;
        }
        if (kind === "conflict") {
          await queue.markConflict(item.id, error);
          report.conflicts++;
        } else {
          await queue.markFailed(item.id, error);
          report.failed++;
        }
        block(item);
        changed();
      }
      return report;
    });
    return result ?? { ...report, busy: true };
  }

  function sync(): Promise<SyncReport> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let report: SyncReport;
      do {
        again = false;
        report = await runOnce();
      } while (again && !report.interrupted && !report.offline && !report.busy);
      return report;
    })().finally(() => {
      running = null;
      changed();
    });
    changed();
    return running;
  }

  function canKeepMine(item: QueueItem): boolean {
    const registration = registry.get(item.command);
    return (
      item.status === "conflict" &&
      Boolean(registration?.versionArg) &&
      typeof item.lastError?.conflict?.currentVersion === "number"
    );
  }

  return {
    queue,
    async enqueue(input) {
      const item = await queue.enqueue(input);
      changed();
      return item;
    },
    async submit(input) {
      const item = await this.enqueue(input);
      await sync();
      return (await queue.get(item.id)) ?? item;
    },
    list: () => queue.list(),
    sync,
    async retry(id) {
      const item = await queue.requeue(id, { acknowledgeStale: true });
      changed();
      if (!item) return emptyReport();
      return sync();
    },
    async keepMine(id) {
      const item = await queue.get(id);
      if (!item || !canKeepMine(item)) return false;
      const versionArg = registry.get(item.command)?.versionArg as string;
      await queue.requeue(id, { argsPatch: { [versionArg]: item.lastError?.conflict?.currentVersion as number } });
      changed();
      await sync();
      return true;
    },
    canKeepMine,
    async discard(id) {
      await queue.remove(id);
      changed();
    },
    isSyncing: () => running !== null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function isReplay(data: Json | null): boolean {
  return typeof data === "object" && data !== null && !Array.isArray(data) && data.replayed === true;
}
