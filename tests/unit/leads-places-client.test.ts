import { describe, expect, it, vi } from "vitest";
import { fetchPlaceDetails, placesFetch, placesServerKey } from "@/lib/places/client";
import { dedupeByPlaceId, discoverPlaces, withinRadius } from "@/lib/places/discover";
import { discoveryGrid } from "@/lib/places/grid";
import {
  DETAILS_FIELD_MASK,
  detailsRequest,
  NEARBY_FIELD_MASK,
  NEARBY_URL,
  nearbyRequest,
  parsePlaceDetails,
  parseSearchPlaces,
  TEXT_FIELD_MASK,
  TEXT_URL,
  textRequest,
} from "@/lib/places/requests";

const KEY = "AIzaSyTEST_test_key_000000000000000000";
const BASE = { lat: 31.0409, lng: 31.3785 };
const pid = (n: number) => `ChIJsynthPlace${String(n).padStart(6, "0")}`;

type Call = { url: string; init: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fetch mock that records calls and answers from a handler. No real request is ever made. */
function mockFetch(handler: (url: string, body: Record<string, unknown> | null) => Response) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    return handler(url, body);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("Places API (New) requests", () => {
  it("Nearby Search asks only for ids and locations, dentist + dental_clinic, within the circle", () => {
    const req = nearbyRequest(KEY, { center: BASE, radiusM: 1250 });
    expect(req.url).toBe(NEARBY_URL);
    expect(req.url).toBe("https://places.googleapis.com/v1/places:searchNearby");
    expect(req.method).toBe("POST");
    expect(req.headers).toEqual({ "Content-Type": "application/json", "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": "places.id,places.location" });
    expect(NEARBY_FIELD_MASK).not.toMatch(/displayName|formattedAddress|phone|rating|\*/);
    expect(JSON.parse(req.body ?? "")).toEqual({
      includedTypes: ["dentist", "dental_clinic"],
      maxResultCount: 20,
      locationRestriction: { circle: { center: { latitude: BASE.lat, longitude: BASE.lng }, radius: 1250 } },
      rankPreference: "DISTANCE",
      languageCode: "ar",
      regionCode: "eg",
    });
  });

  it("Text Search for عيادة أسنان is restricted to the rectangle and pages with nextPageToken", () => {
    const rect = { low: { lat: 31, lng: 31.3 }, high: { lat: 31.1, lng: 31.4 } };
    const first = textRequest(KEY, rect);
    expect(first.url).toBe(TEXT_URL);
    expect(first.headers["X-Goog-FieldMask"]).toBe(TEXT_FIELD_MASK);
    expect(TEXT_FIELD_MASK).toBe("places.id,places.location,nextPageToken");
    const body = JSON.parse(first.body ?? "");
    expect(body).toEqual({
      textQuery: "عيادة أسنان",
      pageSize: 20,
      locationRestriction: { rectangle: { low: { latitude: 31, longitude: 31.3 }, high: { latitude: 31.1, longitude: 31.4 } } },
      languageCode: "ar",
      regionCode: "eg",
    });
    expect(JSON.parse(textRequest(KEY, rect, "tok-2").body ?? "").pageToken).toBe("tok-2");
  });

  it("Place Details is a GET with its own field mask and no body", () => {
    const req = detailsRequest(KEY, pid(1), "en");
    expect(req.method).toBe("GET");
    expect(req.body).toBeUndefined();
    expect(req.url).toBe(`https://places.googleapis.com/v1/places/${pid(1)}?languageCode=en&regionCode=eg`);
    expect(req.headers).toEqual({ "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": DETAILS_FIELD_MASK });
    expect(DETAILS_FIELD_MASK).toBe("id,displayName,formattedAddress,location,googleMapsUri,attributions");
    expect(() => detailsRequest(KEY, "../../etc")).toThrow(RangeError);
  });

  it("parses search pages, dropping entries without an id or a location", () => {
    expect(
      parseSearchPlaces({
        places: [
          { id: pid(1), location: { latitude: 31.04, longitude: 31.37 } },
          { id: "x", location: { latitude: 31, longitude: 31 } },
          { id: pid(2) },
        ],
        nextPageToken: "next",
      }),
    ).toEqual({ places: [{ placeId: pid(1), lat: 31.04, lng: 31.37 }], nextPageToken: "next" });
    expect(parseSearchPlaces({})).toEqual({ places: [], nextPageToken: null });
  });

  it("parses details and keeps only https links", () => {
    expect(
      parsePlaceDetails(pid(1), {
        displayName: { text: "Synthetic Dental Clinic" },
        formattedAddress: "Synthetic Street, Mansoura",
        location: { latitude: 31.05, longitude: 31.38 },
        googleMapsUri: "https://maps.google.com/?cid=1",
        attributions: [{ provider: "Synthetic Data Co", providerUri: "javascript:alert(1)" }, { provider: "" }],
      }),
    ).toEqual({
      placeId: pid(1),
      name: "Synthetic Dental Clinic",
      address: "Synthetic Street, Mansoura",
      lat: 31.05,
      lng: 31.38,
      mapsUri: "https://maps.google.com/?cid=1",
      attributions: [{ provider: "Synthetic Data Co", providerUri: null }],
    });
  });
});

describe("Places client", () => {
  it("is not configured without a usable key", () => {
    expect(placesServerKey(undefined)).toEqual({ status: "not_configured" });
    expect(placesServerKey("   ")).toEqual({ status: "not_configured" });
    expect(placesServerKey("short")).toEqual({ status: "not_configured" });
    expect(placesServerKey(KEY)).toEqual({ status: "ready", key: KEY });
  });

  it("sends the request uncached and maps Google errors to short codes", async () => {
    const ok = mockFetch(() => json({ places: [] }));
    expect(await placesFetch(nearbyRequest(KEY, { center: BASE, radiusM: 500 }), ok.impl)).toEqual({ ok: true, body: { places: [] } });
    expect(ok.calls[0]?.init.cache).toBe("no-store");
    expect(ok.calls[0]?.init.method).toBe("POST");

    const denied = mockFetch(() => json({ error: { code: 403, status: "PERMISSION_DENIED", message: "API not enabled" } }, 403));
    expect(await placesFetch(nearbyRequest(KEY, { center: BASE, radiusM: 500 }), denied.impl)).toEqual({ ok: false, code: "permission_denied" });
    const broken = mockFetch(() => new Response("oops", { status: 502 }));
    expect(await placesFetch(nearbyRequest(KEY, { center: BASE, radiusM: 500 }), broken.impl)).toEqual({ ok: false, code: "http_502" });
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await placesFetch(nearbyRequest(KEY, { center: BASE, radiusM: 500 }), offline)).toEqual({ ok: false, code: "network" });
  });

  it("loads details for each place once; a failed one is null", async () => {
    const f = mockFetch((url) => (url.includes(pid(2)) ? json({ error: { status: "NOT_FOUND" } }, 404) : json({ displayName: { text: "A" } })));
    const out = await fetchPlaceDetails(KEY, [pid(1), pid(2), pid(1)], { fetchImpl: f.impl });
    expect(f.calls).toHaveLength(2);
    expect(out.get(pid(1))?.name).toBe("A");
    expect(out.get(pid(2))).toBeNull();
  });
});

