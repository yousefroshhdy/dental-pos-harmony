import { describe, expect, it } from "vitest";
import { distanceMeters, type LatLng } from "@/lib/maps/geo";
import { boundingRect, cellRadiusFor, coverDisc, discoveryGrid, offsetMeters, splitCircle, splitRect, type Circle } from "@/lib/places/grid";

const MANSOURA: LatLng = { lat: 31.0409, lng: 31.3785 };
const ASWAN: LatLng = { lat: 24.0889, lng: 32.8998 };

/** Deterministic points spread over the disc: rings and spokes, plus the edge itself. */
function samplePoints(center: LatLng, radiusM: number): LatLng[] {
  const out: LatLng[] = [center];
  for (let ring = 1; ring <= 24; ring++) {
    const r = (radiusM * ring) / 24;
    const spokes = 12 * ring;
    for (let k = 0; k < spokes; k++) {
      const a = (2 * Math.PI * k) / spokes + ring * 0.37;
      out.push(offsetMeters(center, r * Math.cos(a), r * Math.sin(a)));
    }
  }
  return out;
}

function uncovered(points: LatLng[], circles: Circle[]): LatLng[] {
  return points.filter((p) => !circles.some((c) => distanceMeters(p, c.center) <= c.radiusM));
}

describe("lead discovery grid (hex packing)", () => {
  it.each([
    ["Mansoura, 5 km (decision E)", MANSOURA, 5000],
    ["Mansoura, 0.5 km", MANSOURA, 500],
    ["Mansoura, 2.3 km", MANSOURA, 2300],
    ["Aswan, 12 km", ASWAN, 12_000],
    ["Mansoura, 50 km (largest radius)", MANSOURA, 50_000],
  ])("covers every point of the disc: %s", (_name, center, radius) => {
    const grid = discoveryGrid(center, radius);
    expect(uncovered(samplePoints(center, radius), grid)).toEqual([]);
  });

  it("covers the disc for any cell size, not only the default", () => {
    for (const cell of [250, 600, 1000, 1700]) {
      expect(uncovered(samplePoints(MANSOURA, 5000), coverDisc(MANSOURA, 5000, cell)), `cell ${cell} m`).toEqual([]);
    }
  });

  it("uses a sensible number of requests for 5 km (about 30 circles of 1.25 km)", () => {
    const grid = discoveryGrid(MANSOURA, 5000);
    expect(cellRadiusFor(5000)).toBe(1250);
    expect(grid.length).toBeGreaterThanOrEqual(20);
    expect(grid.length).toBeLessThanOrEqual(45);
    expect(new Set(grid.map((c) => c.radiusM))).toEqual(new Set([1250]));
  });

  it("every circle touches the disc (no wasted request far outside)", () => {
    for (const c of discoveryGrid(MANSOURA, 5000)) expect(distanceMeters(MANSOURA, c.center)).toBeLessThanOrEqual(5000 + c.radiusM + 1);
  });

  it("orders circles nearest the base first, so a cut budget still finds the closest clinics", () => {
    const d = discoveryGrid(MANSOURA, 5000).map((c) => distanceMeters(MANSOURA, c.center));
    expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(d[0]).toBeLessThan(1);
  });

  it("a small disc is one request", () => {
    expect(discoveryGrid(MANSOURA, 800)).toEqual([{ center: MANSOURA, radiusM: 800 }]);
  });

  it("rejects a non-positive radius", () => {
    expect(() => discoveryGrid(MANSOURA, 0)).toThrow(RangeError);
    expect(() => coverDisc(MANSOURA, 1000, -1)).toThrow(RangeError);
  });

  it("splits a full cell into half-size circles that cover it", () => {
    const cell: Circle = { center: MANSOURA, radiusM: 1250 };
    const children = splitCircle(cell);
    expect(children.length).toBeGreaterThan(1);
    expect(children.every((c) => c.radiusM === 625)).toBe(true);
    expect(uncovered(samplePoints(MANSOURA, 1250), children)).toEqual([]);
    expect(splitCircle({ center: MANSOURA, radiusM: 250 })).toEqual([]); // smallest cell
  });

  it("the Text Search rectangle contains the disc, and its quarters tile it", () => {
    const rect = boundingRect(MANSOURA, 5000);
    for (const p of samplePoints(MANSOURA, 5000)) {
      expect(p.lat).toBeGreaterThanOrEqual(rect.low.lat);
      expect(p.lat).toBeLessThanOrEqual(rect.high.lat);
      expect(p.lng).toBeGreaterThanOrEqual(rect.low.lng);
      expect(p.lng).toBeLessThanOrEqual(rect.high.lng);
    }
    const quarters = splitRect(rect);
    expect(quarters).toHaveLength(4);
    expect(quarters[0]?.low).toEqual(rect.low);
    expect(quarters[3]?.high).toEqual(rect.high);
  });
});
