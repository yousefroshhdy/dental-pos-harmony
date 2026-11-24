/**
 * Search grid for lead discovery (pure, unit-tested). A Places Nearby Search returns at most
 * 20 places, so the discovery disc (the rep's base and radius) is covered by smaller circles.
 *
 * Hex packing: circle centres on a triangular lattice with spacing √3·r. Every point of the
 * plane lies in the hexagonal cell of its nearest centre, and that hexagon's corners are r
 * from the centre, so circles of radius r cover the plane. Keeping every centre within R + r
 * of the disc centre therefore covers the disc. A small safety factor absorbs the error of the
 * local metre ↔ degree projection (well under 0.1 % at 50 km).
 */
import { distanceMeters, type LatLng } from "@/lib/maps/geo";

export interface Circle {
  center: LatLng;
  radiusM: number;
}

export interface Rect {
  low: LatLng;
  high: LatLng;
}

const METERS_PER_DEG_LAT = 111_320;
/** Spacing slightly tighter than √3·r, so projection error never opens a gap. */
const SAFETY = 0.97;

/** Smallest circle used for a disc; a dense city centre is split further when a cell is full. */
export const MIN_CELL_RADIUS_M = 250;
/** Largest radius Places accepts for a Nearby Search circle. */
export const MAX_CELL_RADIUS_M = 50_000;

/** The point dx metres east and dy metres north of `origin` (local equirectangular projection). */
export function offsetMeters(origin: LatLng, dxM: number, dyM: number): LatLng {
  const lat = origin.lat + dyM / METERS_PER_DEG_LAT;
  const lng = origin.lng + dxM / (METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180));
  return { lat: round6(lat), lng: round6(lng) };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Cell radius for a discovery disc: the whole disc up to 1 km, otherwise a quarter of the radius
 * but at least 750 m (5 km → 1.25 km, about 30 circles).
 */
export function cellRadiusFor(radiusM: number): number {
  if (!(radiusM > 0)) throw new RangeError("radius must be positive");
  if (radiusM <= 1000) return Math.round(radiusM);
  return Math.round(Math.min(MAX_CELL_RADIUS_M, Math.max(750, radiusM / 4)));
}

/** Circles of radius `cellRadiusM` (hex packing) that together cover the disc (center, radiusM). */
export function coverDisc(center: LatLng, radiusM: number, cellRadiusM: number): Circle[] {
  if (!(radiusM > 0) || !(cellRadiusM > 0)) throw new RangeError("radii must be positive");
  const r = Math.min(cellRadiusM, MAX_CELL_RADIUS_M);
  if (r >= radiusM) return [{ center: { lat: round6(center.lat), lng: round6(center.lng) }, radiusM: Math.ceil(radiusM) }];
  const dx = Math.sqrt(3) * r * SAFETY; // spacing along a row
  const dy = 1.5 * r * SAFETY; // spacing between rows (√3/2 · dx)
  const reach = radiusM + r;
  const rows = Math.ceil(reach / dy);
  const out: Circle[] = [];
  for (let j = -rows; j <= rows; j++) {
    const y = j * dy;
    const shift = Math.abs(j) % 2 === 1 ? dx / 2 : 0;
    const cols = Math.ceil(reach / dx) + 1;
    for (let i = -cols; i <= cols; i++) {
      const x = i * dx + shift;
      if (Math.hypot(x, y) <= reach) out.push({ center: offsetMeters(center, x, y), radiusM: Math.ceil(r) });
    }
  }
  // Nearest the base first: if the request budget runs out, the closest clinics are found.
  return out.sort((a, b) => distanceMeters(center, a.center) - distanceMeters(center, b.center));
}

/** The discovery grid for a rep's base and radius. */
export function discoveryGrid(center: LatLng, radiusM: number): Circle[] {
  return coverDisc(center, radiusM, cellRadiusFor(radiusM));
}

/** Child circles for a cell that returned a full page (20): half the radius. */
export function splitCircle(cell: Circle): Circle[] {
  const half = Math.max(MIN_CELL_RADIUS_M, Math.round(cell.radiusM / 2));
  if (half >= cell.radiusM) return [];
  return coverDisc(cell.center, cell.radiusM, half);
}

/** The rectangle around a disc (Text Search accepts only a rectangle as a location restriction). */
export function boundingRect(center: LatLng, radiusM: number): Rect {
  return { low: offsetMeters(center, -radiusM, -radiusM), high: offsetMeters(center, radiusM, radiusM) };
}

/** The four quarters of a rectangle (Text Search split when a rectangle has more than 60 results). */
export function splitRect(rect: Rect): Rect[] {
  const mid = { lat: round6((rect.low.lat + rect.high.lat) / 2), lng: round6((rect.low.lng + rect.high.lng) / 2) };
  return [
    { low: rect.low, high: mid },
    { low: { lat: rect.low.lat, lng: mid.lng }, high: { lat: mid.lat, lng: rect.high.lng } },
    { low: { lat: mid.lat, lng: rect.low.lng }, high: { lat: rect.high.lat, lng: mid.lng } },
    { low: mid, high: rect.high },
  ];
}
