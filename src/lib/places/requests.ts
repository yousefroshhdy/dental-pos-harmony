/**
 * Google Places API (New) requests (pure: no fetch, no key lookup; unit-tested). The field masks
 * ask for the fewest fields each step needs, which keeps every call on the cheapest SKU that
 * works (docs/DECISIONS.md, Phase P step 4):
 *   Nearby Search  places.id, places.location          (Nearby Search Pro)
 *   Text Search    places.id, places.location, nextPageToken (Text Search Pro)
 *   Place Details  id, displayName, formattedAddress, location, googleMapsUri, attributions
 *                  (Place Details Pro; shown live to the rep, never stored)
 *
 * Place types (decision E): "dentist" and "dental_clinic" from Table A of the Places API (New)
 * place types. Not re-checked against Google's page from the build environment (the host was
 * blocked); a wrong type makes Google answer INVALID_ARGUMENT, which the run records as
 * error "invalid_argument".
 */
import type { Circle, Rect } from "./grid";

export const PLACES_BASE_URL = "https://places.googleapis.com/v1";
export const NEARBY_URL = `${PLACES_BASE_URL}/places:searchNearby`;
export const TEXT_URL = `${PLACES_BASE_URL}/places:searchText`;

export const DENTAL_PLACE_TYPES = ["dentist", "dental_clinic"] as const;
/** "Dental clinic" in Arabic, as people write it on Google Maps in Egypt. */
export const DENTAL_TEXT_QUERY = "عيادة أسنان";

export const NEARBY_FIELD_MASK = "places.id,places.location";
export const TEXT_FIELD_MASK = "places.id,places.location,nextPageToken";
export const DETAILS_FIELD_MASK = "id,displayName,formattedAddress,location,googleMapsUri,attributions";

/** A Nearby or Text Search page holds at most 20 places. */
export const MAX_RESULTS_PER_REQUEST = 20;
/** Text Search pages per rectangle (Google stops at 60 results). */
export const MAX_TEXT_PAGES = 3;

/** Google place ids: URL-safe base64-like tokens. Same rule as the database. */
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;
export function isPlaceId(value: unknown): value is string {
  return typeof value === "string" && PLACE_ID.test(value);
}

export interface PlacesRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

function headers(key: string, mask: string, json: boolean): Record<string, string> {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    "X-Goog-Api-Key": key,
    "X-Goog-FieldMask": mask,
  };
}

const point = (p: { lat: number; lng: number }) => ({ latitude: p.lat, longitude: p.lng });

export function nearbyRequest(key: string, cell: Circle, language: "ar" | "en" = "ar"): PlacesRequest {
  return {
    url: NEARBY_URL,
    method: "POST",
    headers: headers(key, NEARBY_FIELD_MASK, true),
    body: JSON.stringify({
      includedTypes: [...DENTAL_PLACE_TYPES],
      maxResultCount: MAX_RESULTS_PER_REQUEST,
      locationRestriction: { circle: { center: point(cell.center), radius: cell.radiusM } },
      rankPreference: "DISTANCE",
      languageCode: language,
      regionCode: "eg",
    }),
  };
}

export function textRequest(key: string, rect: Rect, pageToken?: string, language: "ar" | "en" = "ar"): PlacesRequest {
  return {
    url: TEXT_URL,
    method: "POST",
    headers: headers(key, TEXT_FIELD_MASK, true),
    body: JSON.stringify({
      textQuery: DENTAL_TEXT_QUERY,
      pageSize: MAX_RESULTS_PER_REQUEST,
      locationRestriction: { rectangle: { low: point(rect.low), high: point(rect.high) } },
      languageCode: language,
      regionCode: "eg",
      ...(pageToken ? { pageToken } : {}),
    }),
  };
}

export function detailsRequest(key: string, placeId: string, language: "ar" | "en" = "ar"): PlacesRequest {
  if (!isPlaceId(placeId)) throw new RangeError("not a place id");
  const url = new URL(`${PLACES_BASE_URL}/places/${encodeURIComponent(placeId)}`);
  url.searchParams.set("languageCode", language);
  url.searchParams.set("regionCode", "eg");
  return { url: url.toString(), method: "GET", headers: headers(key, DETAILS_FIELD_MASK, false) };
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface FoundPlace {
  placeId: string;
  lat: number;
  lng: number;
}

interface RawPlace {
  id?: unknown;
  location?: { latitude?: unknown; longitude?: unknown };
}

/** Places of a Nearby or Text Search body; entries without an id or a location are dropped. */
export function parseSearchPlaces(body: unknown): { places: FoundPlace[]; nextPageToken: string | null } {
  const b = (body ?? {}) as { places?: RawPlace[]; nextPageToken?: unknown };
  const places: FoundPlace[] = [];
  for (const p of Array.isArray(b.places) ? b.places : []) {
    const lat = Number(p?.location?.latitude);
    const lng = Number(p?.location?.longitude);
    if (!isPlaceId(p?.id) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    places.push({ placeId: p.id, lat, lng });
  }
  const token = typeof b.nextPageToken === "string" && b.nextPageToken.length > 0 ? b.nextPageToken : null;
  return { places, nextPageToken: token };
}

/** Third-party data provider credit Google asks apps to show next to the place. */
export interface PlaceAttribution {
  provider: string;
  providerUri: string | null;
}

export interface PlaceDetails {
  placeId: string;
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  mapsUri: string | null;
  attributions: PlaceAttribution[];
}

const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
};

export function parsePlaceDetails(placeId: string, body: unknown): PlaceDetails {
  const b = (body ?? {}) as {
    displayName?: { text?: unknown };
    formattedAddress?: unknown;
    location?: { latitude?: unknown; longitude?: unknown };
    googleMapsUri?: unknown;
    attributions?: { provider?: unknown; providerUri?: unknown }[];
  };
  const lat = Number(b.location?.latitude);
  const lng = Number(b.location?.longitude);
  const hasPoint = b.location !== undefined && Number.isFinite(lat) && Number.isFinite(lng);
  return {
    placeId,
    name: typeof b.displayName?.text === "string" ? b.displayName.text.slice(0, 200) : null,
    address: typeof b.formattedAddress === "string" ? b.formattedAddress.slice(0, 300) : null,
    lat: hasPoint ? lat : null,
    lng: hasPoint ? lng : null,
    mapsUri: httpsUrl(b.googleMapsUri),
    attributions: (Array.isArray(b.attributions) ? b.attributions : [])
      .filter((a) => typeof a?.provider === "string" && a.provider.trim() !== "")
      .map((a) => ({ provider: String(a.provider).slice(0, 120), providerUri: httpsUrl(a.providerUri) })),
  };
}

/** Short error code for an HTTP failure (stored on the run: lower snake case, no detail). */
export function errorCodeFor(status: number, body: unknown): string {
  const s = (body as { error?: { status?: unknown } } | null)?.error?.status;
  if (typeof s === "string" && /^[A-Z_]{3,40}$/.test(s)) return s.toLowerCase();
  return `http_${status}`;
}

/** A key, API or billing problem: every further request would fail the same way. */
export function isFatalError(code: string): boolean {
  return code === "permission_denied" || code === "unauthenticated" || code === "invalid_argument" || code === "http_401" || code === "http_403";
}
