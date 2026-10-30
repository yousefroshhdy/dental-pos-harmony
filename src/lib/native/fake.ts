import type { BackgroundGeolocationPlugin, NativeCallbackError, NativeLocation, NativeWatcherCallback, NativeWatcherOptions, NativeWindow } from "./background-geolocation";

/**
 * An in-memory stand-in for the Android plugin, for unit tests (no Capacitor anywhere).
 * Behaves like @capacitor-community/background-geolocation 1.3.1 on Android: a watcher
 * stays registered until removeWatcher, even when its permission request was refused.
 */
export interface FakeBackgroundGeolocation extends BackgroundGeolocationPlugin {
  /** Live watchers by id. */
  readonly watchers: Map<string, { options: NativeWatcherOptions; callback: NativeWatcherCallback }>;
  /** Every call, in order (e.g. "add:w1", "remove:w1", "settings"). */
  readonly calls: string[];
  /** Deliver a location to every live watcher. */
  emit(location: Partial<NativeLocation> & Pick<NativeLocation, "latitude" | "longitude">): void;
  /** Deliver an error to every live watcher. */
  fail(error: NativeCallbackError): void;
  /** The next addWatcher rejects with this error (e.g. the service is not bound yet). */
  rejectNextAdd(error: NativeCallbackError): void;
}

export function createFakeBackgroundGeolocation(opts: { syncIds?: boolean } = {}): FakeBackgroundGeolocation {
  const watchers = new Map<string, { options: NativeWatcherOptions; callback: NativeWatcherCallback }>();
  const calls: string[] = [];
  let next = 0;
  let pendingReject: NativeCallbackError | null = null;

  return {
    watchers,
    calls,
    addWatcher(options, callback) {
      if (pendingReject) {
        const error = pendingReject;
        pendingReject = null;
        calls.push("add:rejected");
        return Promise.reject(error);
      }
      const id = `w${++next}`;
      watchers.set(id, { options, callback });
      calls.push(`add:${id}`);
      // The legacy injected proxy answers the id synchronously; @capacitor/core wraps it in a Promise.
      return opts.syncIds ? id : Promise.resolve(id);
    },
    removeWatcher({ id }) {
      calls.push(`remove:${id}`);
      watchers.delete(id);
      return Promise.resolve();
    },
    openSettings() {
      calls.push("settings");
      return Promise.resolve();
    },
    emit(location) {
      const full: NativeLocation = { accuracy: 8, time: null, simulated: false, ...location };
      for (const w of [...watchers.values()]) w.callback(full, null);
    },
    fail(error) {
      for (const w of [...watchers.values()]) w.callback(null, error);
    },
    rejectNextAdd(error) {
      pendingReject = error;
    },
  };
}

/** A window as the Capacitor shell injects it (or a plain browser window when `native` is false). */
export function fakeNativeWindow(plugin: BackgroundGeolocationPlugin | null, native = true): NativeWindow {
  if (!native) return {};
  return { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android", Plugins: plugin ? { BackgroundGeolocation: plugin } : {} } };
}
