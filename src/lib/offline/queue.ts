import type { Json, JsonObject, QueueError, QueueItem, QueueStore } from "./types";

/**
 * The offline command queue (docs/ARCHITECTURE.md §6), stored in IndexedDB.
 *
 * Shared field devices: each user gets their own database, named after the user
 * id, so one rep never sees (or replays) another rep's commands. Sign-out calls
 * `clearForUser(userId)`, which deletes that database. No new dependency: raw
 * IndexedDB behind a thin promise wrapper. Tests use `createMemoryStore()`.
 */

export const DB_PREFIX = "honest-offline-v1:";
const DB_VERSION = 1;
const STORE = "commands";

const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMAND = /^[a-z][a-z0-9_.-]{1,99}$/i;

export function assertUserId(userId: string): string {
  if (!USER_ID.test(userId)) throw new Error("offline queue: invalid user id");
  return userId;
}

/** IndexedDB database name for one user's queue. */
export function dbNameFor(userId: string): string {
  return DB_PREFIX + assertUserId(userId);
}

export const byQueueOrder = (a: QueueItem, b: QueueItem) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Deep copy that keeps only JSON (drops undefined, rejects cycles and BigInt). */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/** Non-persistent store with the same interface: unit tests, and browsers without IndexedDB. */
export function createMemoryStore(): QueueStore {
  const items = new Map<string, QueueItem>();
  return {
    persistent: false,
    async getAll() {
      return [...items.values()].map(cloneJson).sort(byQueueOrder);
    },
    async get(id) {
      const item = items.get(id);
      return item ? cloneJson(item) : undefined;
    },
    async add(item) {
      const existing = items.get(item.id);
      if (existing) return cloneJson(existing);
      items.set(item.id, cloneJson(item));
      return cloneJson(item);
    },
    async put(item) {
      items.set(item.id, cloneJson(item));
    },
    async delete(id) {
      items.delete(id);
    },
    async clear() {
      items.clear();
    },
    close() {},
  };
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function defaultIdb(): IDBFactory | undefined {
  return typeof indexedDB === "undefined" ? undefined : indexedDB;
}

/** IndexedDB-backed store for one user. The connection opens lazily on first use. */
export function createIdbStore(userId: string, idb: IDBFactory | undefined = defaultIdb()): QueueStore {
  const name = dbNameFor(userId);
  if (!idb) throw new Error("offline queue: IndexedDB is not available");
  const factory = idb;
  let dbPromise: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" }).createIndex("seq", "seq");
      };
      request.onsuccess = () => {
        const db = request.result;
        // clearForUser() (here or in another tab) deletes the database: let it go.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error ?? new Error("IndexedDB open failed"));
      };
    });
    return dbPromise;
  }

  async function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => Promise<T> | T): Promise<T> {
    const db = await open();
    const tx = db.transaction(STORE, mode);
    const done = completed(tx);
    const value = await body(tx.objectStore(STORE));
    await done;
    return value;
  }

  return {
    persistent: true,
    async getAll() {
      const all = await run("readonly", (s) => promisify(s.getAll() as IDBRequest<QueueItem[]>));
      return all.sort(byQueueOrder);
    },
    async get(id) {
      return run("readonly", (s) => promisify(s.get(id) as IDBRequest<QueueItem | undefined>));
    },
    async add(item) {
      // get + put inside one readwrite transaction, so a double tap cannot insert twice.
      return run("readwrite", (s) => {
        return new Promise<QueueItem>((resolve, reject) => {
          const lookup = s.get(item.id) as IDBRequest<QueueItem | undefined>;
          lookup.onerror = () => reject(lookup.error);
          lookup.onsuccess = () => {
            if (lookup.result) return resolve(lookup.result);
            s.put(item);
            resolve(item);
          };
        });
      });
    },
    async put(item) {
      await run("readwrite", (s) => {
        s.put(cloneJson(item));
      });
    },
    async delete(id) {
      await run("readwrite", (s) => {
        s.delete(id);
      });
    },
    async clear() {
      await run("readwrite", (s) => {
        s.clear();
      });
    },
    close() {
      void dbPromise?.then((db) => db.close()).catch(() => undefined);
      dbPromise = null;
    },
  };
}

function deleteDatabase(idb: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = idb.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB delete failed"));
    // onblocked: other connections get `versionchange`, close (see open()), then onsuccess fires.
  });
}

/**
 * Deletes one user's queue from this device. Call it on sign-out, after warning
 * the user about unsynced items (see `countUnsynced`), because those are lost.
 */
export async function clearForUser(userId: string, idb: IDBFactory | undefined = defaultIdb()): Promise<void> {
  const name = dbNameFor(userId);
  if (idb) await deleteDatabase(idb, name);
}

/**
 * Deletes every user's queue on this device (e.g. a "reset device" action).
 * Returns false when the browser cannot list databases (indexedDB.databases()).
 */
