/**
 * Google Maps configuration (owner decision F, 2026-11-24): the browser key
 * NEXT_PUBLIC_GOOGLE_MAPS_API_KEY, restricted by HTTP referrer in the Google Cloud console.
 * Pure functions, no browser or Next imports: used by pages, the map component, the proxy's
 * CSP switch and unit tests.
 *
 * Without a key every map shows a plain "The map is not available yet" state and makes no
 * network call (the loader is never imported).
 */

import { can, type UserContext } from "@/lib/authz/can";

/** Region bias for the Maps JS API and Places (Egypt). */
export const MAPS_REGION = "EG";

/** Default centre when there is nothing to show: Cairo. */
export const EGYPT_CENTER = { lat: 30.0444, lng: 31.2357 } as const;
export const DEFAULT_ZOOM = 11;
/** Zoom for a single pin (a clinic). */
export const PIN_ZOOM = 16;

// Browser keys look like "AIza…" (39 characters). Accept any URL-safe token of a sane length so
// a future key format still works; reject blanks, placeholders with spaces and absurd values.
const KEY_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

/** A usable key, or null (missing, blank or malformed: treated as "not configured"). */
export function normalizeMapsKey(raw: string | null | undefined): string | null {
  const key = raw?.trim();
  return key && KEY_PATTERN.test(key) ? key : null;
}

/** The proxy adds the Maps CSP sources only when this is true. */
export function mapsKeyConfigured(raw: string | null | undefined): boolean {
  return normalizeMapsKey(raw) !== null;
}

export type MapsKeyState = { status: "missing" } | { status: "ready"; key: string };

export function mapsKeyState(raw: string | null | undefined): MapsKeyState {
  const key = normalizeMapsKey(raw);
  return key ? { status: "ready", key } : { status: "missing" };
}

/** Only a ready key may start loading the Maps JS API (the "no key → no network" rule). */
export function shouldLoadMaps(state: MapsKeyState): state is { status: "ready"; key: string } {
  return state.status === "ready";
}

/** Map UI language: the app locale (Arabic default, RTL-aware controls in Arabic). */
export function mapsLanguage(locale: string | null | undefined): "ar" | "en" {
  return locale === "en" ? "en" : "ar";
}

/** Options for `setOptions()` of @googlemaps/js-api-loader. */
export function loaderOptions(key: string, locale: string | null | undefined) {
  return { key, v: "weekly", language: mapsLanguage(locale), region: MAPS_REGION } as const;
}

/**
 * Who also reads the technical setup detail (env var names, which Google API to enable) under the
 * plain "not available yet" notices of maps and leads: the owner and holders of
 * admin.settings.manage. Everyone else reads business language only (docs/DECISIONS.md Part C).
 * A display choice, not security: the keys are never sent to anyone either way.
 */
export function seesSetupDetails(ctx: UserContext): boolean {
  return can(ctx, "admin.settings.manage");
}
