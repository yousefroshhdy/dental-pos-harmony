import { nativeProblemOf, toFix, watchPosition, type BackgroundGeolocationPlugin, type WatcherStorage } from "@/lib/native/background-geolocation";
import type { Sample } from "./collector";
import type { CollectorProblem } from "./device-store";
import { shouldSample } from "./logic";

/**
 * The location sampler inside the Android shell (D-14 phase 2). Same contract as the
 * browser collector (collector.ts): started only while a shift is open, at most one point
 * per sampling interval, the fix's own capture time, and the same buffer → offline queue →
 * sender pipeline (use-tracking.ts). Differences:
 *
 * - a native watcher with a permanent notification keeps delivering fixes while the app
 *   is in the background or the screen is off, so it is NOT paused when the page is hidden;
 * - the plugin delivers about one fix per second (distanceFilter 0, so a rep standing still
 *   still produces points): every fix is checked against the interval, and when the shift
 *   is no longer collecting (ended elsewhere, past its maximum) the watcher removes itself
 *   even if the page's timers are throttled in the background;
 * - a refused permission keeps the watcher: the plugin restarts it when the rep returns
 *   from Android settings with the permission granted.
 */

export interface NativeCollectorDeps {
  plugin: BackgroundGeolocationPlugin;
  /** Where the active watcher id is kept (a reload must not leave a watcher running). */
  storage?: WatcherStorage | null;
  intervalMs: number;
  now: () => number;
  lastSampleMs: () => number | null;
  /** Still allowed to collect (open shift, under its maximum length). */
  isActive: () => boolean;
  /** The permanent notification's title and text (the rep's language). */
  notification: { title: string; message: string };
  onSample: (sample: Sample) => void;
  onProblem: (problem: CollectorProblem | null) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

/** Retries after an error that is not the rep's to fix (e.g. the service was not bound yet). */
export const NATIVE_RETRY = { delayMs: 5_000, max: 3 } as const;

export function nativeWatcherOptions(notification: { title: string; message: string }) {
  return {
    backgroundTitle: notification.title,
    backgroundMessage: notification.message,
    requestPermissions: true,
    stale: false,
    distanceFilter: 0,
  };
}

/** Starts the native watcher; returns the stop function (removes the watcher). */
export function startNativeCollector(deps: NativeCollectorDeps): () => void {
  const setTimer = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let stopped = false;
  let retries = 0;
  let retryTimer: unknown = null;
  let watch: ReturnType<typeof watchPosition> | null = null;
  let lastProblem: CollectorProblem | null | undefined;

  const problem = (p: CollectorProblem | null) => {
    if (p === lastProblem) return;
    lastProblem = p;
    deps.onProblem(p);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
    void watch?.stop();
    watch = null;
  };

  const start = () => {
    void watch?.stop(); // at most one watcher
    watch = watchPosition(
      deps.plugin,
      nativeWatcherOptions(deps.notification),
      (location, error) => {
        if (stopped) return;
        if (!deps.isActive()) {
          stop(); // never collect without an open shift
          return;
        }
        if (error) {
          const reason = nativeProblemOf(error);
          problem(reason);
          if (reason === "unavailable" && retries < NATIVE_RETRY.max && retryTimer === null) {
            retries += 1;
            const old = watch;
            watch = null;
            void old?.stop();
            retryTimer = setTimer(() => {
              retryTimer = null;
              if (!stopped) start();
            }, NATIVE_RETRY.delayMs);
          }
          return;
        }
        const now = deps.now();
        const fix = toFix(location, now);
        if (!fix) return;
        problem(null);
        retries = 0;
        if (!shouldSample(deps.lastSampleMs(), now, deps.intervalMs)) return;
        deps.onSample(fix);
      },
      deps.storage,
    );
  };

  start();
  return stop;
}
