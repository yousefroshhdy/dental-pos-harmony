import { describe, expect, it, vi } from "vitest";

// The tracking server actions are only referenced by the senders, never called here.
vi.mock("@/lib/command", () => ({ callCommand: async () => ({ ok: true, data: null }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { startCollector, type Sample } from "@/modules/tracking/collector";
import { applyStatus, clearOtherUsers, createTrackingStore, EMPTY_STATE, parseState, STORAGE_PREFIX, type KeyValueStorage } from "@/modules/tracking/device-store";
import { TRACKING_QUEUED_COMMANDS } from "@/modules/tracking/logic";
import { registerTrackingSenders } from "@/modules/tracking/offline";
import type { TrackingStatus } from "@/modules/tracking/types";

// Synthetic ids only (D-03).
const USER_A = "00000000-0000-4000-8000-0000000009a1";
const USER_B = "00000000-0000-4000-8000-0000000009b2";

function memoryStorage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("device store", () => {
  it("persists per user and survives a reload; the transient problem is not stored", () => {
    const storage = memoryStorage();
    const store = createTrackingStore(USER_A, storage);
    store.update((s) => ({ ...s, lastSampleMs: 42, problem: "denied" }));
    expect(parseState(storage.getItem(STORAGE_PREFIX + USER_A))).toMatchObject({ lastSampleMs: 42, problem: null });
    expect(createTrackingStore(USER_A, storage).get().lastSampleMs).toBe(42);
  });
  it("malformed storage falls back to the empty state", () => {
    expect(parseState("{nope")).toEqual(EMPTY_STATE);
    expect(parseState(JSON.stringify({ shift: { ref: 1 }, buffer: [{ id: "x" }], intervalS: "x" }))).toEqual(EMPTY_STATE);
  });
  it("wipes every other user's tracking state on a shared device", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_PREFIX + USER_A, "{}");
    storage.setItem(STORAGE_PREFIX + USER_B, "{}");
    storage.setItem("unrelated", "1");
    expect(clearOtherUsers(USER_B, storage)).toBe(1);
    expect([...storage.map.keys()].sort()).toEqual([STORAGE_PREFIX + USER_B, "unrelated"].sort());
  });
  it("takes the settings and the open shift from the server status", () => {
    const status = {
      open_shift: {
        id: "s",
        client_ref: "r",
        status: "open",
        started_at: "2026-10-30T06:00:00Z",
        window_start: "2026-10-30T06:00:00Z",
        max_end_at: "2026-10-30T16:00:00Z",
        overdue: false,
        last_ping_at: null,
        last_ping_received_at: null,
        ping_count: 0,
      },
      settings: { sample_interval_s: 120, max_shift_hours: 8 },
    } as unknown as TrackingStatus;
    const next = applyStatus(EMPTY_STATE, status, 1, Date.parse("2026-10-30T07:00:00Z"));
    expect(next).toMatchObject({ intervalS: 120, maxShiftHours: 8, shift: { ref: "r", confirmed: true } });
  });
});

describe("collector", () => {
  function fakeGeo() {
    const watchers: ((p: GeolocationPosition) => void)[] = [];
    const errors: ((e: GeolocationPositionError) => void)[] = [];
    let cleared = 0;
    let asked = 0;
    const position = (lat: number, ts: number) => ({ coords: { latitude: lat, longitude: 31.2, accuracy: 9 }, timestamp: ts }) as GeolocationPosition;
    return {
      geo: {
        watchPosition: (ok: (p: GeolocationPosition) => void, err?: ((e: GeolocationPositionError) => void) | null) => {
          watchers.push(ok);
          if (err) errors.push(err);
          return 7;
        },
        clearWatch: () => void cleared++,
        getCurrentPosition: (ok: (p: GeolocationPosition) => void) => {
          asked++;
          ok(position(30.5, 9_000_000));
        },
      },
      move: (lat: number, ts: number) => watchers.forEach((w) => w(position(lat, ts))),
      fail: (code: number) => errors.forEach((e) => e({ code } as GeolocationPositionError)),
      cleared: () => cleared,
      asked: () => asked,
    };
  }

  it("keeps at most one point per interval, asks for a fix when nothing moved, and stops cleanly", () => {
    const g = fakeGeo();
    let now = 1_000_000;
    let last: number | null = null;
    const samples: Sample[] = [];
    let tick: () => void = () => undefined;
    const stop = startCollector({
      geolocation: g.geo,
      intervalMs: 300_000,
      now: () => now,
      lastSampleMs: () => last,
      onSample: (s) => {
        samples.push(s);
        last = now;
      },
      onProblem: () => undefined,
      setInterval: (fn) => ((tick = fn), 1),
      clearInterval: () => undefined,
    });
    g.move(30.1, 1_000_000); // first fix: kept
    now += 60_000;
    g.move(30.2, now); // too soon
    now += 300_000;
    tick(); // nothing kept for an interval: one fresh fix is requested
    expect(samples.map((s) => s.lat)).toEqual([30.1, 30.5]);
    expect(g.asked()).toBe(1);
    stop();
    g.move(30.3, now + 600_000);
    expect(samples).toHaveLength(2);
    expect(g.cleared()).toBe(1);
  });

  it("reports why the location is unavailable", () => {
    const problems: (string | null)[] = [];
    startCollector({ geolocation: undefined, intervalMs: 1, now: () => 0, lastSampleMs: () => null, onSample: () => undefined, onProblem: (p) => problems.push(p) });
    startCollector({ geolocation: undefined, isSecureContext: false, intervalMs: 1, now: () => 0, lastSampleMs: () => null, onSample: () => undefined, onProblem: (p) => problems.push(p) });
    const g = fakeGeo();
    startCollector({ geolocation: g.geo, intervalMs: 1, now: () => 0, lastSampleMs: () => null, onSample: () => undefined, onProblem: (p) => problems.push(p), setInterval: () => 1, clearInterval: () => undefined });
    g.fail(1);
    expect(problems).toEqual(["unsupported", "insecure", "denied"]);
  });
});

describe("queue senders", () => {
  it("registers start, end and points, each explicitly idempotent", () => {
    const seen: [string, boolean][] = [];
    registerTrackingSenders((command, _send, opts) => {
      seen.push([command, opts?.idempotent === true]);
      return () => undefined;
    });
    expect(seen.sort()).toEqual(Object.values(TRACKING_QUEUED_COMMANDS).map((c) => [c, true] as [string, boolean]).sort());
  });
});
