import type { NativeWindow } from "@/lib/native/background-geolocation";
import type { QueueItem } from "@/lib/offline/types";
import type { BrowserPermissionState } from "./health";
import { TRACKING_QUEUED_COMMANDS } from "./logic";

/**
 * What the device can tell about itself for the health panel (api.report_device_status).
 * Every probe is optional and bounded: a missing API answers null, never throws, never waits
 * more than a moment. Nothing here identifies the phone (no model, no serial, no user agent).
 */

const isFn = (v: unknown): v is (...args: never[]) => unknown => typeof v === "function";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * The Android shell's version from Capacitor's App plugin (`App.getInfo().version`), when the
 * shell has it. The current pilot APK does not: @capacitor/app is not installed and the guarded
 * bridge allows only the background-location plugin (mobile/README.md), so this answers null and
 * the panel shows the web build instead.
 */
export async function nativeAppVersion(win: NativeWindow | undefined, timeoutMs = 1_500): Promise<string | null> {
  try {
    const app = win?.Capacitor?.Plugins?.App as { getInfo?: () => Promise<{ version?: unknown; build?: unknown }> } | undefined;
    if (!app || !isFn(app.getInfo)) return null;
    const info = await withTimeout(Promise.resolve(app.getInfo()), timeoutMs);
    if (!info) return null;
    const version = typeof info.version === "string" ? info.version : null;
    const build = typeof info.build === "string" || typeof info.build === "number" ? String(info.build) : null;
    return version ? (build ? `${version}+${build}` : version) : null;
  } catch {
    return null;
  }
}

type PermissionsLike = { query(descriptor: { name: string }): Promise<{ state: string }> };

/** The browser's geolocation permission (Permissions API), or null where it cannot be asked. */
export async function browserGeoPermission(nav: { permissions?: PermissionsLike } | undefined, timeoutMs = 1_500): Promise<BrowserPermissionState> {
  try {
    const permissions = nav?.permissions;
    if (!permissions || !isFn(permissions.query)) return null;
    const status = await withTimeout(permissions.query({ name: "geolocation" }), timeoutMs);
    const state = status?.state;
    return state === "granted" || state === "denied" || state === "prompt" ? state : null;
  } catch {
    return null;
  }
}

/** Points handed to the offline queue and not yet confirmed by the server. */
export function queuedPointCount(items: readonly Pick<QueueItem, "command" | "status" | "args">[]): number {
  let n = 0;
  for (const item of items) {
    if (item.command !== TRACKING_QUEUED_COMMANDS.recordPings || item.status === "done") continue;
    const pings = (item.args as { pings?: unknown }).pings;
    if (Array.isArray(pings)) n += pings.length;
  }
  return n;
}
