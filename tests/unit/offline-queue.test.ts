import { describe, expect, it } from "vitest";
import {
  DB_PREFIX,
  clearAllUsers,
  clearForUser,
  createIdbStore,
  createMemoryStore,
  createQueue,
  dbNameFor,
} from "@/lib/offline/queue";
import type { QueueStore } from "@/lib/offline/types";
import { createFakeIdb } from "./offline-fake-idb";

// Synthetic ids only (no real personal data, D-03).
const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";
const ID_1 = "11111111-1111-4111-8111-111111111111";
const ID_2 = "22222222-2222-4222-8222-222222222222";

function clock(start = Date.parse("2026-10-29T08:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const stores: [string, () => QueueStore][] = [
  ["memory store", () => createMemoryStore()],
  ["IndexedDB store", () => createIdbStore(USER_A, createFakeIdb().factory)],
];

describe.each(stores)("offline queue on the %s", (_name, makeStore) => {
  it("enqueues a pending item with the client id as its key", async () => {
    const q = createQueue(makeStore(), USER_A, clock().now);
    const item = await q.enqueue({ id: ID_1, command: "field.visit_check_in", args: { p_customer_id: "c-1", p_lat: 30.04 } });
    expect(item).toMatchObject({ id: ID_1, userId: USER_A, status: "pending", attempts: 0, lastError: null, flag: null, groupKey: null });
    expect(await q.list()).toHaveLength(1);
  });

  it("enqueuing the same id twice keeps one item (double tap)", async () => {
    const q = createQueue(makeStore(), USER_A, clock().now);
    await q.enqueue({ id: ID_1, command: "field.visit_check_in", args: { n: 1 } });
    const again = await q.enqueue({ id: ID_1, command: "field.visit_check_in", args: { n: 2 } });
    expect(again.args).toEqual({ n: 1 });
    expect(await q.list()).toHaveLength(1);
  });

  it("lists in createdAt order, ties broken by queue order", async () => {
    const c = clock();
    const q = createQueue(makeStore(), USER_A, c.now);
    const a = await q.enqueue({ command: "work.create_task", args: { n: 1 } });
    const b = await q.enqueue({ command: "work.create_task", args: { n: 2 } }); // same millisecond
    c.advance(1000);
    const d = await q.enqueue({ command: "work.create_task", args: { n: 3 } });
    expect((await q.list()).map((i) => i.id)).toEqual([a.id, b.id, d.id]);
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it("marks state transitions and counts attempts", async () => {
    const q = createQueue(makeStore(), USER_A, clock().now);
    await q.enqueue({ id: ID_1, command: "crm.update_customer", args: {} });
    expect((await q.markSyncing(ID_1))?.attempts).toBe(1);
    const error = { code: "VALIDATION", messageKey: "VALIDATION" as const, at: "2026-10-29T08:00:00.000Z" };
    expect((await q.markFailed(ID_1, error))?.status).toBe("failed");
    expect((await q.markConflict(ID_1, { ...error, code: "CONFLICT" }))?.status).toBe("conflict");
    expect((await q.requeue(ID_1, { argsPatch: { p_version: 4 } }))?.args).toEqual({ p_version: 4 });
    expect((await q.markDone(ID_1, { replayed: true }))?.result).toEqual({ replayed: true });
    // A done item is never put back in the queue.
    expect((await q.requeue(ID_1))?.status).toBe("done");
    await q.remove(ID_1);
    expect(await q.list()).toEqual([]);
  });

  it("recovers items left syncing by a killed tab", async () => {
    const q = createQueue(makeStore(), USER_A, clock().now);
    await q.enqueue({ id: ID_1, command: "field.visit_check_in", args: {} });
    await q.markSyncing(ID_1);
    expect(await q.recoverInterrupted()).toBe(1);
    expect((await q.get(ID_1))?.status).toBe("pending");
  });

  it("prunes done items after the retention window only", async () => {
    const c = clock();
    const q = createQueue(makeStore(), USER_A, c.now);
    await q.enqueue({ id: ID_1, command: "field.visit_check_in", args: {} });
    await q.enqueue({ id: ID_2, command: "field.visit_check_in", args: {} });
    await q.markDone(ID_1, null);
    c.advance(60_000);
    expect(await q.pruneDone(120_000)).toBe(0);
    c.advance(120_000);
    expect(await q.pruneDone(120_000)).toBe(1);
    expect((await q.list()).map((i) => i.id)).toEqual([ID_2]);
  });

  it("stores JSON copies, not references", async () => {
    const q = createQueue(makeStore(), USER_A, clock().now);
    const args = { nested: { v: 1 } };
    await q.enqueue({ id: ID_1, command: "crm.update_customer", args });
    args.nested.v = 2;
    expect((await q.get(ID_1))?.args).toEqual({ nested: { v: 1 } });
  });
});

describe("offline queue input checks", () => {
  const q = createQueue(createMemoryStore(), USER_A);

  it("rejects ids that are not uuids, bad command ids and non-object args", async () => {
    await expect(q.enqueue({ id: "not-a-uuid", command: "field.visit_check_in", args: {} })).rejects.toThrow(/uuid/);
    await expect(q.enqueue({ command: "", args: {} })).rejects.toThrow(/command/);
    await expect(q.enqueue({ command: "field.visit_check_in", args: [] as never })).rejects.toThrow(/object/);
  });

  it("generates a uuid when no id is given", async () => {
    const item = await q.enqueue({ command: "work.create_task", args: {} });
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("per-user isolation on a shared device", () => {
  it("names one database per user and rejects unsafe user ids", () => {
    expect(dbNameFor(USER_A)).toBe(`${DB_PREFIX}${USER_A}`);
    expect(dbNameFor(USER_A)).not.toBe(dbNameFor(USER_B));
    expect(() => dbNameFor("")).toThrow();
    expect(() => dbNameFor("../other")).toThrow();
    expect(() => createQueue(createMemoryStore(), "a b")).toThrow();
  });

  it("one user's items are invisible to another user", async () => {
    const idb = createFakeIdb();
    const a = createQueue(createIdbStore(USER_A, idb.factory), USER_A);
    const b = createQueue(createIdbStore(USER_B, idb.factory), USER_B);
    await a.enqueue({ id: ID_1, command: "field.visit_check_in", args: {} });
    expect(await b.list()).toEqual([]);
    expect((await a.list()).map((i) => i.userId)).toEqual([USER_A]);
  });

  it("clearForUser deletes only that user's database, even while it is open", async () => {
    const idb = createFakeIdb();
    const storeA = createIdbStore(USER_A, idb.factory);
    const a = createQueue(storeA, USER_A);
    const b = createQueue(createIdbStore(USER_B, idb.factory), USER_B);
    await a.enqueue({ id: ID_1, command: "field.visit_check_in", args: {} });
    await b.enqueue({ id: ID_2, command: "field.visit_check_in", args: {} });

    await clearForUser(USER_A, idb.factory);
    expect(idb.names()).toEqual([dbNameFor(USER_B)]);
    // The open connection let go; a later read sees a fresh, empty queue.
    expect(await a.list()).toEqual([]);
    expect((await b.list()).map((i) => i.id)).toEqual([ID_2]);
  });

  it("clearAllUsers deletes every user's queue and nothing else", async () => {
    const idb = createFakeIdb();
    await createQueue(createIdbStore(USER_A, idb.factory), USER_A).enqueue({ command: "work.create_task", args: {} });
    await createQueue(createIdbStore(USER_B, idb.factory), USER_B).enqueue({ command: "work.create_task", args: {} });
    await new Promise<void>((resolve) => {
      const r = idb.factory.open("some-other-db");
      r.onsuccess = () => resolve();
    });
    expect(await clearAllUsers(idb.factory)).toBe(true);
    expect(idb.names()).toEqual(["some-other-db"]);
  });

  it("clearing is a no-op without IndexedDB", async () => {
    await expect(clearForUser(USER_A, undefined)).resolves.toBeUndefined();
    expect(await clearAllUsers(undefined)).toBe(false);
  });
});
