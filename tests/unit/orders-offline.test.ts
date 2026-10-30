import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError, Result } from "@/lib/errors";

// The draft server action runs in-process against a fake api.save_order_draft
// with the replay rule of migration 20261103000300: (order id, base version)
// + the same request = a replay. Synthetic data only (D-03).
const db = vi.hoisted(() => ({ handle: null as null | ((name: string, args: Record<string, unknown>) => Promise<unknown>) }));
vi.mock("@/lib/command", () => ({ callCommand: (name: string, args: Record<string, unknown>) => db.handle!(name, args) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));

import { createMemoryStore, createQueue, type Queue } from "@/lib/offline/queue";
import { createSenderRegistry, createSyncEngine, type SenderRegistry, type SyncEngine } from "@/lib/offline/sync";
import type { Json, QueueItem, SendResult } from "@/lib/offline/types";
import { saveDraftOnDevice } from "@/modules/orders/actions";
import {
  clearOrdersDevice,
  clearOtherUsersOrders,
  loadCatalog,
  loadDraft,
  loadDrafts,
  ordersStorageKeys,
  parseCatalog,
  parseLocalDraft,
  removeLocalDraft,
  saveCatalog,
  saveLocalDraft,
  type KeyValueStorage,
} from "@/modules/orders/device-store";
import { registerOrderSenders } from "@/modules/orders/offline";
import {
  asDraftSaveAnswer,
  buildDraftPayload,
  canSaveDraft,
  chooseBuilderStart,
  draftGroupKey,
  draftItems,
  draftQueueId,
  draftQueueState,
  indicativeTotals,
  isSnapshotFresh,
  NEW_SLOT,
  nextBaseVersion,
  ORDER_QUEUED_COMMANDS,
  priceMap,
  searchCatalog,
  submitOrderDraft,
  syncedVersion,
  toDraftSendResult,
  type BuilderSeed,
  type CatalogSnapshot,
  type DraftPayload,
  type DraftQueue,
  type LocalDraft,
} from "@/modules/orders/offline-logic";
import { draftPayloadSchema } from "@/modules/orders/schemas";

const USER_A = "00000000-0000-4000-8000-00000000a0a1";
const USER_B = "00000000-0000-4000-8000-00000000a0b2";
const ORDER = "00000000-0000-4000-8000-00000000a111";
const CUSTOMER = "00000000-0000-4000-8000-00000000a222";
const VARIANT_1 = "00000000-0000-4000-8000-00000000a331";
const VARIANT_2 = "00000000-0000-4000-8000-00000000a332";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAVE = ORDER_QUEUED_COMMANDS.saveDraft;
const T0 = Date.parse("2026-11-03T09:00:00.000Z");

/** Any key that would carry money; none may ever leave the device. */
const MONEY_KEY = /price|discount|tax|total|amount|cost|subtotal/i;
function moneyKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => moneyKeys(v, `${path}[${i}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [...(MONEY_KEY.test(k) ? [`${path}.${k}`] : []), ...moneyKeys(v, `${path}.${k}`)]);
}

const failure = (code: string, over: Partial<AppError> = {}): Result<never> => ({
  ok: false,
  error: { code, messageKey: "UNKNOWN", detail: "", retryable: false, ...over } as AppError,
});

/**
 * Fake database: drafts by id with a version; applied saves recorded under
 * (order id, base version) with a fingerprint, like sales.order_draft_saves.
 * `failNext`: "lost" applies then loses the answer, "rolledBack" fails without
 * applying, or a business error.
 */
function fakeDb() {
  const orders = new Map<string, { version: number; lines: unknown; notes: unknown; customer: unknown }>();
  const saves = new Map<string, string>();
  const calls: Record<string, unknown>[] = [];
  let inject: null | "lost" | "rolledBack" | { code: string; messageKey?: AppError["messageKey"]; detail?: string } = null;

  function apply(args: Record<string, unknown>): Result<unknown> {
    const id = String(args.p_order_id);
    const base = typeof args.p_version === "number" ? args.p_version : 0;
    const fp = JSON.stringify([args.p_customer_id, args.p_lines, args.p_notes, args.p_visit_id]);
    const order = orders.get(id);
    const answer = (created: boolean, replayed: boolean) => ({
      order_id: id,
      version: orders.get(id)!.version,
      status: "draft",
      created,
      replayed,
      // The real command answers server prices too; the device must not keep them.
      subtotal: 1000,
      indicative_total: 1140,
      lines: [{ line_no: 1, variant_id: VARIANT_1, quantity: 1, list_price: 1000, line_total: 1140 }],
    });
    if (order && saves.get(`${id}:${base}`) === fp) return { ok: true, data: answer(false, true) };
    if (!order) {
      orders.set(id, { version: 1, lines: args.p_lines, notes: args.p_notes, customer: args.p_customer_id });
      saves.set(`${id}:0`, fp);
      return { ok: true, data: answer(true, false) };
    }
    const expected = args.p_version === null ? 1 : base;
    if (expected !== order.version) {
      return failure("CONFLICT", { messageKey: "CONFLICT", detail: `P0001 | CONFLICT: order changed (current version ${order.version})` });
    }
    if (args.p_version !== null) order.version++;
    Object.assign(order, { lines: args.p_lines, notes: args.p_notes, customer: args.p_customer_id });
    saves.set(`${id}:${base}`, fp);
    return { ok: true, data: answer(false, false) };
  }

  return {
    orders,
    calls,
    failNext(kind: typeof inject) {
      inject = kind;
    },
    /** Someone else saved the draft online (version moves on). */
    bump(id: string) {
      orders.get(id)!.version++;
    },
    async handle(name: string, args: Record<string, unknown>) {
      expect(name).toBe("save_order_draft");
      calls.push(args);
      const fault = inject;
      inject = null;
      if (fault === "rolledBack") return failure("UNAVAILABLE", { messageKey: "UNAVAILABLE", retryable: true });
      if (fault && typeof fault === "object") return failure(fault.code, { messageKey: fault.messageKey ?? "UNKNOWN", detail: fault.detail ?? "" });
      const result = apply(args);
      if (fault === "lost") throw new TypeError("Failed to fetch"); // committed, answer lost
      return result;
    },
  };
}

interface Device {
  queue: Queue;
  engine: SyncEngine;
  registry: SenderRegistry;
}

let t = T0;
const now = () => t;

function device(userId: string): Device {
  const queue = createQueue(createMemoryStore(), userId, now);
  const registry = createSenderRegistry();
  registerOrderSenders(registry.register);
  const engine = createSyncEngine({ queue, registry, now, sleep: async () => undefined, random: () => 0 });
  return { queue, engine, registry };
}

let server: ReturnType<typeof fakeDb>;
beforeEach(() => {
  t = T0;
  server = fakeDb();
  db.handle = server.handle;
});

const payload = (over: Partial<Parameters<typeof buildDraftPayload>[0]> = {}): DraftPayload =>
  buildDraftPayload({
    orderId: ORDER,
    customerId: CUSTOMER,
    lines: [{ variant_id: VARIANT_1, quantity: 2 }],
    notes: "",
    visitId: null,
    baseVersion: 0,
    ...over,
  });

/** submitOrderDraft through the real server action, with the device's queue. */
const submit = (p: DraftPayload, d: Device | null, online: boolean, send: (p: DraftPayload) => Promise<SendResult> = saveDraftOnDevice) =>
  submitOrderDraft(p, { online, queue: d?.engine ?? null, send, summary: "Synthetic Clinic · 1 line" });

// ---------------------------------------------------------------------------
// Payload: ids, quantities and text only
// ---------------------------------------------------------------------------
describe("draft payload", () => {
  it("copies only the allowed keys, whatever the builder lines carry", () => {
    const lines = [{ variant_id: VARIANT_1, quantity: 2, sku: "SYN-1", name: "Synthetic", list_price: 999, line_total: 5 }];
    const p = buildDraftPayload({ orderId: ORDER, customerId: CUSTOMER, lines, notes: "  call first  ", visitId: null, baseVersion: 3 });
    expect(p).toEqual({
      order_id: ORDER,
      customer_id: CUSTOMER,
      lines: [{ variant_id: VARIANT_1, quantity: 2 }],
      notes: "call first",
      visit_id: null,
      version: 3,
    });
    expect(Object.keys(p.lines[0]!)).toEqual(["variant_id", "quantity"]);
  });

  it("a new draft is the creating call (version null); blank notes are null", () => {
    expect(payload()).toMatchObject({ version: null, notes: null });
  });

  it("never contains a price, discount, tax or total — built, queued, or sent to the database", async () => {
    const p = buildDraftPayload({
      orderId: ORDER,
      customerId: CUSTOMER,
      lines: [{ variant_id: VARIANT_1, quantity: 1, list_price: 1, requested_discount_pct: 50 } as never],
      notes: "",
      visitId: null,
      baseVersion: 0,
    });
    expect(moneyKeys(p)).toEqual([]);

    const d = device(USER_A);
    const queued = await submit(p, d, false);
    expect(queued.kind).toBe("queued");
    expect(moneyKeys((await d.queue.list())[0]!.args)).toEqual([]);

    await d.engine.sync();
    expect(server.calls).toHaveLength(1);
    expect(moneyKeys(server.calls[0])).toEqual([]);
    expect(server.calls[0]).toEqual({
      p_order_id: ORDER,
      p_customer_id: CUSTOMER,
      p_lines: [{ variant_id: VARIANT_1, quantity: 1 }],
      p_notes: null,
      p_visit_id: null,
      p_version: null,
    });
    // The stored server answer keeps no prices either.
    expect(moneyKeys((await d.queue.list())[0]!.result)).toEqual([]);
  });

  it("the server action re-validates strictly: a payload with a price is refused before the database", async () => {
    const forged = { ...payload(), lines: [{ variant_id: VARIANT_1, quantity: 1, list_price: 1 }] } as unknown as DraftPayload;
    const res = await saveDraftOnDevice(forged);
    expect(res).toEqual({ ok: false, error: { code: "VALIDATION", messageKey: "VALIDATION", retryable: false } });
    const extra = { ...payload(), total: 10 } as unknown as DraftPayload;
    expect((await saveDraftOnDevice(extra)).ok).toBe(false);
    expect(server.calls).toHaveLength(0);
    expect(draftPayloadSchema.safeParse(payload()).success).toBe(true);
  });

  it("canSaveDraft needs a customer and whole quantities in range", () => {
    expect(canSaveDraft("", [{ quantity: 1 }])).toBe(false);
    expect(canSaveDraft(CUSTOMER, [])).toBe(false);
    expect(canSaveDraft(CUSTOMER, [{ quantity: 0 }])).toBe(false);
    expect(canSaveDraft(CUSTOMER, [{ quantity: 1.5 }])).toBe(false);
    expect(canSaveDraft(CUSTOMER, [{ quantity: 3 }])).toBe(true);
  });

  it("queue ids are the command's idempotency key: (order id, base version)", () => {
    expect(draftQueueId(ORDER, 0)).toMatch(UUID);
    expect(draftQueueId(ORDER, 0)).toBe(draftQueueId(ORDER, 0));
    expect(draftQueueId(ORDER, 1)).not.toBe(draftQueueId(ORDER, 0));
    expect(draftGroupKey(ORDER)).toBe(`order:${ORDER}`);
  });
});

// ---------------------------------------------------------------------------
// Send now or queue
// ---------------------------------------------------------------------------
describe("submitOrderDraft", () => {
  it("offline → enqueued, nothing sent", async () => {
    const d = device(USER_A);
    const send = vi.fn(saveDraftOnDevice);
    const r = await submit(payload(), d, false, send);
    expect(r).toMatchObject({ kind: "queued", reason: "offline" });
    expect(send).not.toHaveBeenCalled();
    const [item] = await d.queue.list();
    expect(item).toMatchObject({ id: draftQueueId(ORDER, 0), command: SAVE, groupKey: draftGroupKey(ORDER), status: "pending" });
    expect(item!.summary).toBe("Synthetic Clinic · 1 line");
  });

  it("online → sent directly, nothing queued; the answer has no prices", async () => {
    const d = device(USER_A);
    const r = await submit(payload(), d, true);
    expect(r).toEqual({ kind: "sent", data: { order_id: ORDER, version: 1, status: "draft", created: true, replayed: false } });
    expect(await d.queue.list()).toEqual([]);
    expect(server.orders.size).toBe(1);
  });

  it("online with a lost answer → queued (network) and the replay creates no second draft", async () => {
    const d = device(USER_A);
    server.failNext("lost");
    const r = await submit(payload(), d, true);
    expect(r).toMatchObject({ kind: "queued", reason: "network" });
    const report = await d.engine.sync();
    expect(report).toMatchObject({ done: 1, replayed: 1 });
    expect(server.orders.size).toBe(1);
    expect((await d.queue.list())[0]).toMatchObject({ status: "done", result: { replayed: true, version: 1 } });
  });

  it("online with a rolled-back attempt → queued, then applied once", async () => {
    const d = device(USER_A);
    server.failNext("rolledBack");
    expect(await submit(payload(), d, true)).toMatchObject({ kind: "queued", reason: "network" });
    await d.engine.sync();
    expect(server.orders.get(ORDER)?.version).toBe(1);
  });

  it("a business error is shown, never queued", async () => {
    const d = device(USER_A);
    server.failNext({ code: "CUSTOMER_BLOCKED" });
    const r = await submit(payload(), d, true);
    expect(r).toEqual({ kind: "error", code: "CUSTOMER_BLOCKED", conflict: false });
    expect(await d.queue.list()).toEqual([]);
  });

  it("a discontinued variant keeps its own code across the action boundary", async () => {
    const d = device(USER_A);
    server.failNext({ code: "NOT_FOUND", messageKey: "NOT_FOUND", detail: "P0002 | NOT_FOUND: variant x is not sellable" });
    expect(await submit(payload(), d, true)).toMatchObject({ kind: "error", code: "VARIANT_NOT_SELLABLE" });
    expect(await d.queue.list()).toEqual([]);
  });

  it("a version conflict online is shown as a conflict, never queued", async () => {
    const d = device(USER_A);
    await submit(payload(), d, true);
    server.bump(ORDER); // someone else saved: version 2
    const r = await submit(payload({ baseVersion: 1, lines: [{ variant_id: VARIANT_1, quantity: 5 }] }), d, true);
    expect(r).toMatchObject({ kind: "error", code: "CONFLICT", conflict: true });
    expect(await d.queue.list()).toEqual([]);
  });

  it("a second save of a draft whose first save still waits is queued behind it (order)", async () => {
    const d = device(USER_A);
    await submit(payload(), d, false);
    const items = await d.queue.list();
    const base = nextBaseVersion(draftItems(items, ORDER), 0);
    expect(base).toBe(1);
    const send = vi.fn(saveDraftOnDevice);
    const r = await submit(payload({ baseVersion: base, lines: [{ variant_id: VARIANT_2, quantity: 4 }] }), d, true, send);
    expect(r).toMatchObject({ kind: "queued", reason: "ordered" });
    expect(send).not.toHaveBeenCalled();

    const report = await d.engine.sync();
    expect(report.done).toBe(2);
    expect(server.orders.size).toBe(1);
    expect(server.orders.get(ORDER)).toMatchObject({ version: 2, lines: [{ variant_id: VARIANT_2, quantity: 4 }] });
  });

  it("the same save tapped twice is one queue item; once synced it answers the stored result", async () => {
    const d = device(USER_A);
    await submit(payload(), d, false);
    expect(await submit(payload(), d, false)).toMatchObject({ kind: "queued", reason: "already_saved" });
    expect(await d.queue.list()).toHaveLength(1);
    await d.engine.sync();
    expect(await submit(payload(), d, true)).toMatchObject({ kind: "sent", data: { order_id: ORDER, version: 1 } });
    expect(server.calls).toHaveLength(1);
  });

  it("no usable queue: direct only; a failure that would be queued is reported as unavailable", async () => {
    server.failNext("lost");
    expect(await submit(payload(), null, true)).toEqual({ kind: "error", code: "UNAVAILABLE", conflict: false });
    const broken: DraftQueue = { list: async () => Promise.reject(new Error("idb")), enqueue: async () => Promise.reject(new Error("idb")) };
    expect(await submitOrderDraft(payload(), { online: false, queue: broken, send: saveDraftOnDevice })).toMatchObject({ kind: "sent" });
  });
});

// ---------------------------------------------------------------------------
// The queue sender (sync engine)
// ---------------------------------------------------------------------------
describe("queued draft saves", () => {
  it("are registered idempotent, with the version arg for 'keep mine'", () => {
    const registry = createSenderRegistry();
    registerOrderSenders(registry.register);
    expect(registry.get(SAVE)).toMatchObject({ idempotent: true, versionArg: "version" });
  });

  it("replay → no duplicate draft: a lost answer during sync is re-sent and answered as a replay", async () => {
    const d = device(USER_A);
    await submit(payload(), d, false);
    server.failNext("lost");
    const report = await d.engine.sync();
    expect(report).toMatchObject({ done: 1, replayed: 1, failed: 0 });
    expect(server.calls).toHaveLength(2);
    expect(server.orders.size).toBe(1);
    expect(server.orders.get(ORDER)?.version).toBe(1);
  });

  it("replaying an applied edit does not bump the version again", async () => {
    const d = device(USER_A);
    await submit(payload(), d, true);
    await submit(payload({ baseVersion: 1, lines: [{ variant_id: VARIANT_1, quantity: 7 }] }), d, false);
    server.failNext("lost");
    await d.engine.sync();
    expect(server.orders.get(ORDER)?.version).toBe(2);
    const [item] = await d.queue.list();
    expect(item).toMatchObject({ status: "done", result: { version: 2, replayed: true } });
  });

  it("a business error during sync fails the item; it is not retried", async () => {
    const d = device(USER_A);
    await submit(payload(), d, false);
    server.failNext({ code: "CUSTOMER_BLOCKED" });
    const report = await d.engine.sync();
    expect(report.failed).toBe(1);
    expect(server.calls).toHaveLength(1);
    expect((await d.queue.list())[0]).toMatchObject({ status: "failed", lastError: { code: "CUSTOMER_BLOCKED" } });
  });

  it("the server's version moved → conflict state with the current version; 'keep mine' re-sends on it", async () => {
    const d = device(USER_A);
    await submit(payload(), d, true);
    await submit(payload({ baseVersion: 1, lines: [{ variant_id: VARIANT_1, quantity: 9 }] }), d, false);
    server.bump(ORDER); // someone else saved online meanwhile: version 2
    const report = await d.engine.sync();
    expect(report.conflicts).toBe(1);
    const [item] = await d.queue.list();
    expect(item).toMatchObject({ status: "conflict", lastError: { code: "CONFLICT", conflict: { currentVersion: 2 } } });
    expect(draftQueueState([item!])).toBe("attention");

    expect(d.engine.canKeepMine(item!)).toBe(true);
    expect(await d.engine.keepMine(item!.id)).toBe(true);
    expect(server.orders.get(ORDER)).toMatchObject({ version: 3, lines: [{ variant_id: VARIANT_1, quantity: 9 }] });
  });
});

// ---------------------------------------------------------------------------
// Queue state of one draft
// ---------------------------------------------------------------------------
const item = (over: Partial<QueueItem> & { version?: number | null; result?: Json | null }): QueueItem => ({
  id: draftQueueId(ORDER, over.version ?? 0),
  userId: USER_A,
  command: SAVE,
  args: { ...payload({ baseVersion: over.version ?? 0 }) } as unknown as QueueItem["args"],
  groupKey: draftGroupKey(ORDER),
  summary: null,
  createdAt: new Date(T0).toISOString(),
  seq: T0,
  attempts: 0,
  status: "pending",
  lastError: null,
  flag: null,
  staleAcknowledged: false,
  result: null,
  updatedAt: new Date(T0).toISOString(),
  ...over,
});

describe("draft queue state", () => {
  it("next base version: server version, then each waiting save's result; failed and conflicting saves don't count", () => {
    expect(nextBaseVersion([], 0)).toBe(0);
    expect(nextBaseVersion([], 4)).toBe(4);
    expect(nextBaseVersion([item({ version: null })], 0)).toBe(1);
    expect(nextBaseVersion([item({ version: 1 }), item({ version: 2, status: "syncing" })], 1)).toBe(3);
    expect(nextBaseVersion([item({ version: 2, status: "done", result: { order_id: ORDER, version: 3 } })], 1)).toBe(3);
    expect(nextBaseVersion([item({ version: 2, status: "failed" }), item({ version: 3, status: "conflict" })], 2)).toBe(2);
    expect(syncedVersion([item({ status: "done", result: { order_id: ORDER, version: 5 } }), item({ status: "done", result: null })])).toBe(5);
  });

  it("draftItems picks this order's saves only", () => {
    const other = item({ args: { ...payload({ orderId: CUSTOMER }) } as unknown as QueueItem["args"] });
    const foreign = item({ command: "field.visit_check_in" });
    expect(draftItems([item({}), other, foreign], ORDER)).toHaveLength(1);
    expect(draftItems(null, ORDER)).toEqual([]);
    expect(draftItems([item({})], null)).toEqual([]);
  });

  it("summarises waiting, synced and needs-attention", () => {
    expect(draftQueueState([])).toBe("none");
    expect(draftQueueState([item({})])).toBe("waiting");
    expect(draftQueueState([item({ status: "done" })])).toBe("synced");
    expect(draftQueueState([item({ status: "done" }), item({ status: "failed" })])).toBe("attention");
    expect(draftQueueState([item({ flag: "stale" })])).toBe("attention");
  });

  it("asDraftSaveAnswer accepts only the answer's shape", () => {
    expect(asDraftSaveAnswer({ order_id: ORDER, version: 2, replayed: true })).toEqual({
      order_id: ORDER,
      version: 2,
      status: "draft",
      created: false,
      replayed: true,
    });
    expect(asDraftSaveAnswer(null)).toBeNull();
    expect(asDraftSaveAnswer({ order_id: ORDER })).toBeNull();
  });

  it("toDraftSendResult keeps the version-conflict payload and drops server prices", () => {
    const conflict = toDraftSendResult(failure("CONFLICT", { messageKey: "CONFLICT", detail: "P0001 | CONFLICT: order changed (current version 4)" }));
    expect(conflict).toMatchObject({ ok: false, error: { code: "CONFLICT", conflict: { currentVersion: 4 } } });
    const ok = toDraftSendResult({ ok: true, data: { order_id: ORDER, version: 1, created: true, subtotal: 5, lines: [] } });
    expect(ok).toEqual({ ok: true, data: { order_id: ORDER, version: 1, status: "draft", created: true, replayed: false } });
  });
});

// ---------------------------------------------------------------------------
// Builder copy and catalogue on the device; per-user isolation
// ---------------------------------------------------------------------------
function memoryStorage(): KeyValueStorage & { keys(): string[] } {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    keys: () => [...map.keys()],
  };
}

const local = (over: Partial<LocalDraft> = {}): LocalDraft => ({
  slot: NEW_SLOT,
  orderId: null,
  serverVersion: 0,
  customerId: CUSTOMER,
  visitId: null,
  notes: "",
  lines: [{ variant_id: VARIANT_1, quantity: 2, sku: "SYN-1", name: "Synthetic implant" }],
  dirty: true,
  updatedAt: new Date(T0).toISOString(),
  ...over,
});

const snapshot = (over: Partial<CatalogSnapshot> = {}): CatalogSnapshot => ({
  at: new Date(T0).toISOString(),
  truncated: false,
  variants: [
    { variant_id: VARIANT_1, sku: "SYN-IMP-35", variant_name: "Synthetic implant 3.5", uom: "pc", product_code: "SYN-IMP", product_name_en: "Synthetic implant", product_name_ar: "زرعة تجريبية", brand_name: "Demo", price: 1000 },
    { variant_id: VARIANT_2, sku: "SYN-BUR-01", variant_name: "Synthetic bur", uom: "pc", product_code: "SYN-BUR", product_name_en: "Synthetic bur", product_name_ar: null, brand_name: null, price: null },
  ],
  ...over,
});

describe("device store (per user)", () => {
  it("keeps builder copies per user: user B never sees user A's lines", () => {
    const storage = memoryStorage();
    saveLocalDraft(USER_A, local(), storage);
    expect(loadDraft(USER_A, NEW_SLOT, storage)?.lines).toHaveLength(1);
    expect(loadDraft(USER_B, NEW_SLOT, storage)).toBeNull();
    expect(Object.keys(loadDrafts(USER_B, storage))).toEqual([]);
  });

  it("sign-out clears this user's copies and catalogue; start clears every other user's", () => {
    const storage = memoryStorage();
    saveLocalDraft(USER_A, local(), storage);
    saveCatalog(USER_A, snapshot(), storage);
    saveLocalDraft(USER_B, local(), storage);
    saveCatalog(USER_B, snapshot(), storage);
    storage.setItem("honest.tracking.v1:" + USER_A, "{}"); // another module's key is left alone

    expect(clearOtherUsersOrders(USER_B, storage)).toBe(2);
    expect(loadDraft(USER_A, NEW_SLOT, storage)).toBeNull();
    expect(loadCatalog(USER_A, storage)).toBeNull();
    expect(loadCatalog(USER_B, storage)?.variants).toHaveLength(2);

    clearOrdersDevice(USER_B, storage);
    expect(storage.keys()).toEqual(["honest.tracking.v1:" + USER_A]);
  });

  it("the offline queue is per user too: one user's saved draft is not in another's queue", async () => {
    const store = createMemoryStore();
    const a = createQueue(store, USER_A, now);
    await a.enqueue({ command: SAVE, id: draftQueueId(ORDER, 0), args: payload() as never });
    const b = device(USER_B);
    expect(await b.queue.list()).toEqual([]);
    expect(nextBaseVersion(draftItems(await b.queue.list(), ORDER), 0)).toBe(0);
  });

  it("rejects user ids that could address another key", () => {
    expect(() => ordersStorageKeys("a:b")).toThrow();
    expect(() => ordersStorageKeys("")).toThrow();
    expect(ordersStorageKeys(USER_A)).toEqual({ drafts: `honest.orders.v1:${USER_A}`, catalog: `honest.orders.v1:${USER_A}:catalog` });
  });

  it("restores only ids, quantities and text from a stored copy", () => {
    const parsed = parseLocalDraft({
      ...local(),
      lines: [
        { variant_id: VARIANT_1, quantity: 2, sku: "SYN-1", name: "x", list_price: 1, line_total: 2 },
        { variant_id: "not-an-id", quantity: 1 },
        { variant_id: VARIANT_2, quantity: 1.5 },
      ],
    });
    expect(parsed?.lines).toEqual([{ variant_id: VARIANT_1, quantity: 2, sku: "SYN-1", name: "x" }]);
    expect(parseLocalDraft({ slot: "new", orderId: "bad" })).toBeNull();
    expect(parseLocalDraft("junk")).toBeNull();
  });

  it("keeps at most 20 copies (oldest dropped) and removes one on request", () => {
    const storage = memoryStorage();
    for (let i = 0; i < 25; i++) {
      saveLocalDraft(USER_A, local({ slot: `slot-${i}`, updatedAt: new Date(T0 + i * 1000).toISOString() }), storage);
    }
    const all = loadDrafts(USER_A, storage);
    expect(Object.keys(all)).toHaveLength(20);
    expect(all["slot-0"]).toBeUndefined();
    removeLocalDraft(USER_A, "slot-24", storage);
    expect(loadDraft(USER_A, "slot-24", storage)).toBeNull();
  });

  it("parses a stored catalogue tolerantly", () => {
    expect(parseCatalog(null)).toBeNull();
    expect(parseCatalog({ at: "not a date", variants: [] })).toBeNull();
    const parsed = parseCatalog({ ...snapshot(), variants: [...snapshot().variants, { variant_id: "x" }, { ...snapshot().variants[0], price: -1 }] });
    expect(parsed?.variants).toHaveLength(3);
    expect(parsed?.variants[2]?.price).toBeNull();
  });

  it("storage that throws (private mode, quota) never breaks the builder", () => {
    const broken: KeyValueStorage = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(saveLocalDraft(USER_A, local(), broken)).toBe(false);
    expect(loadDraft(USER_A, NEW_SLOT, broken)).toBeNull();
    expect(saveCatalog(USER_A, snapshot(), broken)).toBe(false);
    expect(() => clearOrdersDevice(USER_A, broken)).not.toThrow();
    expect(loadDraft(USER_A, NEW_SLOT, null)).toBeNull();
  });
});

describe("builder start", () => {
  const server: BuilderSeed = { orderId: ORDER, serverVersion: 3, customerId: CUSTOMER, visitId: null, notes: "", lines: [] };
  const fresh: BuilderSeed = { orderId: null, serverVersion: 0, customerId: "", visitId: null, notes: "", lines: [] };

  it("no copy → the server's draft", () => {
    expect(chooseBuilderStart(ORDER, null, server, 0)).toEqual({ seed: server, notice: "none", dropLocal: false });
  });

  it("a new order with unsaved lines is restored", () => {
    const r = chooseBuilderStart(NEW_SLOT, local(), fresh, 0);
    expect(r.notice).toBe("restored");
    expect(r.seed.lines).toHaveLength(1);
  });

  it("a copy whose saves all reached the server is dropped", () => {
    const r = chooseBuilderStart(NEW_SLOT, local({ orderId: ORDER, serverVersion: 1, dirty: false }), fresh, 0);
    expect(r).toMatchObject({ seed: fresh, dropLocal: true });
  });

  it("an edit copy with saves still queued is restored on its own base version", () => {
    const r = chooseBuilderStart(ORDER, local({ slot: ORDER, orderId: ORDER, serverVersion: 3, dirty: false }), server, 1);
    expect(r).toMatchObject({ notice: "restored", dropLocal: false, seed: { orderId: ORDER, serverVersion: 3 } });
  });

  it("the server moved past an edit copy with unsaved changes → the server's draft, and the user is told", () => {
    const r = chooseBuilderStart(ORDER, local({ slot: ORDER, orderId: ORDER, serverVersion: 2, dirty: true }), server, 0);
    expect(r).toEqual({ seed: server, notice: "replaced", dropLocal: true });
  });
});

describe("catalogue snapshot", () => {
  it("is fresh for 30 minutes", () => {
    expect(isSnapshotFresh(null, T0)).toBe(false);
    expect(isSnapshotFresh(snapshot(), T0 + 29 * 60_000)).toBe(true);
    expect(isSnapshotFresh(snapshot(), T0 + 31 * 60_000)).toBe(false);
    expect(isSnapshotFresh({ at: "garbage" }, T0)).toBe(false);
  });

  it("offline search matches SKU, names (Arabic too) and brand; every word must match", () => {
    expect(searchCatalog(snapshot(), "imp").map((v) => v.variant_id)).toEqual([VARIANT_1]);
    expect(searchCatalog(snapshot(), "زرعة").map((v) => v.variant_id)).toEqual([VARIANT_1]);
    expect(searchCatalog(snapshot(), "synthetic bur").map((v) => v.variant_id)).toEqual([VARIANT_2]);
    expect(searchCatalog(snapshot(), "s")).toEqual([]);
    expect(searchCatalog(null, "synthetic")).toEqual([]);
    expect(searchCatalog(snapshot(), "synthetic", 1)).toHaveLength(1);
  });

  it("indicative totals use cached list prices and count lines without one", () => {
    const prices = priceMap(snapshot());
    expect(prices.get(VARIANT_1)).toBe(1000);
    expect(prices.has(VARIANT_2)).toBe(false);
    expect(indicativeTotals([{ variant_id: VARIANT_1, quantity: 3 }, { variant_id: VARIANT_2, quantity: 1 }], prices)).toEqual({ total: 3000, missing: 1 });
  });
});
