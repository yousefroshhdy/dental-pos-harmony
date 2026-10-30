/**
 * Typed bridge to the Android shell's background-location plugin (D-14 phase 2).
 *
 * The web app adds NO dependency for this: inside the Capacitor shell (mobile/), the
 * native side injects `window.Capacitor`, and every native plugin is reachable as
 * `window.Capacitor.Plugins.<Name>`. In a normal browser `window.Capacitor` is absent and
 * every function here answers "not native" / null, so the browser collector is used.
 *
 * Plugin: @capacitor-community/background-geolocation (MIT), API as of 1.3.1:
 *   addWatcher(options, callback) → watcher id (a Promise through @capacitor/core, the bare
 *     id string through the injected legacy proxy; both are accepted here)
 *   removeWatcher({ id }), openSettings()
 *   callback(location?, error?) with error.code "NOT_AUTHORIZED" when permission is denied
 *   or the device's location services are off.
 *
 * Native watchers outlive a page reload (the plugin's service keeps them, while the page's
 * callback is gone), so the active watcher id is kept in localStorage and removed before
 * a new one is added, whenever a page is not collecting (releaseIdleNativeWatcher), and on
 * the login page (stopNativeTracking).
 *
 * Nothing the native shell sends is trusted more than the browser: the server treats a
 * point's `source` as advisory only (migration 20261102000100).
 */

export interface NativeWatcherOptions {
  /** Text of the permanent notification; setting it is what keeps updates coming in the background. */
  backgroundMessage?: string;
  backgroundTitle?: string;
  requestPermissions?: boolean;
  stale?: boolean;
  distanceFilter?: number;
}

export interface NativeLocation {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  /** The OS says a mock-location app produced this fix (advisory, not sent to the server yet). */
  simulated?: boolean;
  bearing?: number | null;
  speed?: number | null;
  /** Capture time in ms since the epoch. */
  time: number | null;
}

export interface NativeCallbackError {
  message?: string;
  code?: string;
}

export type NativeWatcherCallback = (location?: NativeLocation | null, error?: NativeCallbackError | null) => void;

export interface BackgroundGeolocationPlugin {
  addWatcher(options: NativeWatcherOptions, callback: NativeWatcherCallback): Promise<string> | string;
  removeWatcher(options: { id: string }): Promise<void> | void;
  openSettings(): Promise<void> | void;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
}

export type NativeWindow = { Capacitor?: CapacitorGlobal };

export const PLUGIN_NAME = "BackgroundGeolocation";

function currentWindow(): NativeWindow | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as NativeWindow);
}

/** True only inside the Capacitor shell (never in a browser, never on the server). */
export function isNativeShell(win: NativeWindow | undefined = currentWindow()): boolean {
  try {
    return win?.Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

const isFn = (v: unknown): v is (...args: never[]) => unknown => typeof v === "function";

/** The plugin, when running in the native shell and the plugin is installed; otherwise null. */
export function backgroundGeolocation(win: NativeWindow | undefined = currentWindow()): BackgroundGeolocationPlugin | null {
  if (!isNativeShell(win)) return null;
  const plugin = win?.Capacitor?.Plugins?.[PLUGIN_NAME] as Partial<BackgroundGeolocationPlugin> | undefined;
  if (!plugin || !isFn(plugin.addWatcher) || !isFn(plugin.removeWatcher)) return null;
  return plugin as BackgroundGeolocationPlugin;
}

export type NativeProblem = "denied" | "services_off" | "unavailable";

/** A plugin error → what the rep must do. NOT_AUTHORIZED covers both a denied permission and location services that are off. */
export function nativeProblemOf(error: NativeCallbackError | null | undefined): NativeProblem {
  const code = error?.code ?? "";
  const message = (error?.message ?? "").toLowerCase();
  if (code === "NOT_AUTHORIZED") return message.includes("disabled") ? "services_off" : "denied";
  return "unavailable";
}

/** A usable fix, or null (non-finite coordinates). */
export function toFix(location: NativeLocation | null | undefined, nowMs: number): { lat: number; lng: number; accuracy: number | null; timestampMs: number } | null {
  if (!location) return null;
  const { latitude, longitude, accuracy, time } = location;
  if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    lat: latitude,
    lng: longitude,
    accuracy: typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null,
    timestampMs: typeof time === "number" && Number.isFinite(time) && time > 0 ? time : nowMs,
  };
}

// ---------------------------------------------------------------------------
// The persisted watcher id
// ---------------------------------------------------------------------------

export const WATCHER_KEY = "honest.native.watcher.v1";

export type WatcherStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): WatcherStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(storage: WatcherStorage | null): string | null {
  try {
    return storage?.getItem(WATCHER_KEY) ?? null;
  } catch {
    return null;
  }
}

