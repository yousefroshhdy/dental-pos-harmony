import { describe, expect, it } from "vitest";
import type { WatcherStorage } from "@/lib/native/background-geolocation";
import { WATCHER_KEY } from "@/lib/native/background-geolocation";
import { createFakeBackgroundGeolocation } from "@/lib/native/fake";
import type { Sample } from "@/modules/tracking/collector";
import { parseState, type CollectorProblem } from "@/modules/tracking/device-store";
import { nativeProblemKey, toPing } from "@/modules/tracking/logic";
import { NATIVE_RETRY, nativeWatcherOptions, startNativeCollector, type NativeCollectorDeps } from "@/modules/tracking/native-collector";
import { recordPingsSchema } from "@/modules/tracking/schemas";

// Synthetic positions only (D-03).
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const MIN = 60_000;

function memory(): WatcherStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

function harness(overrides: Partial<NativeCollectorDeps> = {}) {
  const plugin = createFakeBackgroundGeolocation();
  const storage = memory();
  const samples: Sample[] = [];
  const problems: (CollectorProblem | null)[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let now = Date.parse("2026-11-02T07:00:00Z");
  let last: number | null = null;
  let active = true;
  const deps: NativeCollectorDeps = {
    plugin,
    storage,
    intervalMs: 5 * MIN,
    now: () => now,
    lastSampleMs: () => last,
    isActive: () => active,
    notification: { title: "Honest OS: working day", message: "Honest OS is recording your location for your working day." },
    onSample: (s) => {
      samples.push(s);
      last = now;
    },
    onProblem: (p) => problems.push(p),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => undefined,
    ...overrides,
  };
  return {
    plugin,
    storage,
    samples,
    problems,
    timers,
    deps,
    advance: (ms: number) => (now += ms),
    now: () => now,
    setActive: (v: boolean) => (active = v),
  };
}

describe("native collector", () => {
  it("starts one watcher with the notification texts, permissions requested, fresh fixes and no distance filter", async () => {
    const h = harness();
    const stop = startNativeCollector(h.deps);
    await flush();
    expect([...h.plugin.watchers.values()].map((w) => w.options)).toEqual([
      {
        backgroundTitle: "Honest OS: working day",
        backgroundMessage: "Honest OS is recording your location for your working day.",
        requestPermissions: true,
        stale: false,
        distanceFilter: 0,
      },
    ]);
    expect(nativeWatcherOptions({ title: "a", message: "b" })).toMatchObject({ backgroundTitle: "a", backgroundMessage: "b" });
    expect(h.storage.map.get(WATCHER_KEY)).toBe("w1");
    stop();
    await flush();
    expect(h.plugin.watchers.size).toBe(0);
    expect(h.storage.map.has(WATCHER_KEY)).toBe(false);
  });

  it("keeps one point per sampling interval from the one-per-second fixes, with each fix's capture time", async () => {
    const h = harness();
    startNativeCollector(h.deps);
    await flush();
    const t0 = h.now();
    h.plugin.emit({ latitude: 30.0444, longitude: 31.2357, accuracy: 6, time: t0 - 800 });
    for (let i = 0; i < 120; i++) {
      h.advance(1_000);
      h.plugin.emit({ latitude: 30.0444, longitude: 31.2357, accuracy: 6, time: h.now() - 800 });
    }
    expect(h.samples).toHaveLength(1);
    expect(h.samples[0]).toEqual({ lat: 30.0444, lng: 31.2357, accuracy: 6, timestampMs: t0 - 800 });
    h.advance(5 * MIN);
    h.plugin.emit({ latitude: 30.05, longitude: 31.24, accuracy: null, time: null });
    expect(h.samples).toHaveLength(2);
    expect(h.samples[1]).toEqual({ lat: 30.05, lng: 31.24, accuracy: null, timestampMs: h.now() });
    expect(h.problems).toEqual([null]);
  });

  it("never collects without an open shift: the watcher removes itself when the shift stops collecting", async () => {
    const h = harness();
    startNativeCollector(h.deps);
    await flush();
    h.setActive(false);
    h.plugin.emit({ latitude: 30, longitude: 31 });
    await flush();
    expect(h.samples).toHaveLength(0);
    expect(h.plugin.watchers.size).toBe(0);
    expect(h.plugin.calls).toEqual(["add:w1", "remove:w1"]);
  });

  it("a refused permission is reported and the watcher is kept (Android restarts it once allowed)", async () => {
    const h = harness();
    startNativeCollector(h.deps);
    await flush();
    h.plugin.fail({ code: "NOT_AUTHORIZED", message: "User denied location permission" });
    h.plugin.fail({ code: "NOT_AUTHORIZED", message: "User denied location permission" });
    expect(h.problems).toEqual(["denied"]);
    expect(h.plugin.watchers.size).toBe(1);
    expect(h.timers).toHaveLength(0);
    h.plugin.emit({ latitude: 30, longitude: 31 });
    expect(h.problems).toEqual(["denied", null]);
    expect(h.samples).toHaveLength(1);
  });

  it("switched-off location is its own problem", async () => {
    const h = harness();
    startNativeCollector(h.deps);
    await flush();
    h.plugin.fail({ code: "NOT_AUTHORIZED", message: "Location services disabled." });
    expect(h.problems).toEqual(["services_off"]);
  });

  it("any other failure restarts the watcher a few times", async () => {
    const h = harness();
    h.plugin.rejectNextAdd({ message: "Service not running." });
    startNativeCollector(h.deps);
    await flush();
    expect(h.problems).toEqual(["unavailable"]);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(NATIVE_RETRY.delayMs);
    h.timers[0]!.fn();
    await flush();
    expect(h.plugin.watchers.size).toBe(1);
    for (let i = 0; i < NATIVE_RETRY.max + 2; i++) {
      const before = h.timers.length;
      h.plugin.fail({ message: "boom" });
      await flush();
      if (h.timers.length > before) {
        h.timers.at(-1)!.fn();
        await flush();
      }
    }
    expect(h.timers).toHaveLength(NATIVE_RETRY.max);
    expect(h.plugin.watchers.size).toBe(1); // the old watcher is removed before each retry
  });

  it("a stop removes the watcher and ignores later fixes", async () => {
    const h = harness();
    const stop = startNativeCollector(h.deps);
    await flush();
    stop();
    stop();
    await flush();
    h.plugin.emit({ latitude: 30, longitude: 31 });
    expect(h.samples).toHaveLength(0);
    expect(h.plugin.calls).toEqual(["add:w1", "remove:w1"]);
  });
});

describe("native points in the shared pipeline", () => {
  it("are labelled native (advisory), browser points stay pwa", () => {
    const base = { id: "00000000-0000-4000-8000-000000000101", lat: 30.04441234, lng: 31.2357, accuracy: 5, timestampMs: Date.parse("2026-11-02T07:00:00Z") };
    expect(toPing({ ...base, source: "native" })).toMatchObject({ source: "native", lat: 30.044412, captured_at: "2026-11-02T07:00:00.000Z" });
    expect(toPing(base).source).toBe("pwa");
  });
  it("the upload schema accepts pwa and native, nothing else", () => {
    const ping = { id: "00000000-0000-4000-8000-000000000102", lat: 30.04, lng: 31.23, accuracy_m: null, captured_at: "2026-11-02T07:00:00Z" };
    expect(recordPingsSchema.safeParse({ pings: [{ ...ping, source: "native" }] }).success).toBe(true);
    expect(recordPingsSchema.safeParse({ pings: [{ ...ping, source: "pwa" }] }).success).toBe(true);
    expect(recordPingsSchema.safeParse({ pings: [{ ...ping, source: "gps" }] }).success).toBe(false);
  });
  it("a buffered native point survives a reload with its source", () => {
    const raw = JSON.stringify({ buffer: [{ id: "p1", lat: 30, lng: 31, accuracy_m: null, captured_at: "2026-11-02T07:00:00.000Z", source: "native" }] });
    expect(parseState(raw).buffer[0]?.source).toBe("native");
    expect(parseState(raw.replace("native", "other")).buffer[0]?.source).toBe("pwa");
  });
  it("collector problems map to the shell's guidance", () => {
    expect(nativeProblemKey("denied")).toBe("denied");
    expect(nativeProblemKey("services_off")).toBe("services_off");
    expect(nativeProblemKey("timeout")).toBe("unavailable");
    expect(nativeProblemKey("insecure")).toBe("unavailable");
  });
});
