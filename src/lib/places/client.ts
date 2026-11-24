import "server-only";
import { serverEnv } from "@/env";
import { log } from "@/lib/log";
import { normalizeMapsKey } from "@/lib/maps/config";
import { detailsRequest, errorCodeFor, parsePlaceDetails, type PlaceDetails, type PlacesRequest } from "./requests";

/**
 * Server-only Google Places API (New) client (decision F: GOOGLE_MAPS_SERVER_KEY, never sent to
 * the browser). Callers pass `fetchImpl` in tests; no request is made without a key.
 * Responses are never cached (`cache: "no-store"`) and never logged: only status codes are.
 */

export type PlacesKey = { status: "ready"; key: string } | { status: "not_configured" };

/** The server key, or not configured (missing, blank or malformed). */
export function placesServerKey(raw: string | undefined = readServerKey()): PlacesKey {
  const key = normalizeMapsKey(raw);
  return key ? { status: "ready", key } : { status: "not_configured" };
}

function readServerKey(): string | undefined {
  const raw = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    return serverEnv("GOOGLE_MAPS_SERVER_KEY").GOOGLE_MAPS_SERVER_KEY;
  } catch {
    log("warn", "places.key_invalid", {});
    return undefined;
  }
}

export type PlacesResponse = { ok: true; body: unknown } | { ok: false; code: string };

const TIMEOUT_MS = 10_000;

export async function placesFetch(req: PlacesRequest, fetchImpl: typeof fetch = fetch): Promise<PlacesResponse> {
  let response: Response;
  try {
    response = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    const code = cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "network";
    log("warn", "places.request_failed", { reason: code });
    return { ok: false, code };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = errorCodeFor(response.status, body);
    log("warn", "places.request_failed", { httpStatus: response.status, apiStatus: code });
    return { ok: false, code };
  }
  return { ok: true, body };
}

/** Live details for the places a rep is looking at (shown, never stored). Failures → null entries. */
export async function fetchPlaceDetails(
  key: string,
  placeIds: readonly string[],
  options: { language?: "ar" | "en"; fetchImpl?: typeof fetch; concurrency?: number } = {},
): Promise<Map<string, PlaceDetails | null>> {
  const out = new Map<string, PlaceDetails | null>();
  const queue = [...new Set(placeIds)];
  const workers = Math.max(1, Math.min(options.concurrency ?? 5, queue.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        let req: PlacesRequest;
        try {
          req = detailsRequest(key, id, options.language ?? "ar");
        } catch {
          out.set(id, null);
          continue;
        }
        const res = await placesFetch(req, options.fetchImpl);
        out.set(id, res.ok ? parsePlaceDetails(id, res.body) : null);
      }
    }),
  );
  return out;
}
