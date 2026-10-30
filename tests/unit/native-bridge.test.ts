import { describe, expect, it } from "vitest";
import {
  backgroundGeolocation,
  isNativeShell,
  nativeProblemOf,
  openNativeAppSettings,
  removeStaleWatcher,
  stopNativeTracking,
  toFix,
  watchPosition,
  WATCHER_KEY,
  type WatcherStorage,
} from "@/lib/native/background-geolocation";
import { createFakeBackgroundGeolocation, fakeNativeWindow } from "@/lib/native/fake";

function memory(): WatcherStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const options = { backgroundTitle: "t", backgroundMessage: "m", requestPermissions: true, stale: false, distanceFilter: 0 };

describe("native shell detection", () => {
  it("is false on the server, in a plain browser and when Capacitor is not native", () => {
    expect(isNativeShell(undefined)).toBe(false);
    expect(isNativeShell({})).toBe(false);
    expect(isNativeShell({ Capacitor: { isNativePlatform: () => false } })).toBe(false);
    expect(isNativeShell({ Capacitor: {} })).toBe(false);
    expect(isNativeShell({ Capacitor: { isNativePlatform: () => { throw new Error("x"); } } })).toBe(false);
    expect(backgroundGeolocation(undefined)).toBeNull();
    expect(backgroundGeolocation(fakeNativeWindow(createFakeBackgroundGeolocation(), false))).toBeNull();
  });
  it("finds the plugin only in the native shell, and only when it has the watcher methods", () => {
    const plugin = createFakeBackgroundGeolocation();
    expect(isNativeShell(fakeNativeWindow(plugin))).toBe(true);
    expect(backgroundGeolocation(fakeNativeWindow(plugin))).toBe(plugin);
    expect(backgroundGeolocation(fakeNativeWindow(null))).toBeNull();
    expect(backgroundGeolocation({ Capacitor: { isNativePlatform: () => true, Plugins: { BackgroundGeolocation: { addWatcher: 1 } } } })).toBeNull();
  });
});

describe("plugin answers", () => {
  it("maps NOT_AUTHORIZED to a refused permission or switched-off location, anything else to unavailable", () => {
    expect(nativeProblemOf({ code: "NOT_AUTHORIZED", message: "User denied location permission" })).toBe("denied");
    expect(nativeProblemOf({ code: "NOT_AUTHORIZED", message: "Location services disabled." })).toBe("services_off");
    expect(nativeProblemOf({ message: "Service not running." })).toBe("unavailable");
    expect(nativeProblemOf(null)).toBe("unavailable");
  });
  it("keeps the fix's own capture time, and the device time only when the fix has none", () => {
    expect(toFix({ latitude: 30.05, longitude: 31.24, accuracy: 7, time: 1_000 }, 5_000)).toEqual({ lat: 30.05, lng: 31.24, accuracy: 7, timestampMs: 1_000 });
    expect(toFix({ latitude: 30.05, longitude: 31.24, accuracy: null, time: null }, 5_000)).toEqual({ lat: 30.05, lng: 31.24, accuracy: null, timestampMs: 5_000 });
    expect(toFix({ latitude: Number.NaN, longitude: 31.24, accuracy: 1, time: 1 }, 5_000)).toBeNull();
    expect(toFix(null, 5_000)).toBeNull();
  });
});

describe("watchPosition", () => {
  it("adds one watcher, persists its id, and removes it on stop", async () => {
    const plugin = createFakeBackgroundGeolocation();
    const storage = memory();
    const seen: unknown[] = [];
    const watch = watchPosition(plugin, options, (location) => seen.push(location), storage);
    await flush();
    expect(plugin.calls).toEqual(["add:w1"]);
    expect(plugin.watchers.get("w1")?.options).toEqual(options);
    expect(storage.map.get(WATCHER_KEY)).toBe("w1");
    plugin.emit({ latitude: 30, longitude: 31 });
    expect(seen).toHaveLength(1);
    await watch.stop();
    await watch.stop(); // idempotent
    expect(plugin.calls).toEqual(["add:w1", "remove:w1"]);
    expect(plugin.watchers.size).toBe(0);
    expect(storage.map.has(WATCHER_KEY)).toBe(false);
    plugin.emit({ latitude: 30, longitude: 31 });
    expect(seen).toHaveLength(1);
  });
  it("removes a watcher left by an earlier page before adding a new one", async () => {
    const plugin = createFakeBackgroundGeolocation();
    const storage = memory();
    storage.setItem(WATCHER_KEY, "stale-1");
    const watch = watchPosition(plugin, options, () => undefined, storage);
    await flush();
    expect(plugin.calls).toEqual(["remove:stale-1", "add:w1"]);
    expect(storage.map.get(WATCHER_KEY)).toBe("w1");
    await watch.stop();
  });
  it("a stop before the id is known still removes the watcher", async () => {
    const plugin = createFakeBackgroundGeolocation();
    const storage = memory();
    const watch = watchPosition(plugin, options, () => undefined, storage);
    await watch.stop();
    await flush();
    expect(plugin.watchers.size).toBe(0);
    expect(storage.map.has(WATCHER_KEY)).toBe(false);
  });
  it("accepts the legacy proxy's synchronous id", async () => {
    const plugin = createFakeBackgroundGeolocation({ syncIds: true });
    const storage = memory();
    const watch = watchPosition(plugin, options, () => undefined, storage);
    await flush();
    expect(storage.map.get(WATCHER_KEY)).toBe("w1");
    await watch.stop();
    expect(plugin.watchers.size).toBe(0);
  });
  it("a rejected add is reported through the callback, and nothing is persisted", async () => {
    const plugin = createFakeBackgroundGeolocation();
    plugin.rejectNextAdd({ message: "Service not running." });
    const storage = memory();
    const errors: unknown[] = [];
    watchPosition(plugin, options, (_l, error) => errors.push(error), storage);
    await flush();
    expect(errors).toEqual([{ message: "Service not running." }]);
    expect(storage.map.has(WATCHER_KEY)).toBe(false);
  });
});

describe("stopping and settings", () => {
  it("stopNativeTracking removes the persisted watcher in the shell and does nothing in a browser", async () => {
    const plugin = createFakeBackgroundGeolocation();
    const storage = memory();
    storage.setItem(WATCHER_KEY, "w9");
    await stopNativeTracking(fakeNativeWindow(plugin, false), storage);
    expect(plugin.calls).toEqual([]);
    await stopNativeTracking(fakeNativeWindow(plugin), storage);
    expect(plugin.calls).toEqual(["remove:w9"]);
    expect(storage.map.has(WATCHER_KEY)).toBe(false);
    await removeStaleWatcher(plugin, storage); // nothing left
    expect(plugin.calls).toEqual(["remove:w9"]);
  });
  it("opens the app settings only in the shell", async () => {
    const plugin = createFakeBackgroundGeolocation();
    expect(await openNativeAppSettings(fakeNativeWindow(plugin))).toBe(true);
    expect(plugin.calls).toEqual(["settings"]);
    expect(await openNativeAppSettings({})).toBe(false);
  });
});
