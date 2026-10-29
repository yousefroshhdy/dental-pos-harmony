/**
 * A minimal in-memory IndexedDB for unit tests (no new dependency): just what
 * src/lib/offline/queue.ts uses — open/upgrade, one object store with a keyPath,
 * get/getAll/put/delete/clear in transactions, deleteDatabase, databases(), and
 * versionchange on open connections. Requests complete asynchronously and a
 * transaction completes once no request is outstanding, as in browsers.
 */

type Row = Record<string, unknown>;

interface FakeRequest<T = unknown> {
  result: T;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
  onblocked?: (() => void) | null;
}

function request<T>(): FakeRequest<T> {
  return { result: undefined as T, error: null, onsuccess: null, onerror: null };
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  private pending = 0;

  constructor(private readonly rows: Map<string, Row>, private readonly keyPath: string) {
    this.scheduleComplete();
  }

  private scheduleComplete() {
    setTimeout(() => {
      if (this.pending === 0) this.oncomplete?.();
    }, 0);
  }

  private op<T>(fn: () => T): FakeRequest<T> {
    const req = request<T>();
    this.pending++;
    queueMicrotask(() => {
      req.result = fn();
      req.onsuccess?.();
      this.pending--;
      if (this.pending === 0) this.scheduleComplete();
    });
    return req;
  }

  objectStore() {
    const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
    return {
      get: (id: string) => this.op(() => clone(this.rows.get(id))),
      getAll: () => this.op(() => [...this.rows.values()].map(clone)),
      put: (row: Row) => this.op(() => void this.rows.set(String(row[this.keyPath]), clone(row))),
      delete: (id: string) => this.op(() => void this.rows.delete(id)),
      clear: () => this.op(() => this.rows.clear()),
      index: () => ({ getAll: () => this.op(() => [...this.rows.values()].map(clone)) }),
    };
  }
}

interface FakeDb {
  rows: Map<string, Row>;
  keyPath: string | null;
  storeNames: Set<string>;
  connections: Set<FakeConnection>;
}

class FakeConnection {
  onversionchange: (() => void) | null = null;
  closed = false;
  constructor(private readonly db: FakeDb) {}
  get objectStoreNames() {
    return { contains: (n: string) => this.db.storeNames.has(n) };
  }
  createObjectStore(name: string, opts: { keyPath: string }) {
    this.db.storeNames.add(name);
    this.db.keyPath = opts.keyPath;
    return { createIndex: () => undefined };
  }
  transaction() {
    if (this.closed) throw new Error("InvalidStateError: connection is closed");
    return new FakeTransaction(this.db.rows, this.db.keyPath ?? "id");
  }
  close() {
    this.closed = true;
    this.db.connections.delete(this);
  }
}

export function createFakeIdb() {
  const dbs = new Map<string, FakeDb>();
  const factory = {
    open(name: string) {
      const req = request<FakeConnection>();
      queueMicrotask(() => {
        let db = dbs.get(name);
        const isNew = !db;
        if (!db) {
          db = { rows: new Map(), keyPath: null, storeNames: new Set(), connections: new Set() };
          dbs.set(name, db);
        }
        const conn = new FakeConnection(db);
        db.connections.add(conn);
        req.result = conn;
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
    deleteDatabase(name: string) {
      const req = request<undefined>();
      queueMicrotask(() => {
        const db = dbs.get(name);
        for (const conn of db ? [...db.connections] : []) conn.onversionchange?.();
        dbs.delete(name);
        req.onsuccess?.();
      });
      return req;
    },
    async databases() {
      return [...dbs.keys()].map((name) => ({ name, version: 1 }));
    },
  };
  return { factory: factory as unknown as IDBFactory, names: () => [...dbs.keys()] };
}
