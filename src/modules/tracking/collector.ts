import { reasonOf } from "@/modules/field/geo";
import { shouldSample } from "./logic";
import type { CollectorProblem } from "./device-store";

/**
 * The in-browser location sampler (D-14 Phase 1). It runs ONLY while the caller
 * keeps it started, which use-tracking.ts does only while a shift is open and the
 * page is visible: browsers do not give a web app the location in the background.
 *
 * - watchPosition (high accuracy) keeps the GPS warm and reports movement;
 * - a timer asks for one fix when nothing was kept for a whole interval (a phone
 *   lying still may report no movement at all);
 * - at most one point is kept per sampling interval (default 5 minutes).
 *
 * Everything browser-specific is injected, so the logic is unit-testable.
 */

export interface Sample {
  lat: number;
  lng: number;
  accuracy: number | null;
  /** Device time of the fix. */
  timestampMs: number;
}

export interface CollectorDeps {
  geolocation: Pick<Geolocation, "watchPosition" | "clearWatch" | "getCurrentPosition"> | undefined;
  isSecureContext?: boolean;
  intervalMs: number;
  now: () => number;
  /** Device ms of the last kept point (shared with other tabs through the store). */
  lastSampleMs: () => number | null;
  onSample: (sample: Sample) => void;
  onProblem: (problem: CollectorProblem | null) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}

export const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 15_000, timeout: 60_000 };

function toSample(position: GeolocationPosition, now: number): Sample | null {
  const { latitude, longitude, accuracy } = position.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const ts = Number.isFinite(position.timestamp) && position.timestamp > 0 ? position.timestamp : now;
  return { lat: latitude, lng: longitude, accuracy: Number.isFinite(accuracy) ? accuracy : null, timestampMs: ts };
}

/** Starts sampling; returns the stop function. */
export function startCollector(deps: CollectorDeps): () => void {
  if (deps.isSecureContext === false) {
    deps.onProblem("insecure");
    return () => undefined;
  }
  const geo = deps.geolocation;
  if (!geo) {
    deps.onProblem("unsupported");
    return () => undefined;
  }
  const setTimer = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer = deps.clearInterval ?? ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>));
  let stopped = false;
  let asking = false;

  const keep = (position: GeolocationPosition) => {
    if (stopped) return;
    deps.onProblem(null);
    const now = deps.now();
    if (!shouldSample(deps.lastSampleMs(), now, deps.intervalMs)) return;
    const sample = toSample(position, now);
    if (sample) deps.onSample(sample);
  };
  const failed = (error: GeolocationPositionError) => {
    if (!stopped) deps.onProblem(reasonOf(error.code));
  };

  const watchId = geo.watchPosition(keep, failed, WATCH_OPTIONS);

  const tick = () => {
    if (stopped || asking || !shouldSample(deps.lastSampleMs(), deps.now(), deps.intervalMs)) return;
    asking = true;
    geo.getCurrentPosition(
      (position) => {
        asking = false;
        keep(position);
      },
      (error) => {
        asking = false;
        failed(error);
      },
      { ...WATCH_OPTIONS, maximumAge: 0 },
    );
  };
  const timer = setTimer(tick, Math.min(60_000, Math.max(5_000, Math.floor(deps.intervalMs / 5))));

  return () => {
    stopped = true;
    geo.clearWatch(watchId);
    clearTimer(timer);
  };
}

/** Screen Wake Lock where the browser has it (keeps the screen on, so collection continues). */
export async function requestWakeLock(nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator): Promise<(() => void) | null> {
  const wakeLock = (nav as (Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }) | undefined)?.wakeLock;
  if (!wakeLock) return null;
  try {
    const sentinel = await wakeLock.request("screen");
    return () => void sentinel.release().catch(() => undefined);
  } catch {
    return null; // denied (battery saver, not visible): collection still runs while the screen stays on
  }
}
