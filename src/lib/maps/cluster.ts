import { boundsOf, type Bounds, type LatLng } from "./geo";

/**
 * Grid clustering for markers (no extra dependency): points are projected to Web Mercator
 * pixels at the current zoom and grouped by grid cell. Cheap enough for a few thousand
 * customers; re-run on every zoom change.
 */

export type ClusterEntry<T extends LatLng> =
  | { kind: "point"; item: T }
  | { kind: "cluster"; key: string; count: number; center: LatLng; bounds: Bounds; items: T[] };

export interface ClusterOptions {
  /** Cell size in screen pixels. */
  gridPx?: number;
  /** From this zoom on, never cluster (every clinic is visible on its own). */
  maxZoom?: number;
  /** Fewer points than this are never clustered. */
  minPoints?: number;
}

const TILE = 256;

/** Web Mercator pixel coordinates at `zoom` (latitude clamped to the projection's range). */
export function project(p: LatLng, zoom: number): { x: number; y: number } {
  const size = TILE * 2 ** zoom;
  const lat = Math.max(-85.05112878, Math.min(85.05112878, p.lat));
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((p.lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

export function clusterPoints<T extends LatLng>(points: readonly T[], zoom: number, options: ClusterOptions = {}): ClusterEntry<T>[] {
  const { gridPx = 60, maxZoom = 15, minPoints = 20 } = options;
  if (zoom >= maxZoom || points.length < minPoints) return points.map((item) => ({ kind: "point", item }));

  const cells = new Map<string, T[]>();
  for (const p of points) {
    const { x, y } = project(p, zoom);
    const key = `${Math.floor(x / gridPx)}:${Math.floor(y / gridPx)}`;
    const cell = cells.get(key);
    if (cell) cell.push(p);
    else cells.set(key, [p]);
  }

  const out: ClusterEntry<T>[] = [];
  for (const [key, items] of cells) {
    if (items.length === 1) {
      out.push({ kind: "point", item: items[0]! });
      continue;
    }
    const center = {
      lat: items.reduce((s, p) => s + p.lat, 0) / items.length,
      lng: items.reduce((s, p) => s + p.lng, 0) / items.length,
    };
    out.push({ kind: "cluster", key, count: items.length, center, bounds: boundsOf(items)!, items });
  }
  return out;
}
