/**
 * One high-accuracy GPS fix, taken only when the rep taps check-in or
 * check-out (ADR-010). Work-hours tracking is separate (D-14, src/modules/tracking). Browser only;
 * the Geolocation object is injectable so the logic is unit-testable.
 */

export interface GeoFix {
  ok: true;
  lat: number;
  lng: number;
  accuracyM: number;
  /** Device time of the fix (ISO 8601). */
  capturedAt: string;
}

export type GeoFailureReason = "denied" | "unavailable" | "timeout" | "unsupported" | "insecure";

export interface GeoFailure {
  ok: false;
  reason: GeoFailureReason;
}

export type GeoOutcome = GeoFix | GeoFailure;

/** High accuracy, a fresh fix (no cache) and a bounded wait. */
export const GEO_OPTIONS: PositionOptions = { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 };

/** Columns are numeric(9,6) and numeric(8,1): round on the device so a replay sends identical values. */
export function roundFix(lat: number, lng: number, accuracyM: number): { lat: number; lng: number; accuracyM: number } {
  return {
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    accuracyM: Math.min(Math.round(accuracyM * 10) / 10, 9_999_999.9),
  };
}

/** GeolocationPositionError.code → reason (1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT). */
export function reasonOf(code: number): GeoFailureReason {
  return code === 1 ? "denied" : code === 3 ? "timeout" : "unavailable";
}

export interface GeoEnv {
  geolocation?: Pick<Geolocation, "getCurrentPosition">;
  isSecureContext?: boolean;
}

function browserEnv(): GeoEnv {
  if (typeof window === "undefined") return {};
  return { geolocation: navigator.geolocation, isSecureContext: window.isSecureContext };
}

export function captureFix(env: GeoEnv = browserEnv(), options: PositionOptions = GEO_OPTIONS): Promise<GeoOutcome> {
  if (env.isSecureContext === false) return Promise.resolve({ ok: false, reason: "insecure" });
  if (!env.geolocation) return Promise.resolve({ ok: false, reason: "unsupported" });
  return new Promise((resolve) => {
    env.geolocation!.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy)) {
          resolve({ ok: false, reason: "unavailable" });
          return;
        }
        const r = roundFix(latitude, longitude, accuracy);
        const ts = Number.isFinite(position.timestamp) && position.timestamp > 0 ? position.timestamp : Date.now();
        resolve({ ok: true, lat: r.lat, lng: r.lng, accuracyM: r.accuracyM, capturedAt: new Date(ts).toISOString() });
      },
      (error) => resolve({ ok: false, reason: reasonOf(error.code) }),
      options,
    );
  });
}
