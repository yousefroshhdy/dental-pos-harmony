import { describe, expect, it } from "vitest";
import { browserGeoPermission, nativeAppVersion, queuedPointCount } from "@/modules/tracking/device-info";
import { TRACKING_QUEUED_COMMANDS } from "@/modules/tracking/logic";

const shell = (plugins: Record<string, unknown>) => ({ Capacitor: { isNativePlatform: () => true, Plugins: plugins } });

describe("nativeAppVersion (Capacitor App plugin, when the shell has it)", () => {
  it("is null in the current pilot shell (no App plugin) and in a browser", async () => {
    expect(await nativeAppVersion(shell({ BackgroundGeolocation: {} }))).toBeNull();
    expect(await nativeAppVersion(undefined)).toBeNull();
    expect(await nativeAppVersion({})).toBeNull();
  });

  it("reads version and build when the plugin answers", async () => {
    expect(await nativeAppVersion(shell({ App: { getInfo: async () => ({ version: "1.0", build: 7 }) } }))).toBe("1.0+7");
    expect(await nativeAppVersion(shell({ App: { getInfo: async () => ({ version: "1.2.0" }) } }))).toBe("1.2.0");
  });

  it("never throws and never waits long (refused or hanging bridge call)", async () => {
    expect(await nativeAppVersion(shell({ App: { getInfo: () => Promise.reject(new Error("refused")) } }))).toBeNull();
    expect(await nativeAppVersion(shell({ App: { getInfo: () => new Promise(() => undefined) } }), 20)).toBeNull();
    expect(await nativeAppVersion(shell({ App: { getInfo: () => { throw new Error("sync"); } } }))).toBeNull();
    expect(await nativeAppVersion(shell({ App: { getInfo: async () => ({ version: 3 }) } }))).toBeNull();
  });
});

describe("browserGeoPermission (Permissions API)", () => {
  it("answers the three states", async () => {
    for (const state of ["granted", "denied", "prompt"] as const) {
      expect(await browserGeoPermission({ permissions: { query: async () => ({ state }) } })).toBe(state);
    }
  });

  it("is null where it cannot be asked", async () => {
    expect(await browserGeoPermission(undefined)).toBeNull();
    expect(await browserGeoPermission({})).toBeNull();
    expect(await browserGeoPermission({ permissions: { query: () => Promise.reject(new TypeError("unsupported")) } })).toBeNull();
    expect(await browserGeoPermission({ permissions: { query: async () => ({ state: "weird" }) } })).toBeNull();
    expect(await browserGeoPermission({ permissions: { query: () => new Promise(() => undefined) } }, 20)).toBeNull();
  });
});

describe("queuedPointCount", () => {
  it("counts points of unsent ping batches only", () => {
    const items = [
      { command: TRACKING_QUEUED_COMMANDS.recordPings, status: "pending", args: { pings: [{}, {}, {}] } },
      { command: TRACKING_QUEUED_COMMANDS.recordPings, status: "failed", args: { pings: [{}] } },
      { command: TRACKING_QUEUED_COMMANDS.recordPings, status: "done", args: { pings: [{}, {}] } },
      { command: TRACKING_QUEUED_COMMANDS.startShift, status: "pending", args: {} },
      { command: TRACKING_QUEUED_COMMANDS.recordPings, status: "pending", args: { pings: "bad" } },
    ] as const;
    expect(queuedPointCount(items as never)).toBe(4);
    expect(queuedPointCount([])).toBe(0);
  });
});
