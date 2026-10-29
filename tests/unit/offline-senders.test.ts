import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeIdb } from "./offline-fake-idb";

// src/modules/offline/senders.ts with stubbed browser globals. The field server
// actions are only referenced, never called, here.
vi.mock("@/lib/command", () => ({ callCommand: async () => ({ ok: true, data: null }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

// Synthetic ids only (D-03).
const USER_A = "00000000-0000-4000-8000-0000000005a1";
const USER_B = "00000000-0000-4000-8000-0000000005b2";

let idb: ReturnType<typeof createFakeIdb>;

beforeEach(() => {
  vi.resetModules();
  idb = createFakeIdb();
  vi.stubGlobal("indexedDB", idb.factory);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function load() {
  const senders = await import("@/modules/offline/senders");
  const client = await import("@/lib/offline/client");
  const sync = await import("@/lib/offline/sync");
  return { ...senders, ...client, ...sync };
}

describe("offline device start (src/modules/offline/senders.ts)", () => {
  it("registers the field senders on import, each explicitly idempotent", async () => {
    const { senders } = await load();
    for (const command of ["field.visit_check_in", "field.visit_check_out", "work.complete_task"]) {
      expect(senders.get(command)?.idempotent).toBe(true);
    }
    expect(senders.get("field.request_visit_exception")).toBeUndefined();
  });

  it("user A queued an item, then user B starts: A's data is gone, B's is kept", async () => {
    const { startOfflineDevice, getSyncEngine } = await load();
    await getSyncEngine(USER_A).enqueue({ command: "field.visit_check_in", args: { lat: 30.0, lng: 31.2 } });
    await getSyncEngine(USER_B).enqueue({ command: "work.complete_task", args: { task_id: "synthetic" } });

    startOfflineDevice(USER_B);
    await vi.waitFor(() => expect(idb.names()).toEqual([`honest-offline-v1:${USER_B}`]));
    expect(await getSyncEngine(USER_A).list()).toEqual([]);
    expect((await getSyncEngine(USER_B).list()).map((i) => i.command)).toEqual(["work.complete_task"]);
  });

  it("runs the wipe once per user per page load", async () => {
    const { startOfflineDevice, getSyncEngine } = await load();
    startOfflineDevice(USER_B);
    await vi.waitFor(() => expect(idb.names()).toEqual([]));
    await getSyncEngine(USER_A).enqueue({ command: "work.complete_task", args: {} });
    startOfflineDevice(USER_B); // second mount on the same page: no new wipe
    await new Promise((r) => setTimeout(r, 10));
    expect(idb.names()).toEqual([`honest-offline-v1:${USER_A}`]);
  });

  it("does nothing on the server", async () => {
    vi.stubGlobal("window", undefined);
    const { startOfflineDevice, senders } = await load();
    expect(() => startOfflineDevice(USER_B)).not.toThrow();
    expect(senders.get("field.visit_check_in")).toBeUndefined();
  });
});
