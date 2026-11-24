/**
 * Small geometry helpers for the maps (pure, unit-tested). Distances are great-circle
 * (haversine) metres, the same formula as core.distance_m in the database.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Same box as crm.customers and api.set_customer_location. */
export function insideEgypt(p: LatLng): boolean {
  return p.lat >= 21.5 && p.lat <= 32.0 && p.lng >= 24.5 && p.lng <= 37.5;
}

/** numeric from PostgREST (number | string | null) → a coordinate pair, or null. */
export function toLatLng(lat: number | string | null | undefined, lng: number | string | null | undefined): LatLng | null {
  if (lat === null || lat === undefined || lng === null || lng === undefined || lat === "" || lng === "") return null;
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: a, lng: b };
}

const fixed = (n: number) => n.toFixed(6);

/** Google Maps directions to a point (opens the Maps app on phones). Origin: the device's position. */
export function directionsUrl(to: LatLng, from?: LatLng | null): string {
  const params = new URLSearchParams({ api: "1", destination: `${fixed(to.lat)},${fixed(to.lng)}` });
  if (from) params.set("origin", `${fixed(from.lat)},${fixed(from.lng)}`);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Google Maps search link for one point. */
export function placeUrl(p: LatLng): string {
  const params = new URLSearchParams({ api: "1", query: `${fixed(p.lat)},${fixed(p.lng)}` });
  return `https://www.google.com/maps/search/?${params.toString()}`;
}

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** Bounding box of the points, or null when there are none. */
export function boundsOf(points: readonly LatLng[]): Bounds | null {
  if (points.length === 0) return null;
  let north = -90;
  let south = 90;
  let east = -180;
  let west = 180;
  for (const p of points) {
    north = Math.max(north, p.lat);
    south = Math.min(south, p.lat);
    east = Math.max(east, p.lng);
    west = Math.min(west, p.lng);
  }
  return { north, south, east, west };
}