export async function clearAllUsers(idb: IDBFactory | undefined = defaultIdb()): Promise<boolean> {
  if (!idb || typeof idb.databases !== "function") return false;
  const dbs = await idb.databases();
  await Promise.all(dbs.filter((d) => d.name?.startsWith(DB_PREFIX)).map((d) => deleteDatabase(idb, d.name as string)));
  return true;
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

export interface EnqueueInput<A extends JsonObject = JsonObject> {
  /** Registered sender id, e.g. "field.visit_check_in". */
  command: string;
  args: A;
  /** Client uuid used as the idempotency key. Generated when omitted. */
  id?: string;
  groupKey?: string | null;
  summary?: string | null;
}

export interface Queue {
  readonly userId: string;
  readonly persistent: boolean;
  /** Adds an item. Enqueuing the same id twice returns the first item (no duplicate). */
  enqueue(input: EnqueueInput): Promise<QueueItem>;
  /** All items in queue order (createdAt order). */
  list(): Promise<QueueItem[]>;
  get(id: string): Promise<QueueItem | undefined>;
  /** Marks an item as being sent and counts the attempt. */
  markSyncing(id: string): Promise<QueueItem | undefined>;
  markDone(id: string, result: Json | null): Promise<QueueItem | undefined>;
  /** Back to pending after a transient failure (it will be retried). */
  markPending(id: string, error?: QueueError | null): Promise<QueueItem | undefined>;
  markFailed(id: string, error: QueueError): Promise<QueueItem | undefined>;
  markConflict(id: string, error: QueueError): Promise<QueueItem | undefined>;
  markStale(id: string): Promise<QueueItem | undefined>;
  /** Puts a failed / conflict / stale item back to pending; optionally patches its args. */
  requeue(id: string, opts?: { acknowledgeStale?: boolean; argsPatch?: JsonObject }): Promise<QueueItem | undefined>;
  /** Items left "syncing" by a killed tab go back to pending (replay is idempotent). */
  recoverInterrupted(): Promise<number>;
  /** Drops done items older than the given age. */
  pruneDone(olderThanMs: number): Promise<number>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

export function createQueue(store: QueueStore, userId: string, now: () => number = Date.now): Queue {
  assertUserId(userId);
  let lastSeq = -1;
  const iso = () => new Date(now()).toISOString();

  async function update(id: string, change: (item: QueueItem) => QueueItem | null): Promise<QueueItem | undefined> {
    const item = await store.get(id);
    if (!item) return undefined;
    const next = change(item);
    if (!next) return item;
    const stored = { ...next, updatedAt: iso() };
    await store.put(stored);
    return stored;
  }

  return {
    userId,
    get persistent() {
      return store.persistent;
    },

    async enqueue(input) {
      if (!COMMAND.test(input.command)) throw new Error("offline queue: invalid command id");
      if (typeof input.args !== "object" || input.args === null || Array.isArray(input.args)) {
        throw new Error("offline queue: args must be a JSON object");
      }
      const id = input.id ?? crypto.randomUUID();
      if (!UUID.test(id)) throw new Error("offline queue: id must be a uuid");

      if (lastSeq < 0) lastSeq = Math.max(-1, ...(await store.getAll()).map((i) => i.seq));
      const at = now();
      const seq = Math.max(at, lastSeq + 1);
      lastSeq = seq;
      const createdAt = new Date(at).toISOString();

      return store.add({
        id,
        userId,
        command: input.command,
        args: cloneJson(input.args),
        groupKey: input.groupKey ?? null,
        summary: input.summary?.trim().slice(0, 200) || null,
        createdAt,
        seq,
        attempts: 0,
        status: "pending",
        lastError: null,
        flag: null,
        staleAcknowledged: false,
        result: null,
        updatedAt: createdAt,
      });
    },

    list: () => store.getAll(),
    get: (id) => store.get(id),

    markSyncing: (id) => update(id, (i) => ({ ...i, status: "syncing", attempts: i.attempts + 1 })),
    markDone: (id, result) => update(id, (i) => ({ ...i, status: "done", lastError: null, result: result ?? null })),
    markPending: (id, error) => update(id, (i) => ({ ...i, status: "pending", lastError: error === undefined ? i.lastError : error })),
    markFailed: (id, error) => update(id, (i) => ({ ...i, status: "failed", lastError: error })),
    markConflict: (id, error) => update(id, (i) => ({ ...i, status: "conflict", lastError: error })),
    markStale: (id) => update(id, (i) => (i.flag === "stale" ? null : { ...i, flag: "stale" })),

    requeue: (id, opts = {}) =>
      update(id, (i) => {
        if (i.status === "done" || i.status === "syncing") return null;
        return {
          ...i,
          status: "pending",
          staleAcknowledged: i.staleAcknowledged || Boolean(opts.acknowledgeStale),
          args: opts.argsPatch ? { ...i.args, ...cloneJson(opts.argsPatch) } : i.args,
        };
      }),

    async recoverInterrupted() {
      const stuck = (await store.getAll()).filter((i) => i.status === "syncing");
      for (const item of stuck) await store.put({ ...item, status: "pending", updatedAt: iso() });
      return stuck.length;
    },

    async pruneDone(olderThanMs) {
      const cutoff = now() - olderThanMs;
      const old = (await store.getAll()).filter((i) => i.status === "done" && Date.parse(i.updatedAt) < cutoff);
      for (const item of old) await store.delete(item.id);
      return old.length;
    },

    remove: (id) => store.delete(id),
    clear: () => store.clear(),
  };
}

