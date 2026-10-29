import { describe, expect, it, vi } from "vitest";
import { createMemoryStore, createQueue } from "@/lib/offline/queue";
import {
  MAX_AGE_MS,
  classifyFailure,
  createSenderRegistry,
  createSyncEngine,
  type SenderRegistry,
  type SyncEngineDeps,
} from "@/lib/offline/sync";
import type { JsonObject, SendError, SendResult } from "@/lib/offline/types";

// Synthetic data only (D-03).
const USER = "00000000-0000-4000-8000-0000000000aa";
const START = Date.parse("2026-10-29T08:00:00Z");

const err = (over: Partial<SendError> = {}): SendError => ({ code: "VALIDATION", messageKey: "VALIDATION", retryable: false, ...over });

/**
 * A fake server with idempotent commands: the first send of an id applies it,
 * a later send of the same id answers { replayed: true } (like api.visit_check_in).
 */
function fakeServer() {
  const applied: string[] = [];
  const calls: string[] = [];
  const send = async (_args: JsonObject, meta: { id: string }): Promise<SendResult> => {
    calls.push(meta.id);
    if (applied.includes(meta.id)) return { ok: true, data: { replayed: true } };
    applied.push(meta.id);
    return { ok: true, data: { replayed: false } };
  };
  return { applied, calls, send };
}

function setup(over: Partial<SyncEngineDeps> & { registry?: SenderRegistry } = {}) {
  let t = START;
  const now = () => t;
  const queue = createQueue(createMemoryStore(), USER, now);
  const registry = over.registry ?? createSenderRegistry();
  const engine = createSyncEngine({ queue, registry, now, sleep: async () => undefined, random: () => 0, ...over });
  return { queue, registry, engine, now, advance: (ms: number) => (t += ms) };
}

describe("classifyFailure (audit #15: retry only when safe)", () => {
  it.each([
    ["serialization failure (rolled back)", err({ code: "UNAVAILABLE", messageKey: "UNAVAILABLE", retryable: true }), true, "transient"],
    ["rolled back, non-idempotent sender", err({ code: "UNAVAILABLE", messageKey: "UNAVAILABLE", retryable: true }), false, "transient"],
    ["ambiguous, idempotent by key", err({ code: "UNAVAILABLE", messageKey: "UNAVAILABLE", ambiguous: true }), true, "transient"],
    ["ambiguous, NOT idempotent", err({ code: "UNAVAILABLE", messageKey: "UNAVAILABLE", ambiguous: true }), false, "failed"],
    ["business error", err({ code: "INSUFFICIENT_STOCK", messageKey: "UNKNOWN" }), true, "failed"],
    ["permission denied", err({ code: "PERMISSION_DENIED", messageKey: "PERMISSION_DENIED" }), true, "failed"],
    ["version conflict", err({ code: "CONFLICT", messageKey: "CONFLICT", conflict: { currentVersion: 3 } }), true, "conflict"],
    ["CONFLICT without a version (client ref reused)", err({ code: "CONFLICT", messageKey: "CONFLICT" }), true, "failed"],
  ] as const)("%s → %s", (_name, error, idempotent, kind) => {
    expect(classifyFailure(error, idempotent)).toBe(kind);
  });
});

