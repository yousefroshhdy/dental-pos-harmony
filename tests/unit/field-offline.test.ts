import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError, Result } from "@/lib/errors";

// The server actions run in-process against a fake api.* (callCommand) that is
// idempotent like the real commands. Synthetic data only (D-03).
const db = vi.hoisted(() => ({ handle: null as null | ((name: string, args: Record<string, unknown>) => Promise<unknown>) }));
vi.mock("@/lib/command", () => ({ callCommand: (name: string, args: Record<string, unknown>) => db.handle!(name, args) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { createMemoryStore, createQueue, type Queue } from "@/lib/offline/queue";
import { createSenderRegistry, createSyncEngine, type SenderRegistry, type SyncEngine } from "@/lib/offline/sync";
import type { JsonObject, QueueItem } from "@/lib/offline/types";
import { completeTask, visitCheckIn, visitCheckOut } from "@/modules/field/actions";
import { sendCompleteTask, sendVisitCheckIn, sendVisitCheckOut } from "@/modules/field/device";
import {
  asCheckInResult,
  checkedOutParam,
  deviceQueueId,
  deviceToSendResult,
  FIELD_QUEUED_COMMANDS,
  nameBasedId,
  queuedView,
  submitDeviceCommand,
  type DeviceCommand,
  type DeviceQueue,
} from "@/modules/field/logic";
import { registerFieldSenders } from "@/modules/field/offline";
import { buildCheckInPayload, buildCheckOutPayload } from "@/modules/field/payloads";
import { checkInSchema, checkOutSchema, completeTaskSchema, type CheckInPayload, type CheckOutPayload } from "@/modules/field/schemas";
import type { CheckInResult, CheckOutResult, CompleteTaskResult, DeviceResult } from "@/modules/field/types";

const USER_A = "00000000-0000-4000-8000-00000000f0a1";
const USER_B = "00000000-0000-4000-8000-00000000f0b2";
const VISIT = "00000000-0000-4000-8000-00000000f111";
const VISIT_2 = "00000000-0000-4000-8000-00000000f112";
const CUSTOMER = "00000000-0000-4000-8000-00000000f222";
const TASK = "00000000-0000-4000-8000-00000000f333";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TAP = Date.parse("2026-10-29T09:00:00.000Z");
const FIX = { ok: true as const, lat: 30.04442, lng: 31.235712, accuracyM: 12.3, capturedAt: "2026-10-29T08:59:58.000Z" };

const { checkIn: CHECK_IN, checkOut: CHECK_OUT, completeTask: COMPLETE_TASK } = FIELD_QUEUED_COMMANDS;

const failure = (code: string, over: Partial<AppError> = {}): Result<never> => ({
  ok: false,
  error: { code, messageKey: "UNKNOWN", detail: "", retryable: false, ...over } as AppError,
});

/**
 * A fake database with the replay rules of the real commands:
 * check-in and check-out replay on the visit id, complete_task on the task id.
 * `inject` makes the next call fail: "lost" applies then loses the answer (the
 * browser's request rejects), "rolledBack" fails without applying.
 */
function fakeDb(now: () => number) {
  const checkIns = new Map<string, Record<string, unknown>>();
  const checkOuts = new Set<string>();
  const doneTasks = new Set<string>();
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let inject: null | "lost" | "rolledBack" | { code: string; messageKey?: AppError["messageKey"] } = null;

  async function apply(name: string, args: Record<string, unknown>): Promise<Result<unknown>> {
    if (name === "visit_check_in") {
      const id = String(args.p_visit_id);
      if (checkIns.has(id)) return { ok: true, data: { visit_id: id, verification_status: "verified", distance_m: 12, replayed: true } };
      checkIns.set(id, args);
      const skew = Math.abs(now() - Date.parse(String(args.p_captured_at))) > 600_000;
      return { ok: true, data: { visit_id: id, verification_status: "verified", distance_m: 12, anomaly_flags: skew ? ["late_sync"] : [], replayed: false } };
    }
    if (name === "visit_check_out") {
      const id = String(args.p_visit_id);
      if (!checkIns.has(id)) return failure("NOT_FOUND", { messageKey: "NOT_FOUND" });
      if (checkOuts.has(id)) return { ok: true, data: { visit_id: id, status: "completed", outcome: args.p_outcome, follow_up_task_id: null, replayed: true } };
      checkOuts.add(id);
      return { ok: true, data: { visit_id: id, status: "completed", outcome: args.p_outcome, follow_up_task_id: null, replayed: false } };
    }
    if (name === "complete_task") {
      const id = String(args.p_task_id);
      if (doneTasks.has(id)) return { ok: true, data: { task_id: id, status: "done", replayed: true } };
      doneTasks.add(id);
      return { ok: true, data: { task_id: id, status: "done", replayed: false } };
    }
    return failure("NOT_FOUND", { messageKey: "NOT_FOUND" });
  }

  return {
    checkIns,
    checkOuts,
    doneTasks,
    calls,
    failNext(kind: typeof inject) {
      inject = kind;
    },
    async handle(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      const fault = inject;
      inject = null;
      if (fault === "rolledBack") return failure("UNAVAILABLE", { messageKey: "UNAVAILABLE", retryable: true });
      if (fault && typeof fault === "object") return failure(fault.code, { messageKey: fault.messageKey ?? "UNKNOWN" });
      const result = await apply(name, args);
      if (fault === "lost") throw new TypeError("Failed to fetch"); // committed, answer lost
      return result;
    },
  };
}

interface Device {
  userId: string;
  queue: Queue;
  engine: SyncEngine;
  registry: SenderRegistry;
}

function device(userId: string, now: () => number): Device {
  const queue = createQueue(createMemoryStore(), userId, now);
  const registry = createSenderRegistry();
  registerFieldSenders(registry.register);
  const engine = createSyncEngine({ queue, registry, now, sleep: async () => undefined, random: () => 0 });
  return { userId, queue, engine, registry };
}

let t = TAP;
const now = () => t;
let server: ReturnType<typeof fakeDb>;

beforeEach(() => {
  t = TAP;
  server = fakeDb(now);
  db.handle = server.handle;
});

const checkInPayload = (visitId = VISIT, geo: typeof FIX | null = FIX): CheckInPayload =>
  buildCheckInPayload({ visitId, customerId: CUSTOMER, geo, consented: geo !== null, now: new Date(TAP) });

const checkInCmd = (payload: CheckInPayload): DeviceCommand => ({
  command: CHECK_IN,
  id: deviceQueueId(CHECK_IN, payload.visit_id),
  args: payload as unknown as JsonObject,
  groupKey: payload.visit_id,
  summary: "Synthetic Clinic 01",
});

const checkOutPayload = (visitId = VISIT): CheckOutPayload =>
  buildCheckOutPayload({ visitId, outcome: "interested", notes: " synthetic note ", nextFollowUpAt: null, geo: null, now: new Date(TAP + 30 * 60_000) });

const checkOutCmd = (payload: CheckOutPayload): DeviceCommand => ({
  command: CHECK_OUT,
  id: deviceQueueId(CHECK_OUT, payload.visit_id),
  args: payload as unknown as JsonObject,
  groupKey: payload.visit_id,
});

/** The online path's direct call, counted. */
function direct<T>(fn: () => Promise<DeviceResult<T>>) {
  const spy = vi.fn(fn);
  return spy;
}

describe("submitDeviceCommand: send now or save on the device", () => {
  it("online → calls the server action directly and queues nothing", async () => {
    const d = device(USER_A, now);
    const payload = checkInPayload();
    const send = direct(() => sendVisitCheckIn(payload));
    const out = await submitDeviceCommand<CheckInResult>(checkInCmd(payload), { online: true, queue: d.engine, send });
    expect(out).toEqual({ kind: "sent", data: expect.objectContaining({ visit_id: VISIT, verification_status: "verified", replayed: false }) });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await d.queue.list()).toEqual([]);
  });

  it("offline → saves on the device without calling the server", async () => {
    const d = device(USER_A, now);
    const payload = checkInPayload();
    const send = direct(() => sendVisitCheckIn(payload));
    const out = await submitDeviceCommand<CheckInResult>(checkInCmd(payload), { online: false, queue: d.engine, send });
    expect(out).toMatchObject({ kind: "queued", reason: "offline", item: { id: VISIT, command: CHECK_IN, status: "pending", groupKey: VISIT } });
    expect(send).not.toHaveBeenCalled();
    expect(server.calls).toEqual([]);
    expect((await d.queue.list()).map((i) => i.id)).toEqual([VISIT]);
  });

  it("network failure (the request rejects) → saved for the queue", async () => {
    const d = device(USER_A, now);
    const send = vi.fn(async (): Promise<DeviceResult<CheckInResult>> => {
      throw new TypeError("Failed to fetch");
    });
    const out = await submitDeviceCommand(checkInCmd(checkInPayload()), { online: true, queue: d.engine, send });
    expect(out).toMatchObject({ kind: "queued", reason: "network" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await d.queue.list()).toHaveLength(1);
  });

  it("a retryable answer (UNAVAILABLE, rolled back) → saved for the queue", async () => {
    const d = device(USER_A, now);
    server.failNext("rolledBack");
    const payload = checkInPayload();
    const out = await submitDeviceCommand(checkInCmd(payload), { online: true, queue: d.engine, send: () => sendVisitCheckIn(payload) });
    expect(out).toMatchObject({ kind: "queued", reason: "network" });
    expect(server.checkIns.size).toBe(0);
  });

  it.each([
    ["PERMISSION_DENIED", "PERMISSION_DENIED"],
    ["INVALID_STATE", "INVALID_STATE"],
    ["NOT_FOUND", "NOT_FOUND"],
  ] as const)("a business error (%s) is shown and NEVER queued", async (code, messageKey) => {
    const d = device(USER_A, now);
    server.failNext({ code, messageKey });
    const payload = checkInPayload();
    const out = await submitDeviceCommand(checkInCmd(payload), { online: true, queue: d.engine, send: () => sendVisitCheckIn(payload) });
    expect(out).toEqual({ kind: "error", code, messageKey, requestId: undefined, retryable: false });
    expect(await d.queue.list()).toEqual([]);
  });

  it("an invalid payload is a business error (VALIDATION), not queued", async () => {
    const d = device(USER_A, now);
    const bad = { ...checkInPayload(), lat: 200 } as CheckInPayload;
    const out = await submitDeviceCommand(checkInCmd(bad), { online: true, queue: d.engine, send: () => sendVisitCheckIn(bad) });
    expect(out).toMatchObject({ kind: "error", code: "VALIDATION", retryable: false });
    expect(server.calls).toEqual([]);
    expect(await d.queue.list()).toEqual([]);
  });

  it("the same command saved twice stays one item and is not sent again", async () => {
    const d = device(USER_A, now);
    const payload = checkInPayload();
    await submitDeviceCommand(checkInCmd(payload), { online: false, queue: d.engine, send: () => sendVisitCheckIn(payload) });
    const send = direct(() => sendVisitCheckIn(payload));
    const again = await submitDeviceCommand(checkInCmd(payload), { online: true, queue: d.engine, send });
    expect(again).toMatchObject({ kind: "queued", reason: "already_saved" });
    expect(send).not.toHaveBeenCalled();
    expect(await d.queue.list()).toHaveLength(1);
  });

  it("a command already synced answers with the server's saved result", async () => {
    const d = device(USER_A, now);
    const payload = checkInPayload();
    await submitDeviceCommand(checkInCmd(payload), { online: false, queue: d.engine, send: () => sendVisitCheckIn(payload) });
    await d.engine.sync();
    const send = direct(() => sendVisitCheckIn(payload));
    const again = await submitDeviceCommand<CheckInResult>(checkInCmd(payload), { online: true, queue: d.engine, send });
    expect(again).toEqual({ kind: "sent", data: expect.objectContaining({ visit_id: VISIT, replayed: false }) });
    expect(send).not.toHaveBeenCalled();
  });

  it("online, a check-out waits behind its visit's saved check-in (order)", async () => {
    const d = device(USER_A, now);
    const ci = checkInPayload();
    await submitDeviceCommand(checkInCmd(ci), { online: false, queue: d.engine, send: () => sendVisitCheckIn(ci) });
    const co = checkOutPayload();
    const send = direct(() => sendVisitCheckOut(co));
    const out = await submitDeviceCommand(checkOutCmd(co), { online: true, queue: d.engine, send });
    expect(out).toMatchObject({ kind: "queued", reason: "ordered" });
    expect(send).not.toHaveBeenCalled(); // a direct send would hit NOT_FOUND: the visit is not on the server yet

    const report = await d.engine.sync();
    expect(report).toMatchObject({ done: 2, failed: 0 });
    expect(server.calls.map((c) => c.name)).toEqual(["visit_check_in", "visit_check_out"]);
  });

  it("a different visit is not held by another visit's saved check-in", async () => {
    const d = device(USER_A, now);
    const ci = checkInPayload();
    await submitDeviceCommand(checkInCmd(ci), { online: false, queue: d.engine, send: () => sendVisitCheckIn(ci) });
    const other = checkInPayload(VISIT_2);
    const out = await submitDeviceCommand(checkInCmd(other), { online: true, queue: d.engine, send: () => sendVisitCheckIn(other) });
    expect(out.kind).toBe("sent");
  });

  it("without usable offline storage: direct send only; a lost request is a retryable error", async () => {
    const payload = checkInPayload();
    const sent = await submitDeviceCommand(checkInCmd(payload), { online: true, queue: null, send: () => sendVisitCheckIn(payload) });
    expect(sent.kind).toBe("sent");
    const lost = await submitDeviceCommand(checkInCmd(checkInPayload(VISIT_2)), {
      online: false,
      queue: null,
      send: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(lost).toEqual({ kind: "error", code: "UNAVAILABLE", messageKey: "UNAVAILABLE", retryable: true });
  });

  it("storage failures fall back safely", async () => {
    const payload = checkInPayload();
    const broken: DeviceQueue = {
      list: async () => {
        throw new Error("IndexedDB gone");
      },
      enqueue: async () => {
        throw new Error("unreachable");
      },
    };
    expect((await submitDeviceCommand(checkInCmd(payload), { online: true, queue: broken, send: () => sendVisitCheckIn(payload) })).kind).toBe("sent");

    const full: DeviceQueue = {
      list: async () => [],
      enqueue: async () => {
        throw new Error("QuotaExceededError");
      },
    };
    const out = await submitDeviceCommand(checkInCmd(checkInPayload(VISIT_2)), { online: false, queue: full, send: () => sendVisitCheckIn(payload) });
    expect(out).toEqual({ kind: "error", code: "UNAVAILABLE", messageKey: "UNAVAILABLE", retryable: true });
  });
});

describe("queued field commands sync exactly once", () => {
  it("an offline check-in syncs once, through the online server action, with the tap-time fix", async () => {
    const d = device(USER_A, now);
    const payload = checkInPayload();
    await submitDeviceCommand(checkInCmd(payload), { online: false, queue: d.engine, send: () => sendVisitCheckIn(payload) });

    t += 2 * 60 * 60_000; // back online two hours later
    const report = await d.engine.sync();
    expect(report).toMatchObject({ done: 1, replayed: 0, failed: 0 });
    expect(server.calls).toEqual([
      {
        name: "visit_check_in",
        args: {
          p_visit_id: VISIT,
          p_customer_id: CUSTOMER,
          p_lat: FIX.lat,
          p_lng: FIX.lng,
          p_accuracy_m: FIX.accuracyM,
          p_captured_at: FIX.capturedAt, // the device time of the tap, not the sync time
          p_device: { platform: "web", consent_version: expect.any(String) },
        },
      },
    ]);
    const [item] = await d.queue.list();
    expect(item).toMatchObject({ status: "done", result: { verification_status: "verified", anomaly_flags: ["late_sync"], replayed: false } });
    expect(asCheckInResult(item?.result)).toMatchObject({ visit_id: VISIT, verification_status: "verified" });

    expect((await d.engine.sync()).done).toBe(0); // nothing left to send
    expect(server.calls).toHaveLength(1);
  });

  it("an answer lost after the commit is re-sent and answers 'replayed'; applied once", async () => {
    const d = device(USER_A, now);
    const payload = checkInPayload();
    await d.engine.enqueue({ command: CHECK_IN, id: VISIT, args: payload as unknown as JsonObject, groupKey: VISIT });
    server.failNext("lost");
    const report = await d.engine.sync();
    expect(report).toMatchObject({ done: 1, replayed: 1, failed: 0 });
    expect(server.calls).toHaveLength(2);
    expect(server.checkIns.size).toBe(1);
    expect((await d.queue.get(VISIT))?.result).toMatchObject({ replayed: true });
  });

  it("replaying the same item (a tab killed mid-send) succeeds as 'replayed'", async () => {
    const d = device(USER_A, now);
    const payload = checkInPayload();
    await d.engine.enqueue({ command: CHECK_IN, id: VISIT, args: payload as unknown as JsonObject, groupKey: VISIT });
    await d.queue.markSyncing(VISIT);
    await visitCheckIn(payload); // that send reached the server before the tab died

    const report = await d.engine.sync();
    expect(report).toMatchObject({ done: 1, replayed: 1 });
    expect(server.checkIns.size).toBe(1);
  });

  it("a rolled-back attempt is retried in the same run; applied once", async () => {
    const d = device(USER_A, now);
    const payload = checkInPayload();
    await d.engine.enqueue({ command: CHECK_IN, id: VISIT, args: payload as unknown as JsonObject, groupKey: VISIT });
    server.failNext("rolledBack");
    const report = await d.engine.sync();
    expect(report).toMatchObject({ done: 1, replayed: 0 });
    expect(server.calls).toHaveLength(2);
  });

  it("a business error at sync time marks the item failed, is not retried, and holds the visit's check-out", async () => {
    const d = device(USER_A, now);
    const ci = checkInPayload();
    await d.engine.enqueue({ command: CHECK_IN, id: VISIT, args: ci as unknown as JsonObject, groupKey: VISIT });
    const co = checkOutPayload();
    await d.engine.enqueue({ command: CHECK_OUT, id: deviceQueueId(CHECK_OUT, VISIT), args: co as unknown as JsonObject, groupKey: VISIT });
    server.failNext({ code: "PERMISSION_DENIED", messageKey: "PERMISSION_DENIED" });

    const report = await d.engine.sync();
    expect(report).toMatchObject({ done: 0, failed: 1, held: 1 });
    expect(server.calls).toHaveLength(1);
    const [checkIn, checkOut] = await d.queue.list();
    expect(checkIn).toMatchObject({ status: "failed", lastError: { code: "PERMISSION_DENIED", messageKey: "PERMISSION_DENIED" } });
    expect(checkOut?.status).toBe("pending");
    expect(queuedView(checkIn)).toBe("attention");
    expect(queuedView(checkOut)).toBe("waiting");
  });

  it("a queued task completion syncs once; a replay answers 'replayed'", async () => {
    const d = device(USER_A, now);
    const payload = completeTaskSchema.parse({ task_id: TASK, outcome: "  Price list sent  " });
    const cmd: DeviceCommand = { command: COMPLETE_TASK, id: deviceQueueId(COMPLETE_TASK, TASK), args: payload, groupKey: `task:${TASK}` };
    const out = await submitDeviceCommand<CompleteTaskResult>(cmd, { online: false, queue: d.engine, send: () => sendCompleteTask(payload) });
    expect(out.kind).toBe("queued");
    server.failNext("lost");
    expect(await d.engine.sync()).toMatchObject({ done: 1, replayed: 1 });
    expect(server.calls.map((c) => c.args)).toEqual([
      { p_task_id: TASK, p_outcome: "Price list sent" },
      { p_task_id: TASK, p_outcome: "Price list sent" },
    ]);
    expect(server.doneTasks.size).toBe(1);
  });
});

describe("per-user isolation", () => {
  it("a rep's saved commands are never seen or sent by another user on the same device", async () => {
    const a = device(USER_A, now);
    const b = device(USER_B, now);
    const payload = checkInPayload();
    await submitDeviceCommand(checkInCmd(payload), { online: false, queue: a.engine, send: () => sendVisitCheckIn(payload) });

    expect(await b.queue.list()).toEqual([]);
    expect(await b.engine.sync()).toMatchObject({ done: 0 });
    expect(server.calls).toEqual([]);

    // B taps the same planned visit: B's own queue decides, A's item does not short-circuit it.
    const send = direct(() => sendVisitCheckIn(payload));
    expect((await submitDeviceCommand(checkInCmd(payload), { online: true, queue: b.engine, send })).kind).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);

    const report = await a.engine.sync();
    expect(report).toMatchObject({ done: 1, replayed: 1 }); // the server dedupes on the visit id anyway
    expect(server.checkIns.size).toBe(1);
    expect((await a.queue.list()).every((i: QueueItem) => i.userId === USER_A)).toBe(true);
  });
});

describe("queued payloads match the server actions' schemas", () => {
  const roundTrip = async (cmd: DeviceCommand) => {
    const d = device(USER_A, now);
    await submitDeviceCommand(cmd, { online: false, queue: d.engine, send: async () => ({ ok: false, code: "X", messageKey: "UNKNOWN", retryable: false }) });
    return (await d.queue.get(cmd.id))?.args;
  };

  it("check-in, with a fix and without one", async () => {
    for (const payload of [checkInPayload(), checkInPayload(VISIT_2, null)]) {
      const stored = await roundTrip(checkInCmd(payload));
      expect(stored).toEqual(payload);
      const parsed = checkInSchema.safeParse(stored);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual(payload);
    }
    const noFix = await roundTrip(checkInCmd(checkInPayload(VISIT, null)));
    expect(noFix).toMatchObject({ lat: null, lng: null, accuracy_m: null, captured_at: new Date(TAP).toISOString(), device: { platform: "web", geo_error: "skipped" } });
  });

  it("check-out", async () => {
    const payload = checkOutPayload();
    const stored = await roundTrip(checkOutCmd(payload));
    expect(stored).toEqual(payload);
    expect(checkOutSchema.safeParse(stored).success).toBe(true);
    expect(stored).toMatchObject({ notes: "synthetic note", lat: null, captured_at: new Date(TAP + 30 * 60_000).toISOString() });
  });

  it("task completion", async () => {
    const payload = completeTaskSchema.parse({ task_id: TASK, outcome: "Synthetic outcome" });
    const stored = await roundTrip({ command: COMPLETE_TASK, id: deviceQueueId(COMPLETE_TASK, TASK), args: payload, groupKey: null });
    expect(completeTaskSchema.safeParse(stored)).toMatchObject({ success: true, data: payload });
    expect(completeTaskSchema.safeParse({ ...payload, extra: 1 }).success).toBe(false); // strict: nothing else rides along
  });

  it("the server actions accept exactly the stored payloads", async () => {
    expect((await visitCheckIn(checkInPayload())).ok).toBe(true);
    expect((await visitCheckOut(checkOutPayload())).ok).toBe(true);
    expect((await completeTask({ task_id: TASK, outcome: "Synthetic outcome" })).ok).toBe(true);
    expect(await completeTask({ task_id: TASK, outcome: " " })).toEqual({ ok: false, code: "VALIDATION", messageKey: "REASON_REQUIRED", retryable: false });
  });
});

describe("sender registration", () => {
  it("registers check-in, check-out and task completion (idempotent), not the exception request", () => {
    const registry = createSenderRegistry();
    const off = registerFieldSenders(registry.register);
    for (const command of [CHECK_IN, CHECK_OUT, COMPLETE_TASK]) expect(registry.get(command)?.idempotent).toBe(true);
    expect(registry.get("field.request_visit_exception")).toBeUndefined();
    expect(registry.get("field.visit_exception")).toBeUndefined();
    off();
    expect(registry.get(CHECK_IN)).toBeUndefined();
  });

  it.each(["ar", "en"])("every queued command has a label on the sync screen (%s)", (locale) => {
    const m = JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "offline.json"), "utf8")) as { commands: Record<string, Record<string, string>> };
    for (const command of [CHECK_IN, CHECK_OUT, COMPLETE_TASK]) {
      const [group, key] = command.split(".");
      expect(m.commands[group ?? ""]?.[key ?? ""]).toBeTypeOf("string");
    }
  });

  it("a stored check-out replays through its sender with the payload's own visit id", async () => {
    const registry = createSenderRegistry();
    registerFieldSenders(registry.register);
    await visitCheckIn(checkInPayload());
    const sender = registry.get(CHECK_OUT)!;
    const id = deviceQueueId(CHECK_OUT, VISIT);
    const result = await sender.send(checkOutPayload() as unknown as JsonObject, { id, createdAt: new Date(TAP).toISOString(), attempt: 1 });
    expect(result).toEqual({ ok: true, data: expect.objectContaining({ visit_id: VISIT, replayed: false }) as CheckOutResult });
    expect(server.calls.at(-1)?.args.p_visit_id).toBe(VISIT);
  });
});

describe("pure helpers", () => {
  it("deviceToSendResult keeps the code, and marks UNAVAILABLE ambiguous", () => {
    expect(deviceToSendResult({ ok: true, data: { replayed: true } })).toEqual({ ok: true, data: { replayed: true } });
    expect(deviceToSendResult({ ok: false, code: "UNAVAILABLE", messageKey: "UNAVAILABLE", retryable: true, requestId: "req-1" })).toEqual({
      ok: false,
      error: { code: "UNAVAILABLE", messageKey: "UNAVAILABLE", retryable: false, ambiguous: true, requestId: "req-1" },
    });
    expect(deviceToSendResult({ ok: false, code: "INVALID_STATE", messageKey: "INVALID_STATE", retryable: false })).toEqual({
      ok: false,
      error: { code: "INVALID_STATE", messageKey: "INVALID_STATE", retryable: false, ambiguous: false },
    });
  });

  it("nameBasedId is a stable, well-formed version 8 UUID", () => {
    const id = nameBasedId("field.visit_check_out:" + VISIT);
    expect(id).toMatch(UUID);
    expect(id[14]).toBe("8");
    expect("89ab").toContain(id[19] as string);
    expect(nameBasedId("field.visit_check_out:" + VISIT)).toBe(id);
    const many = new Set(Array.from({ length: 2000 }, (_, i) => nameBasedId(`work.complete_task:${i}`)));
    expect(many.size).toBe(2000);
  });

  it("deviceQueueId: check-in uses the visit id (its client ref); the others derive distinct ids", () => {
    expect(deviceQueueId(CHECK_IN, VISIT)).toBe(VISIT);
    const out = deviceQueueId(CHECK_OUT, VISIT);
    expect(out).toMatch(UUID);
    expect(out).not.toBe(VISIT);
    expect(deviceQueueId(COMPLETE_TASK, VISIT)).not.toBe(out);
    expect(deviceQueueId(CHECK_OUT, VISIT_2)).not.toBe(out);
  });

  it("queuedView", () => {
    const base = { status: "pending", flag: null, staleAcknowledged: false } as QueueItem;
    expect(queuedView(undefined)).toBe("none");
    expect(queuedView(base)).toBe("waiting");
    expect(queuedView({ ...base, status: "syncing" })).toBe("waiting");
    expect(queuedView({ ...base, status: "done" })).toBe("synced");
    expect(queuedView({ ...base, status: "failed" })).toBe("attention");
    expect(queuedView({ ...base, status: "conflict" })).toBe("attention");
    expect(queuedView({ ...base, flag: "stale" })).toBe("attention");
    expect(queuedView({ ...base, flag: "stale", staleAcknowledged: true })).toBe("waiting");
  });

  it("asCheckInResult and checkedOutParam read stored server answers defensively", () => {
    expect(asCheckInResult({ visit_id: VISIT, verification_status: "out_of_range", distance_m: 400, replayed: false })).not.toBeNull();
    expect(asCheckInResult({ visit_id: VISIT, verification_status: "bogus" })).toBeNull();
    expect(asCheckInResult(null)).toBeNull();
    expect(asCheckInResult([1])).toBeNull();
    expect(checkedOutParam({ follow_up_task_id: TASK })).toBe("followUp");
    expect(checkedOutParam({ follow_up_task_id: null })).toBe("1");
    expect(checkedOutParam(null)).toBe("1");
  });
});