describe("discovery (fetch mocked)", () => {
  it("de-duplicates by place id, keeping the first", () => {
    expect(dedupeByPlaceId([{ placeId: "a", n: 1 }, { placeId: "b", n: 2 }, { placeId: "a", n: 3 }])).toEqual([
      { placeId: "a", n: 1 },
      { placeId: "b", n: 2 },
    ]);
  });

  it("keeps places inside the radius with their distance, nearest first", () => {
    const out = withinRadius(BASE, 1000, [
      { placeId: pid(1), lat: BASE.lat + 0.005, lng: BASE.lng }, // ≈ 557 m
      { placeId: pid(2), lat: BASE.lat + 0.02, lng: BASE.lng }, // ≈ 2.2 km
      { placeId: pid(3), lat: BASE.lat, lng: BASE.lng + 0.001 }, // ≈ 95 m
      { placeId: pid(1), lat: BASE.lat + 0.005, lng: BASE.lng },
    ]);
    expect(out.map((p) => p.place_id)).toEqual([pid(3), pid(1)]);
    expect(out[1]?.distance_m).toBeCloseTo(556, 0);
  });

  it("runs the grid, then Text Search; the same clinic from both is one place", async () => {
    const cells = discoveryGrid(BASE, 5000).length;
    const f = mockFetch((url, body) => {
      if (url === NEARBY_URL) {
        const c = (body?.locationRestriction as { circle: { center: { latitude: number; longitude: number } } }).circle.center;
        // Every cell sees the clinic at the base; the first cell also sees another one.
        const places = [{ id: pid(1), location: { latitude: BASE.lat, longitude: BASE.lng } }];
        if (c.latitude === BASE.lat && c.longitude === BASE.lng) places.push({ id: pid(2), location: { latitude: BASE.lat + 0.01, longitude: BASE.lng } });
        return json({ places });
      }
      return json({ places: [{ id: pid(2), location: { latitude: BASE.lat + 0.01, longitude: BASE.lng } }, { id: pid(3), location: { latitude: BASE.lat, longitude: BASE.lng + 0.02 } }] });
    });
    const r = await discoverPlaces({ key: KEY, center: BASE, radiusM: 5000, maxRequests: 200, fetchImpl: f.impl });
    expect(r.nearbyRequests).toBe(cells);
    expect(r.textRequests).toBe(1); // no nextPageToken
    expect(r.truncated).toBe(false);
    expect(r.errorCode).toBeNull();
    expect(r.places.map((p) => p.place_id)).toEqual([pid(1), pid(2), pid(3)]);
    expect(f.calls.every((c) => (c.init.headers as Record<string, string>)["X-Goog-Api-Key"] === KEY)).toBe(true);
  });

  it("splits a cell that returned a full page of 20 into smaller circles", async () => {
    let n = 0;
    const f = mockFetch((url) => {
      if (url !== NEARBY_URL) return json({ places: [] });
      n += 1;
      const count = n === 1 ? 20 : 0; // only the first (central) cell is full
      return json({ places: Array.from({ length: count }, (_, i) => ({ id: pid(100 + i), location: { latitude: BASE.lat, longitude: BASE.lng } })) });
    });
    const r = await discoverPlaces({ key: KEY, center: BASE, radiusM: 5000, maxRequests: 400, fetchImpl: f.impl });
    expect(r.nearbyRequests).toBeGreaterThan(discoveryGrid(BASE, 5000).length);
    expect(r.places).toHaveLength(20);
  });

  it("stops at the request budget and says so", async () => {
    const f = mockFetch(() => json({ places: [] }));
    const r = await discoverPlaces({ key: KEY, center: BASE, radiusM: 5000, maxRequests: 7, fetchImpl: f.impl });
    expect(r.nearbyRequests + r.textRequests).toBe(7);
    expect(f.calls).toHaveLength(7);
    expect(r.truncated).toBe(true);
  });

  it("stops at the first key or API error and reports it", async () => {
    const f = mockFetch(() => json({ error: { status: "PERMISSION_DENIED" } }, 403));
    const r = await discoverPlaces({ key: KEY, center: BASE, radiusM: 5000, maxRequests: 200, fetchImpl: f.impl });
    expect(f.calls).toHaveLength(1);
    expect(r.errorCode).toBe("permission_denied");
    expect(r.places).toEqual([]);
  });

  it("follows Text Search pages up to three", async () => {
    let page = 0;
    const f = mockFetch((url) => {
      if (url === NEARBY_URL) return json({ places: [] });
      page += 1;
      return json({ places: [{ id: pid(500 + page), location: { latitude: BASE.lat, longitude: BASE.lng } }], nextPageToken: `t${page}` });
    });
    const r = await discoverPlaces({ key: KEY, center: BASE, radiusM: 800, maxRequests: 50, fetchImpl: f.impl });
    expect(r.nearbyRequests).toBe(1);
    expect(r.textRequests).toBe(3);
    expect(r.places).toHaveLength(3);
  });
});