describe("sync engine", () => {
  it("sends items one at a time in createdAt order", async () => {
    const { engine, registry, advance } = setup();
    const order: string[] = [];
    let inFlight = 0;
    registry.register("work.create_task", async (args) => {
      inFlight++;
      expect(inFlight).toBe(1); // sequential
      order.push(String(args.title));
      await Promise.resolve();
      inFlight--;
      return { ok: true, data: null };
    });
    await engine.enqueue({ command: "work.create_task", args: { title: "first" } });
    advance(10);
    await engine.enqueue({ command: "work.create_task", args: { title: "second" } });
    advance(10);
    await engine.enqueue({ command: "work.create_task", args: { title: "third" } });

    const report = await engine.sync();
    expect(order).toEqual(["first", "second", "third"]);
    expect(report).toMatchObject({ done: 3, failed: 0, interrupted: false });
    expect((await engine.list()).every((i) => i.status === "done")).toBe(true);
  });

  it("passes the item id as the idempotency key and createdAt as metadata", async () => {
    const { engine, registry } = setup();
    const send = vi.fn(async (): Promise<SendResult> => ({ ok: true, data: null }));
    registry.register("field.visit_check_in", send);
    const item = await engine.enqueue({ command: "field.visit_check_in", args: { p_customer_id: "c" } });
    await engine.sync();
    expect(send).toHaveBeenCalledWith({ p_customer_id: "c" }, { id: item.id, createdAt: item.createdAt, attempt: 1 });
  });

  it("a replayed answer is a success, and the replay is counted", async () => {
    const { engine, registry } = setup();
    registry.register("field.visit_check_in", async () => ({ ok: true, data: { visit_id: "v", replayed: true } }));
    const item = await engine.enqueue({ command: "field.visit_check_in", args: {} });
    const report = await engine.sync();
    expect(report).toMatchObject({ done: 1, replayed: 1 });
    expect(await engine.queue.get(item.id)).toMatchObject({ status: "done", result: { visit_id: "v", replayed: true } });
  });

  it("a tab killed mid-sync resumes without applying anything twice", async () => {
    const server = fakeServer();
    const { engine, registry, queue } = setup();
    registry.register("field.visit_check_in", server.send);
    const item = await engine.enqueue({ command: "field.visit_check_in", args: {} });
    // The previous tab sent it (server applied it) and died before marking it done.
    await queue.markSyncing(item.id);
    await server.send({}, { id: item.id });

    const report = await engine.sync();
    expect(report).toMatchObject({ done: 1, replayed: 1 });
    expect(server.applied).toEqual([item.id]);
    expect(server.calls).toEqual([item.id, item.id]);
  });

  it("retries a rolled-back failure within the run, then succeeds", async () => {
    const { engine, registry } = setup();
    const send = vi
      .fn<() => Promise<SendResult>>()
      .mockResolvedValueOnce({ ok: false, error: err({ code: "UNAVAILABLE", messageKey: "UNAVAILABLE", retryable: true }) })
      .mockResolvedValueOnce({ ok: true, data: null });
    registry.register("work.create_task", send);
    const item = await engine.enqueue({ command: "work.create_task", args: {} });
    expect(await engine.sync()).toMatchObject({ done: 1 });
    expect(send).toHaveBeenCalledTimes(2);
    expect((await engine.queue.get(item.id))?.attempts).toBe(2);
  });

  it("network failure (thrown) on an idempotent command: retried, then left pending and later items wait", async () => {
    const { engine, registry, advance } = setup({ attemptsPerRun: 3 });
    const first = vi.fn(async (): Promise<SendResult> => {
      throw new TypeError("Failed to fetch");
    });
    const second = vi.fn(async (): Promise<SendResult> => ({ ok: true, data: null }));
    registry.register("field.visit_check_in", first, { idempotent: true });
    registry.register("work.create_task", second);
    const a = await engine.enqueue({ command: "field.visit_check_in", args: {} });
    advance(1);
    await engine.enqueue({ command: "work.create_task", args: {} });

    const report = await engine.sync();
    expect(report).toMatchObject({ done: 0, interrupted: true });
    expect(first).toHaveBeenCalledTimes(3);
    expect(second).not.toHaveBeenCalled(); // order preserved
    expect(await engine.queue.get(a.id)).toMatchObject({ status: "pending", attempts: 3, lastError: { code: "UNAVAILABLE" } });
  });

  it("never auto-retries an ambiguous failure of a non-idempotent sender", async () => {
    const { engine, registry } = setup();
    const send = vi.fn(async (): Promise<SendResult> => {
      throw new TypeError("Failed to fetch");
    });
    registry.register("legacy.command", send, { idempotent: false });
    const item = await engine.enqueue({ command: "legacy.command", args: {} });
    expect(await engine.sync()).toMatchObject({ failed: 1, interrupted: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await engine.queue.get(item.id))?.status).toBe("failed");
  });

  describe("idempotency is opt-in (audit #15, F9): a sender registered without the flag", () => {
    it("is recorded as not idempotent", () => {
      const registry = createSenderRegistry();
      registry.register("legacy.command", async () => ({ ok: true }));
      registry.register("legacy.other", async () => ({ ok: true }), {});
      expect(registry.get("legacy.command")?.idempotent).toBe(false);
      expect(registry.get("legacy.other")?.idempotent).toBe(false);
    });

    it("is NOT auto-retried after a network failure (the request threw)", async () => {
      const { engine, registry } = setup({ attemptsPerRun: 3 });
      const send = vi.fn(async (): Promise<SendResult> => {
        throw new TypeError("Failed to fetch");
      });
      registry.register("legacy.command", send);
      const item = await engine.enqueue({ command: "legacy.command", args: {} });
      expect(await engine.sync()).toMatchObject({ done: 0, failed: 1, interrupted: false });
      expect(send).toHaveBeenCalledTimes(1);
      expect(await engine.queue.get(item.id)).toMatchObject({ status: "failed", attempts: 1, lastError: { code: "UNAVAILABLE" } });
      // Later runs leave it alone too: only the user can retry it.
      await engine.sync();
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("is NOT auto-retried after an ambiguous server answer (connection lost after send)", async () => {
      const { engine, registry } = setup({ attemptsPerRun: 3 });
      const send = vi.fn(async (): Promise<SendResult> => ({ ok: false, error: err({ code: "UNAVAILABLE", messageKey: "UNAVAILABLE", ambiguous: true }) }));
      registry.register("legacy.command", send);
      const item = await engine.enqueue({ command: "legacy.command", args: {} });
      expect(await engine.sync()).toMatchObject({ failed: 1 });
      expect(send).toHaveBeenCalledTimes(1);
      expect((await engine.queue.get(item.id))?.status).toBe("failed");
    });

    it("is still retried after a rolled-back failure (the server certainly did not commit)", async () => {
      const { engine, registry } = setup({ attemptsPerRun: 2 });
      const send = vi
        .fn<() => Promise<SendResult>>()
        .mockResolvedValueOnce({ ok: false, error: err({ code: "UNAVAILABLE", messageKey: "UNAVAILABLE", retryable: true }) })
        .mockResolvedValueOnce({ ok: true, data: null });
      registry.register("legacy.command", send);
      await engine.enqueue({ command: "legacy.command", args: {} });
      expect(await engine.sync()).toMatchObject({ done: 1 });
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it("an ambiguous server-side error (connection lost after send) is retried for idempotent senders", async () => {
    const { engine, registry } = setup({ attemptsPerRun: 2 });
    const send = vi
      .fn<() => Promise<SendResult>>()
      .mockResolvedValueOnce({ ok: false, error: err({ code: "UNAVAILABLE", messageKey: "UNAVAILABLE", ambiguous: true }) })
      .mockResolvedValueOnce({ ok: true, data: { replayed: true } });
    registry.register("field.visit_check_in", send, { idempotent: true });
    await engine.enqueue({ command: "field.visit_check_in", args: {} });
    expect(await engine.sync()).toMatchObject({ done: 1, replayed: 1 });
  });

  it("a business error moves the item to failed with its translation key, sent once, and holds its group only", async () => {
    const { engine, registry, advance } = setup();
    const checkIn = vi.fn(async (): Promise<SendResult> => ({
      ok: false,
      error: err({ code: "PERMISSION_DENIED", messageKey: "PERMISSION_DENIED", requestId: "req-1" }),
    }));
    const checkOut = vi.fn(async (): Promise<SendResult> => ({ ok: true, data: null }));
    const task = vi.fn(async (): Promise<SendResult> => ({ ok: true, data: null }));
    registry.register("field.visit_check_in", checkIn);
    registry.register("field.visit_check_out", checkOut);
    registry.register("work.create_task", task);

    const a = await engine.enqueue({ command: "field.visit_check_in", args: {}, groupKey: "visit-1" });
    advance(1);
    const b = await engine.enqueue({ command: "field.visit_check_out", args: {}, groupKey: "visit-1" });
    advance(1);
    await engine.enqueue({ command: "work.create_task", args: {} });

    const report = await engine.sync();
    expect(report).toMatchObject({ done: 1, failed: 1, held: 1 });
    expect(checkIn).toHaveBeenCalledTimes(1);
    expect(checkOut).not.toHaveBeenCalled();
    expect(task).toHaveBeenCalledTimes(1);
    expect(await engine.queue.get(a.id)).toMatchObject({
      status: "failed",
      lastError: { code: "PERMISSION_DENIED", messageKey: "PERMISSION_DENIED", requestId: "req-1" },
    });
    expect((await engine.queue.get(b.id))?.status).toBe("pending");

    // A later sync does not resend the failed item on its own.
    await engine.sync();
    expect(checkIn).toHaveBeenCalledTimes(1);
  });

  it("a version conflict moves the item to conflict; keep-mine re-sends with the server's version", async () => {
    const { engine, registry } = setup();
    const send = vi
      .fn<(args: JsonObject) => Promise<SendResult>>()
      .mockResolvedValueOnce({
        ok: false,
        error: err({ code: "CONFLICT", messageKey: "CONFLICT", conflict: { currentVersion: 5, server: { current_version: 5 } } }),
      })
      .mockResolvedValueOnce({ ok: true, data: { version: 6 } });
    registry.register("crm.update_customer", send, { versionArg: "p_version" });
    const item = await engine.enqueue({ command: "crm.update_customer", args: { p_version: 4, p_changes: { city: "Test City" } } });

    expect(await engine.sync()).toMatchObject({ conflicts: 1 });
    const conflicted = await engine.queue.get(item.id);
    expect(conflicted).toMatchObject({ status: "conflict", lastError: { code: "CONFLICT", conflict: { currentVersion: 5 } } });
    expect(engine.canKeepMine(conflicted!)).toBe(true);

    expect(await engine.keepMine(item.id)).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ p_version: 5, p_changes: { city: "Test City" } }, expect.anything());
    expect((await engine.queue.get(item.id))?.status).toBe("done");
  });

  it("keep-mine is refused when the sender declares no version arg", async () => {
    const { engine, registry } = setup();
    registry.register("crm.update_customer", async () => ({ ok: false, error: err({ code: "CONFLICT", messageKey: "CONFLICT", conflict: { currentVersion: 2 } }) }));
    const item = await engine.enqueue({ command: "crm.update_customer", args: {} });
    await engine.sync();
    expect(await engine.keepMine(item.id)).toBe(false);
  });

  it("retry puts a failed item back and sends it again", async () => {
    const { engine, registry } = setup();
    const send = vi
      .fn<() => Promise<SendResult>>()
      .mockResolvedValueOnce({ ok: false, error: err() })
      .mockResolvedValueOnce({ ok: true, data: null });
    registry.register("work.create_task", send);
    const item = await engine.enqueue({ command: "work.create_task", args: {} });
    await engine.sync();
    expect(await engine.retry(item.id)).toMatchObject({ done: 1 });
    expect((await engine.queue.get(item.id))?.status).toBe("done");
  });

  describe("7-day rule (TESTING.md §2.6)", () => {
    it("an item older than 7 days is flagged and never sent automatically", async () => {
      const { engine, registry, advance } = setup();
      const send = vi.fn(async (): Promise<SendResult> => ({ ok: true, data: null }));
      registry.register("field.visit_check_in", send);
      const old = await engine.enqueue({ command: "field.visit_check_in", args: {}, groupKey: "visit-9" });
      const later = await engine.enqueue({ command: "field.visit_check_out", args: {}, groupKey: "visit-9" });
      registry.register("field.visit_check_out", send);
      advance(MAX_AGE_MS + 1);

      const report = await engine.sync();
      expect(report).toMatchObject({ done: 0, stale: 1, held: 1 });
      expect(send).not.toHaveBeenCalled();
      expect(await engine.queue.get(old.id)).toMatchObject({ status: "pending", flag: "stale", staleAcknowledged: false });

      // Still not sent on the next automatic run, and not re-counted.
      expect(await engine.sync()).toMatchObject({ done: 0, stale: 0 });
      expect(send).not.toHaveBeenCalled();
      expect((await engine.queue.get(later.id))?.status).toBe("pending");
    });

    it("an item exactly 7 days old is still sent", async () => {
      const { engine, registry, advance } = setup();
      registry.register("work.create_task", async () => ({ ok: true, data: null }));
      await engine.enqueue({ command: "work.create_task", args: {} });
      advance(MAX_AGE_MS);
      expect(await engine.sync()).toMatchObject({ done: 1, stale: 0 });
    });

    it("after the user reviews it, 'send anyway' applies it (the server flags late_sync)", async () => {
      const { engine, registry, advance } = setup();
      const send = vi.fn(async (): Promise<SendResult> => ({ ok: true, data: null }));
      registry.register("field.visit_check_in", send);
      const old = await engine.enqueue({ command: "field.visit_check_in", args: {} });
      advance(MAX_AGE_MS + 1);
      await engine.sync();
      expect(await engine.retry(old.id)).toMatchObject({ done: 1 });
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it("does nothing while offline", async () => {
    const { engine, registry } = setup({ isOnline: () => false });
    const send = vi.fn(async (): Promise<SendResult> => ({ ok: true, data: null }));
    registry.register("work.create_task", send);
    await engine.enqueue({ command: "work.create_task", args: {} });
    expect(await engine.sync()).toMatchObject({ offline: true, done: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("stops when the device goes offline mid-run", async () => {
    let online = true;
    const { engine, registry, advance } = setup({ isOnline: () => online });
    registry.register("work.create_task", async () => {
      online = false;
      return { ok: true, data: null };
    });
    await engine.enqueue({ command: "work.create_task", args: {} });
    advance(1);
    await engine.enqueue({ command: "work.create_task", args: {} });
    expect(await engine.sync()).toMatchObject({ done: 1, interrupted: true });
  });

  it("keeps items whose sender is not registered (and their group) without failing them", async () => {
    const { engine, registry, advance } = setup();
    const task = vi.fn(async (): Promise<SendResult> => ({ ok: true, data: null }));
    registry.register("work.create_task", task);
    const orphan = await engine.enqueue({ command: "field.visit_check_in", args: {}, groupKey: "g" });
    advance(1);
    await engine.enqueue({ command: "field.visit_check_out", args: {}, groupKey: "g" });
    advance(1);
    await engine.enqueue({ command: "work.create_task", args: {} });

    expect(await engine.sync()).toMatchObject({ done: 1, held: 2, failed: 0 });
    expect(await engine.queue.get(orphan.id)).toMatchObject({ status: "pending", lastError: { code: "NO_SENDER" } });
  });

  it("concurrent sync calls share one pass: nothing is sent twice", async () => {
    const server = fakeServer();
    const { engine, registry } = setup();
    registry.register("field.visit_check_in", async (args, meta) => {
      await new Promise((r) => setTimeout(r, 1));
      return server.send(args, meta);
    });
    await engine.enqueue({ command: "field.visit_check_in", args: {} });
    await engine.enqueue({ command: "field.visit_check_in", args: {} });
    await Promise.all([engine.sync(), engine.sync(), engine.sync()]);
    expect(server.calls).toHaveLength(2);
    expect(server.applied).toHaveLength(2);
  });

  it("an item enqueued during a run is picked up by the follow-up pass", async () => {
    const { engine, registry } = setup();
    const seen: string[] = [];
    registry.register("work.create_task", async (args) => {
      seen.push(String(args.n));
      if (args.n === 1) void engine.submit({ command: "work.create_task", args: { n: 2 } });
      return { ok: true, data: null };
    });
    await engine.enqueue({ command: "work.create_task", args: { n: 1 } });
    await engine.sync();
    await vi.waitFor(async () => expect((await engine.list()).every((i) => i.status === "done")).toBe(true));
    expect(seen).toEqual(["1", "2"]);
  });

  it("skips the run when another tab holds the lock", async () => {
    const { engine, registry } = setup({ withLock: async () => null });
    const send = vi.fn(async (): Promise<SendResult> => ({ ok: true, data: null }));
    registry.register("work.create_task", send);
    await engine.enqueue({ command: "work.create_task", args: {} });
    expect(await engine.sync()).toMatchObject({ busy: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("submit returns the item after the sync, with the server's answer", async () => {
    const { engine, registry } = setup();
    registry.register("field.visit_check_in", async () => ({ ok: true, data: { verification_status: "verified", replayed: false } }));
    const item = await engine.submit({ command: "field.visit_check_in", args: {} });
    expect(item).toMatchObject({ status: "done", result: { verification_status: "verified" } });
  });

  it("discard removes the item and notifies subscribers", async () => {
    const { engine } = setup();
    const listener = vi.fn();
    engine.subscribe(listener);
    const item = await engine.enqueue({ command: "work.create_task", args: {} });
    await engine.discard(item.id);
    expect(await engine.list()).toEqual([]);
    expect(listener).toHaveBeenCalled();
  });

  it("re-registering replaces the sender; unregister removes only its own registration", () => {
    const registry = createSenderRegistry();
    const one = async (): Promise<SendResult> => ({ ok: true });
    const two = async (): Promise<SendResult> => ({ ok: true });
    const offOne = registry.register("work.create_task", one);
    registry.register("work.create_task", two);
    offOne();
    expect(registry.get("work.create_task")?.send).toBe(two);
    expect(registry.get("work.create_task")?.idempotent).toBe(false); // opt-in only
  });
});
