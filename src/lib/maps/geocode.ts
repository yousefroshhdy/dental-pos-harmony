import "server-only";
import { serverEnv } from "@/env";
import { log } from "@/lib/log";

/**
 * Address → point with the Google Geocoding API (decision F: server key GOOGLE_MAPS_SERVER_KEY,
 * never sent to the browser). Biased to Egypt (region=eg, components=country:EG), Arabic results.
 *
 * Without a key it answers { status: "not_configured" } and the caller lets the admin type the
 * latitude and longitude, or skip. The address is personal data: it is never logged; only the
 * API status is.
 */
export type GeocodeResult =
  | { status: "ok"; lat: number; lng: number; formattedAddress: string; approximate: boolean }
  | { status: "not_configured" }
  | { status: "not_found" }
  | { status: "outside_egypt" }
  | { status: "error"; reason: string };

/** Egypt bounding box, the same as the database checks (core.employees, crm.customers). */
export const EGYPT_BOUNDS = { minLat: 21.5, maxLat: 32.0, minLng: 24.5, maxLng: 37.5 } as const;

export function insideEgypt(lat: number, lng: number): boolean {
  return lat >= EGYPT_BOUNDS.minLat && lat <= EGYPT_BOUNDS.maxLat && lng >= EGYPT_BOUNDS.minLng && lng <= EGYPT_BOUNDS.maxLng;
}

const ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const TIMEOUT_MS = 8000;

interface GoogleGeocodeResponse {
  status: string;
  results?: {
    formatted_address?: string;
    geometry?: { location?: { lat?: number; lng?: number }; location_type?: string };
    partial_match?: boolean;
  }[];
}

export interface GeocodeOptions {
  /** Defaults to GOOGLE_MAPS_SERVER_KEY. */
  key?: string;
  fetchImpl?: typeof fetch;
  language?: "ar" | "en";
}

function configuredKey(): string | null | "invalid" {
  const raw = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (raw === undefined || raw.trim() === "") return null;
  try {
    return serverEnv("GOOGLE_MAPS_SERVER_KEY").GOOGLE_MAPS_SERVER_KEY ?? null;
  } catch {
    return "invalid";
  }
}

export async function geocodeAddress(address: string, options: GeocodeOptions = {}): Promise<GeocodeResult> {
  const text = address.trim();
  if (text.length < 3) return { status: "not_found" };
  const key = options.key ?? configuredKey();
  if (key === null) return { status: "not_configured" };
  if (key === "invalid") return { status: "error", reason: "invalid_key" };

  const url = new URL(ENDPOINT);
  url.searchParams.set("address", text.slice(0, 300));
  url.searchParams.set("region", "eg");
  url.searchParams.set("components", "country:EG");
  url.searchParams.set("language", options.language ?? "ar");
  url.searchParams.set("key", key);

  let body: GoogleGeocodeResponse;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    if (!response.ok) {
      log("warn", "maps.geocode_failed", { httpStatus: response.status });
      return { status: "error", reason: `http_${response.status}` };
    }
    body = (await response.json()) as GoogleGeocodeResponse;
  } catch (cause) {
    log("warn", "maps.geocode_failed", { reason: cause instanceof Error ? cause.name : "unknown" });
    return { status: "error", reason: "network" };
  }

  if (body.status === "ZERO_RESULTS") return { status: "not_found" };
  if (body.status !== "OK") {
    // REQUEST_DENIED (key restrictions / API not enabled), OVER_QUERY_LIMIT, INVALID_REQUEST, UNKNOWN_ERROR.
    log("warn", "maps.geocode_failed", { apiStatus: body.status });
    return { status: "error", reason: body.status.toLowerCase() };
  }
  const first = body.results?.[0];
  const lat = first?.geometry?.location?.lat;
  const lng = first?.geometry?.location?.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return { status: "not_found" };
  if (!insideEgypt(lat, lng)) return { status: "outside_egypt" };
  return {
    status: "ok",
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    formattedAddress: first?.formatted_address ?? text,
    approximate: first?.partial_match === true || first?.geometry?.location_type === "APPROXIMATE",
  };
}
