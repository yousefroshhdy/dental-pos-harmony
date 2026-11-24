import "server-only";
import { distanceMeters, type LatLng } from "@/lib/maps/geo";
import { placesFetch } from "./client";
import { boundingRect, discoveryGrid, splitCircle, splitRect, type Circle, type Rect } from "./grid";
import {
  isFatalError,
  MAX_RESULTS_PER_REQUEST,
  MAX_TEXT_PAGES,
  nearbyRequest,
  parseSearchPlaces,
  textRequest,
  type FoundPlace,
} from "./requests";

/**
 * One discovery run against Places API (New), within a request budget:
 *   1. Nearby Search (dentist, dental_clinic) over the hex grid, nearest cells first;
 *   2. Text Search "عيادة أسنان" over the disc's bounding rectangle (up to 3 pages);
 *   3. while budget is left: a full Nearby cell (20) is split into half-size circles, and a
 *      rectangle whose third page was full is split into quarters (one level each).
 * Places are de-duplicated by place id; only those inside the radius are kept, each with its
 * distance from the base. The coordinates go to the database call that checks the 50 m customer
 * rule and are dropped there (never stored, never logged).
 */

export interface DiscoveredPlace {
  place_id: string;
  distance_m: number;
  lat: number;
  lng: number;
}

export interface DiscoveryResult {
  places: DiscoveredPlace[];
  nearbyRequests: number;
  textRequests: number;
  /** The budget (or the time limit) ran out before the plan was done. */
  truncated: boolean;
  /** Set when the run should be recorded as failed (a key/API problem, or every request failed). */
  errorCode: string | null;
}

export interface DiscoveryInput {
  key: string;
  center: LatLng;
  radiusM: number;
  maxRequests: number;
  fetchImpl?: typeof fetch;
  /** Epoch ms after which no new request starts (serverless time limit). */
  deadline?: number;
  now?: () => number;
}

/** Keep the first occurrence of each place id. */
export function dedupeByPlaceId<T extends { placeId: string }>(places: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of places) {
    if (seen.has(p.placeId)) continue;
    seen.add(p.placeId);
    out.push(p);
  }
  return out;
}

/** Inside the radius, with the distance from the base (metres, 0.1 m), nearest first. */
export function withinRadius(center: LatLng, radiusM: number, places: readonly FoundPlace[]): DiscoveredPlace[] {
  return dedupeByPlaceId(places)
    .map((p) => ({ place_id: p.placeId, lat: p.lat, lng: p.lng, distance_m: Math.round(distanceMeters(center, p) * 10) / 10 }))
    .filter((p) => p.distance_m <= radiusM)
    .sort((a, b) => a.distance_m - b.distance_m);
}

type Job = { kind: "nearby"; cell: Circle; depth: number } | { kind: "text"; rect: Rect; depth: number };

export async function discoverPlaces(input: DiscoveryInput): Promise<DiscoveryResult> {
  const now = input.now ?? Date.now;
  const found: FoundPlace[] = [];
  let nearby = 0;
  let text = 0;
  let failures = 0;
  let fatal: string | null = null;
  let lastError: string | null = null;
  let truncated = false;

  const queue: Job[] = [
    ...discoveryGrid(input.center, input.radiusM).map((cell) => ({ kind: "nearby" as const, cell, depth: 0 })),
    { kind: "text", rect: boundingRect(input.center, input.radiusM), depth: 0 },
  ];
  const used = () => nearby + text;

  while (queue.length > 0) {
    if (used() >= input.maxRequests || (input.deadline !== undefined && now() >= input.deadline)) {
      truncated = true;
      break;
    }
    const job = queue.shift() as Job;
    if (job.kind === "nearby") {
      nearby += 1;
      const res = await placesFetch(nearbyRequest(input.key, job.cell), input.fetchImpl);
      if (!res.ok) {
        failures += 1;
        lastError = res.code;
        if (isFatalError(res.code)) {
          fatal = res.code;
          break;
        }
        continue;
      }
      const { places } = parseSearchPlaces(res.body);
      found.push(...places);
      if (places.length >= MAX_RESULTS_PER_REQUEST && job.depth < 1) {
        queue.push(...splitCircle(job.cell).map((cell) => ({ kind: "nearby" as const, cell, depth: job.depth + 1 })));
      }
    } else {
      let token: string | undefined;
      let pages = 0;
      let lastFull = false;
      do {
        if (used() >= input.maxRequests || (input.deadline !== undefined && now() >= input.deadline)) {
          truncated = true;
          break;
        }
        text += 1;
        pages += 1;
        const res = await placesFetch(textRequest(input.key, job.rect, token), input.fetchImpl);
        if (!res.ok) {
          failures += 1;
          lastError = res.code;
          if (isFatalError(res.code)) fatal = res.code;
          break;
        }
        const page = parseSearchPlaces(res.body);
        found.push(...page.places);
        lastFull = page.places.length >= MAX_RESULTS_PER_REQUEST;
        token = page.nextPageToken ?? undefined;
      } while (token && pages < MAX_TEXT_PAGES);
      if (fatal) break;
      if (truncated) break;
      if (pages >= MAX_TEXT_PAGES && lastFull && token && job.depth < 1) {
        queue.push(...splitRect(job.rect).map((rect) => ({ kind: "text" as const, rect, depth: job.depth + 1 })));
      }
    }
  }

  const made = used();
  const allFailed = made > 0 && failures === made;
  return {
    places: withinRadius(input.center, input.radiusM, found),
    nearbyRequests: nearby,
    textRequests: text,
    truncated,
    errorCode: fatal ?? (allFailed ? lastError : null),
  };
}
