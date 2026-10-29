import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeIdb } from "./offline-fake-idb";

// Browser wiring (src/lib/offline/client.ts) with stubbed browser globals.
const USER_A = "00000000-0000-4000-8000-0000000000c1";
const USER_B = "00000000-0000-4000-8000-0000000000c2";

let idb: ReturnType<typeof createFakeIdb>;
let win: EventTarget & { setInterval: typeof setInterval; clearInterval: typeof clearInterval };

beforeEach(() => {
  vi.resetModules();
  idb = createFakeIdb();
  win = Object.assign(new EventTarget(), {
    setInterval: ((fn: () => void, ms: number) => setInterval(fn, ms)) as typeof setInterval,
    clearInterval: ((id: ReturnType<typeof setInterval>) => clearInterval(id)) as typeof clearInterval,
  });
  vi.stubGlobal("indexedDB", idb.factory);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("navigator", { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function load() {
  const client = await import("@/lib/offline/client");
  const sync = await import("@/lib/offline/sync");
  return { ...client, ...sync };
}

describe("offline client wiring", () => {
  it("one engine per user, each on its own database", async () => {
    const { getSyncEngine, clearForUser } = await load();
    const a = getSyncEngine(USER_A);
    expect(getSyncEngine(USER_A)).toBe(a);
    expect(getSyncEngine(USER_B)).not.toBe(a);
    await a.enqueue({ command: "work.create_task", args: {} });
    expect(await getSyncEngine(USER_B).list()).toEqual([]);
    expect(a.queue.persistent).toBe(true);
    await clearForUser(USER_A);
    await clearForUser(USER_B);
  });

  it("auto-sync runs on start and on the online event, and stops when released", async () => {
    const { getSyncEngine, startAutoSync, registerSender, clearForUser } = await load();
    const send = vi.fn(async () => ({ ok: true as const, data: null }));
    registerSender("work.create_task", send);
    const engine = getSyncEngine(USER_A);
    await engine.enqueue({ command: "work.create_task", args: {} });

    const stop = startAutoSync(USER_A);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    await engine.enqueue({ command: "work.create_task", args: {} });
    win.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    stop();
    await engine.enqueue({ command: "work.create_task", args: {} });
    win.dispatchEvent(new Event("online"));
    await new Promise((r) => setTimeout(r, 20));
    expect(send).toHaveBeenCalledTimes(2);
    await clearForUser(USER_A);
  });

  it("does not sync while the browser reports offline", async () => {
    const { getSyncEngine, startAutoSync, registerSender, clearForUser } = await load();
    vi.stubGlobal("navigator", { onLine: false });
    const send = vi.fn(async () => ({ ok: true as const, data: null }));
    registerSender("work.create_task", send);
    await getSyncEngine(USER_A).enqueue({ command: "work.create_task", args: {} });
    const stop = startAutoSync(USER_A);
    await new Promise((r) => setTimeout(r, 20));
    expect(send).not.toHaveBeenCalled();
    stop();
    await clearForUser(USER_A);
  });

  it("sign-out: countUnsynced warns, clearForUser wipes this user's queue only", async () => {
    const { getSyncEngine, countUnsynced, clearForUser } = await load();
    await getSyncEngine(USER_A).enqueue({ command: "work.create_task", args: {} });
    await getSyncEngine(USER_B).enqueue({ command: "work.create_task", args: {} });
    expect(await countUnsynced(USER_A)).toBe(1);

    await clearForUser(USER_A);
    expect(idb.names()).not.toContain(`honest-offline-v1:${USER_A}`);
    expect(await countUnsynced(USER_A)).toBe(0); // a fresh, empty queue
    expect(await countUnsynced(USER_B)).toBe(1);
    await clearForUser(USER_A);
    await clearForUser(USER_B);
  });
});
