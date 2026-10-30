import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { releaseIdleNativeWatcher, watchPosition, WATCHER_KEY, type WatcherStorage } from "@/lib/native/background-geolocation";
import { createFakeBackgroundGeolocation, fakeNativeWindow } from "@/lib/native/fake";

// F4 (audit 4): a native watcher left by an earlier page (full reload, the offline page,
// a reload overnight) kept the GPS and the "recording your location" notification on
// while the new page was not collecting. Synthetic data only (D-03).

function memory(): WatcherStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const options = { backgroundTitle: "t", backgroundMessage: "m", requestPermissions: true, stale: false, distanceFilter: 0 };

describe("a page that is not collecting", () => {
  it("removes the watcher an earlier page left running (its callback is gone after a full load)", async () => {
    const plugin = createFakeBackgroundGeolocation();
    const storage = memory();
    // Page A, collecting: adds the watcher and persists its id; then the WebView does a full
    // load, so page A never calls stop() and the plugin keeps the watcher.
    watchPosition(plugin, options, () => undefined, storage);
    await flush();
    expect(plugin.watchers.size).toBe(1);

    // Page B, not collecting (the shift ended elsewhere, or passed its maximum length).
    await releaseIdleNativeWatcher(false, fakeNativeWindow(plugin), storage);
    expect(plugin.watchers.size).toBe(0);
    expect(plugin.calls).toEqual(["add:w1", "remove:w1"]);
    expect(storage.map.has(WATCHER_KEY)).toBe(false);

    // Idempotent: a later render that is still not collecting has nothing left to remove.
    await releaseIdleNativeWatcher(false, fakeNativeWindow(plugin), storage);
    expect(plugin.calls).toEqual(["add:w1", "remove:w1"]);
  });

  it("leaves the watcher alone while the page is collecting (the native collector owns it)", async () => {
    const plugin = createFakeBackgroundGeolocation();
    const storage = memory();
    const watch = watchPosition(plugin, options, () => undefined, storage);
    await flush();
    await releaseIdleNativeWatcher(true, fakeNativeWindow(plugin), storage);
    expect(plugin.watchers.size).toBe(1);
    expect(storage.map.get(WATCHER_KEY)).toBe("w1");
    await watch.stop();
    expect(plugin.watchers.size).toBe(0);
  });

  it("a stop racing the collector's own stop removes the watcher once and never throws", async () => {
    const plugin = createFakeBackgroundGeolocation();
    const storage = memory();
    const watch = watchPosition(plugin, options, () => undefined, storage);
    await flush();
    // The shift stops collecting: the collector's cleanup and the idle release run together.
    await Promise.all([watch.stop(), releaseIdleNativeWatcher(false, fakeNativeWindow(plugin), storage)]);
    expect(plugin.watchers.size).toBe(0);
    expect(storage.map.has(WATCHER_KEY)).toBe(false);
  });

  it("is a no-op in a browser and when the plugin is missing", async () => {
    const plugin = createFakeBackgroundGeolocation();
    const storage = memory();
    storage.setItem(WATCHER_KEY, "w7");
    await releaseIdleNativeWatcher(false, fakeNativeWindow(plugin, false), storage);
    await releaseIdleNativeWatcher(false, fakeNativeWindow(null), storage);
    await releaseIdleNativeWatcher(false, undefined, storage);
    expect(plugin.calls).toEqual([]);
    expect(storage.map.get(WATCHER_KEY)).toBe("w7");
  });

  it("is what the app-wide collector hook runs whenever it is not collecting", () => {
    const source = readFileSync(new URL("../../src/modules/tracking/use-tracking.ts", import.meta.url), "utf8");
    expect(source).toMatch(/useEffect\(\(\) => \{\s*void releaseIdleNativeWatcher\(collecting\);\s*\}, \[collecting\]\);/);
  });
});