function write(storage: WatcherStorage | null, id: string | null): void {
  try {
    if (id === null) storage?.removeItem(WATCHER_KEY);
    else storage?.setItem(WATCHER_KEY, id);
  } catch {
    // storage unavailable: only this page's id is known
  }
}

async function remove(plugin: BackgroundGeolocationPlugin, id: string): Promise<void> {
  try {
    await plugin.removeWatcher({ id });
  } catch {
    // unknown id (already gone) or the service is not bound yet: nothing to stop
  }
}

/** Removes a watcher left by an earlier page (reload, crash, sign-out) and forgets its id. */
export async function removeStaleWatcher(plugin: BackgroundGeolocationPlugin, storage: WatcherStorage | null = browserStorage()): Promise<void> {
  const stale = read(storage);
  if (!stale) return;
  write(storage, null);
  await remove(plugin, stale);
}

export interface NativeWatch {
  /** Removes the watcher (idempotent): the permanent notification goes away and the GPS stops. */
  stop(): Promise<void>;
}

/**
 * Adds a watcher after removing any stale one, and persists its id. `stop()` may be called
 * before the id is known; the watcher is then removed as soon as it is.
 */
export function watchPosition(
  plugin: BackgroundGeolocationPlugin,
  options: NativeWatcherOptions,
  callback: NativeWatcherCallback,
  storage: WatcherStorage | null = browserStorage(),
): NativeWatch {
  let stopped = false;
  let id: string | null = null;

  const added = (async () => {
    await removeStaleWatcher(plugin, storage);
    if (stopped) return;
    let newId: string;
    try {
      newId = String(
        await plugin.addWatcher(options, (location, error) => {
          if (!stopped) callback(location ?? null, error ?? null);
        }),
      );
    } catch (error) {
      if (!stopped) callback(null, (error ?? {}) as NativeCallbackError);
      return;
    }
    if (stopped) {
      await remove(plugin, newId); // stopped while the watcher was being added
      return;
    }
    id = newId;
    write(storage, newId);
  })();

  return {
    async stop() {
      if (stopped) return added;
      stopped = true;
      await added;
      if (id !== null) {
        const mine = id;
        id = null;
        if (read(storage) === mine) write(storage, null);
        await remove(plugin, mine);
      }
    },
  };
}

/** Stops whatever watcher this device still has (login page, sign-out): never collect without a session. */
export async function stopNativeTracking(win: NativeWindow | undefined = currentWindow(), storage: WatcherStorage | null = browserStorage()): Promise<void> {
  const plugin = backgroundGeolocation(win);
  if (plugin) await removeStaleWatcher(plugin, storage);
}

/**
 * For a page that is not collecting: removes whatever watcher the device still has.
 * A full WebView load (the offline page, a reload, the app restored overnight) drops the
 * earlier page's callback while the plugin's service keeps its watcher, so without this
 * the GPS and the "recording your location" notification stayed on outside the working
 * day (audit 4 F4). Idempotent and cheap (one storage read); a no-op in browsers and
 * while collecting, when the native collector owns the watcher.
 */
export async function releaseIdleNativeWatcher(
  collecting: boolean,
  win: NativeWindow | undefined = currentWindow(),
  storage: WatcherStorage | null = browserStorage(),
): Promise<void> {
  if (collecting) return;
  await stopNativeTracking(win, storage);
}

/** Opens the app's page in Android settings (permissions, battery). False when not available. */
export async function openNativeAppSettings(win: NativeWindow | undefined = currentWindow()): Promise<boolean> {
  const plugin = backgroundGeolocation(win);
  if (!plugin || !isFn(plugin.openSettings)) return false;
  try {
    await plugin.openSettings();
    return true;
  } catch {
    return false;
  }
}
