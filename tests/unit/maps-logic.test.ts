import { describe, expect, it } from "vitest";
import { clusterPoints, project } from "@/lib/maps/cluster";
import { loaderOptions, mapsKeyConfigured, mapsKeyState, mapsLanguage, normalizeMapsKey, shouldLoadMaps } from "@/lib/maps/config";
import { boundsOf, directionsUrl, distanceMeters, insideEgypt, placeUrl, toLatLng } from "@/lib/maps/geo";
import {
  activeFilterCount,
  buildDayRoute,
  customerTone,
  filterQuery,
  freshness,
  lastVisitCondition,
  minusDays,
  minutesSince,
  pinnedCustomers,
  toMapsFailure,
} from "@/modules/maps/logic";
import { decideProposalSchema, mapLocationSchema, parseCustomerMapFilters } from "@/modules/maps/schemas";
import type { CustomerMapRow, VisitFix } from "@/modules/maps/types";
import type { DayGap, DayPoint, DayShift, DayStop, DayVisit } from "@/modules/tracking/types";

// Synthetic ids and places only (D-03).
const KEY = "AIzaSyTEST0000000000000000000000000000";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("maps key (the 'Map key not configured' state)", () => {
  it.each([undefined, null, "", "   ", "not a key", "short", "with spaces in it 1234567890", "x".repeat(101)])("treats %j as missing", (raw) => {
    expect(normalizeMapsKey(raw)).toBeNull();
    expect(mapsKeyConfigured(raw)).toBe(false);
    const state = mapsKeyState(raw);
    expect(state).toEqual({ status: "missing" });
    expect(shouldLoadMaps(state)).toBe(false);
  });

  it("accepts a browser key (trimmed) and only then allows loading", () => {
    expect(normalizeMapsKey(`  ${KEY}\n`)).toBe(KEY);
    const state = mapsKeyState(KEY);
    expect(state).toEqual({ status: "ready", key: KEY });
    expect(shouldLoadMaps(state)).toBe(true);
    expect(mapsKeyConfigured(KEY)).toBe(true);
  });

  it("loads in the app language with region EG (Arabic by default)", () => {
    expect(mapsLanguage("en")).toBe("en");
    expect(mapsLanguage("ar")).toBe("ar");
    expect(mapsLanguage(undefined)).toBe("ar");
    expect(mapsLanguage("fr")).toBe("ar");
    expect(loaderOptions(KEY, "ar")).toEqual({ key: KEY, v: "weekly", language: "ar", region: "EG" });
    expect(loaderOptions(KEY, "en").language).toBe("en");
  });
});

describe("geometry", () => {
  it("haversine distance matches known values", () => {
    expect(distanceMeters({ lat: 30, lng: 31 }, { lat: 30, lng: 31 })).toBe(0);
    // One degree of latitude ≈ 111.2 km.
    expect(distanceMeters({ lat: 30, lng: 31 }, { lat: 31, lng: 31 })).toBeCloseTo(111_195, -2);
    const a = { lat: 30.0444, lng: 31.2357 };
    const b = { lat: 31.0409, lng: 31.3785 };
    expect(distanceMeters(a, b)).toBeCloseTo(distanceMeters(b, a), 6);
    expect(distanceMeters(a, b) / 1000).toBeGreaterThan(110);
    expect(distanceMeters(a, b) / 1000).toBeLessThan(112);
  });

  it("Egypt box like the database", () => {
    expect(insideEgypt({ lat: 30.05, lng: 31.24 })).toBe(true);
    expect(insideEgypt({ lat: 33, lng: 31 })).toBe(false);
    expect(insideEgypt({ lat: 25, lng: 38 })).toBe(false);
  });

  it("parses PostgREST numerics and refuses junk", () => {
    expect(toLatLng("30.044400", "31.235700")).toEqual({ lat: 30.0444, lng: 31.2357 });
    expect(toLatLng(30, 31)).toEqual({ lat: 30, lng: 31 });
    for (const [a, b] of [[null, 31], [30, null], ["", ""], ["x", "1"], [95, 31], [30, 200]] as const) expect(toLatLng(a, b)).toBeNull();
  });

  it("builds Google Maps links with six decimals", () => {
    expect(directionsUrl({ lat: 30.0444, lng: 31.2357 })).toBe("https://www.google.com/maps/dir/?api=1&destination=30.044400%2C31.235700");
    expect(directionsUrl({ lat: 30.0444, lng: 31.2357 }, { lat: 30, lng: 31 })).toContain("&origin=30.000000%2C31.000000");
    expect(placeUrl({ lat: 30.1, lng: 31.2 })).toBe("https://www.google.com/maps/search/?api=1&query=30.100000%2C31.200000");
  });

  it("bounds", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([{ lat: 30, lng: 31 }, { lat: 31, lng: 30 }])).toEqual({ north: 31, south: 30, east: 31, west: 30 });
  });
});

describe("clustering", () => {
  const near = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, lat: 30.05 + i * 0.0001, lng: 31.24 }));
  const far = { id: "far", lat: 31.04, lng: 31.38 };

  it("projects to Web Mercator pixels", () => {
    expect(project({ lat: 0, lng: 0 }, 0)).toEqual({ x: 128, y: 128 });
    expect(project({ lat: 0, lng: 180 }, 1).x).toBe(512);
  });

  it("groups nearby points at low zoom and keeps lone points as points", () => {
    const out = clusterPoints([...near, far], 8);
    const clusters = out.filter((e) => e.kind === "cluster");
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.kind === "cluster" && clusters[0]!.count).toBe(30);
    expect(out.filter((e) => e.kind === "point").map((e) => e.kind === "point" && e.item.id)).toEqual(["far"]);
    const total = out.reduce((s, e) => s + (e.kind === "cluster" ? e.count : 1), 0);
    expect(total).toBe(31);
  });

  it("never clusters at street zoom or with few points", () => {
    expect(clusterPoints([...near, far], 15).every((e) => e.kind === "point")).toBe(true);
    expect(clusterPoints(near.slice(0, 5), 5).every((e) => e.kind === "point")).toBe(true);
  });
});

describe("customers map", () => {
  const row = (over: Partial<CustomerMapRow>): CustomerMapRow => ({
    id: ID(1),
    customer_no: "C-0001",
    display_name: "Synthetic Clinic",
    kind: "clinic",
    lifecycle_stage: "active",
    city: null,
    latitude: "30.050000",
    longitude: "31.240000",
    location_verified: true,
    territory_id: null,
    territory_name_en: null,
    territory_name_ar: null,
    primary_rep_employee_id: null,
    primary_rep_name_en: null,
    primary_rep_name_ar: null,
    is_overdue: false,
    max_days_overdue: null,
    last_visit_on: null,
    ...over,
  });

  it("colours overdue first, then by stage", () => {
    expect(customerTone(row({ is_overdue: true, lifecycle_stage: "prospect" }))).toBe("danger");
    expect(customerTone(row({ is_overdue: null, lifecycle_stage: "active" }))).toBe("success");
    expect(customerTone(row({ lifecycle_stage: "prospect" }))).toBe("info");
    expect(customerTone(row({ lifecycle_stage: "lead" }))).toBe("warning");
    expect(customerTone(row({ lifecycle_stage: "dormant" }))).toBe("muted");
  });

  it("keeps only rows with a usable pin, as numbers", () => {
    const pins = pinnedCustomers([row({}), row({ id: ID(2), latitude: null, longitude: null })]);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ id: ID(1), lat: 30.05, lng: 31.24 });
  });

  it("parses filters from search params and drops invalid values", () => {
    expect(parseCustomerMapFilters({ rep: ID(3), territory: "nope", stage: "active", overdue: "1", lastVisit: "60" })).toEqual({
      rep: ID(3),
      stage: "active",
      overdue: "1",
      lastVisit: "60",
    });
    expect(parseCustomerMapFilters({ stage: "vip", overdue: "yes", lastVisit: "7", rep: "" })).toEqual({});
    expect(parseCustomerMapFilters({ stage: ["prospect", "lead"] })).toEqual({ stage: "prospect" });
    expect(activeFilterCount({ stage: "active", overdue: "1" })).toBe(2);
    expect(filterQuery({ stage: "active", overdue: "1" })).toBe("?stage=active&overdue=1");
    expect(filterQuery({})).toBe("");
  });

  it("turns the last-visit filter into a date condition (Cairo date string)", () => {
    expect(minusDays("2026-03-01", 1)).toBe("2026-02-28");
    expect(lastVisitCondition(undefined, "2026-11-24")).toBeNull();
    expect(lastVisitCondition("never", "2026-11-24")).toEqual({ kind: "never" });
    expect(lastVisitCondition("30", "2026-11-24")).toEqual({ kind: "before", day: "2026-10-25" });
  });
});

describe("team map", () => {
  it("freshness of the last point", () => {
    const now = new Date("2026-11-24T10:00:00Z");
    expect(minutesSince("2026-11-24T09:50:30Z", now)).toBe(9);
    expect(minutesSince("2026-11-24T10:05:00Z", now)).toBe(0);
    expect(freshness(15)).toBe("fresh");
    expect(freshness(16)).toBe("stale");
    expect(freshness(61)).toBe("old");
  });
});

describe("rep day route (polyline and stops)", () => {
  const S1 = ID(101);
  const S2 = ID(102);
  const at = (min: number) => new Date(Date.UTC(2026, 10, 24, 6, 0) + min * 60_000).toISOString();
  const point = (n: number, shift: string, min: number, usable = true): DayPoint => ({
    id: ID(200 + n),
    shift_id: shift,
    captured_at: at(min),
    received_at: at(min),
    lat: 30 + n / 1000,
    lng: 31 + n / 1000,
    accuracy_m: 10,
    source: "pwa",
    anomaly_flags: usable ? [] : ["low_accuracy"],
    usable,
  });
  const shift = (id: string, start: number, end: number, open = false): DayShift => ({
    id,
    status: open ? "open" : "closed",
    start_at: at(start),
    end_at: at(end),
    open,
    seconds: (end - start) * 60,
    start_lat: 30,
    start_lng: 31,
    end_lat: 30.5,
    end_lng: 31.5,
    anomaly_flags: [],
  });
  const gap: DayGap = { shift_id: S1, start_at: at(10), end_at: at(40), seconds: 1800, ongoing: false };
  const stop: DayStop = { shift_id: S1, start_at: at(45), end_at: at(80), seconds: 2100, lat: 30.004, lng: 31.004, points: 7, in_visit: true, near_customer: true, flagged: false };
  const visit: DayVisit = {
    id: ID(301),
    customer_id: ID(401),
    customer_name: "Synthetic Clinic",
    status: "completed",
    verification_status: "verified",
    start_at: at(50),
    end_at: at(75),
    seconds: 1500,
    open: false,
  };
  const visitNoFix: DayVisit = { ...visit, id: ID(302), start_at: at(200), end_at: null, open: true };
  const fix: VisitFix = { visit_id: ID(301), customer_id: ID(401), event_type: "check_in", latitude: "30.004100", longitude: "31.004100", accuracy_m: 12, captured_at: at(50) };
  const checkOut: VisitFix = { ...fix, event_type: "check_out", captured_at: at(75) };

  const day = {
    // Out of order on purpose; one unusable point; a second shift.
    points: [point(3, S1, 40), point(1, S1, 0), point(2, S1, 10), point(9, S1, 41, false), point(4, S1, 50), point(5, S2, 300), point(6, S2, 310)],
    stops: [stop],
    gaps: [gap],
    visits: [visit, visitNoFix],
    shifts: [shift(S2, 290, 320), shift(S1, 0, 100)],
  };
  const route = buildDayRoute(day, [checkOut, fix]);

  it("orders usable points in time and splits the line at gaps and between shifts", () => {
    expect(route.segments).toEqual([
      [{ lat: 30.001, lng: 31.001 }, { lat: 30.002, lng: 31.002 }],
      [{ lat: 30.003, lng: 31.003 }, { lat: 30.004, lng: 31.004 }],
      [{ lat: 30.005, lng: 31.005 }, { lat: 30.006, lng: 31.006 }],
    ]);
  });

  it("draws each in-shift gap as a hop between the points around it", () => {
    expect(route.hops).toEqual([{ from: { lat: 30.002, lng: 31.002 }, to: { lat: 30.003, lng: 31.003 }, gap }]);
  });

  it("numbers stops and visit check-ins together, in time order", () => {
    expect(route.marks.map((m) => [m.n, m.kind])).toEqual([
      [1, "stop"],
      [2, "visit"],
    ]);
    const v = route.marks[1]!;
    expect(v.kind === "visit" && v.visit?.customer_name).toBe("Synthetic Clinic");
    expect(v).toMatchObject({ lat: 30.0041, lng: 31.0041 });
  });

  it("uses check-ins only (not check-outs) and lists visits without a fix", () => {
    expect(route.marks.filter((m) => m.kind === "visit")).toHaveLength(1);
    expect(route.visitsWithoutFix.map((v) => v.id)).toEqual([ID(302)]);
  });

  it("marks the start of the first shift and the end of the last closed one", () => {
    expect(route.start).toEqual({ lat: 30, lng: 31 });
    expect(route.end).toEqual({ lat: 30.5, lng: 31.5 });
    const open = buildDayRoute({ ...day, shifts: [shift(S1, 0, 100, true)] }, []);
    expect(open.end).toBeNull();
  });

  it("an empty day draws nothing", () => {
    const empty = buildDayRoute({ points: [], stops: [], gaps: [], visits: [], shifts: [] }, []);
    expect(empty).toEqual({ segments: [], hops: [], marks: [], visitsWithoutFix: [], start: null, end: null, extent: [] });
  });

  it("the extent covers everything drawn", () => {
    expect(route.extent.length).toBe(6 + 2 + 2);
  });
});

describe("actions input", () => {
  it("a rejection needs a reason; an approval does not", () => {
    expect(decideProposalSchema.safeParse({ proposal_id: ID(1), decision: "approve" }).success).toBe(true);
    expect(decideProposalSchema.safeParse({ proposal_id: ID(1), decision: "reject" }).success).toBe(false);
    expect(decideProposalSchema.safeParse({ proposal_id: ID(1), decision: "reject", note: "   " }).success).toBe(false);
    expect(decideProposalSchema.safeParse({ proposal_id: ID(1), decision: "reject", note: "across the street" }).success).toBe(true);
    expect(decideProposalSchema.safeParse({ proposal_id: "x", decision: "approve" }).success).toBe(false);
  });

  it("a map location must be inside Egypt", () => {
    expect(mapLocationSchema.safeParse({ customer_id: ID(1), latitude: "30.05", longitude: "31.24", source: "pin" }).success).toBe(true);
    expect(mapLocationSchema.safeParse({ customer_id: ID(1), latitude: "40", longitude: "31.24", source: "pin" }).success).toBe(false);
    expect(mapLocationSchema.safeParse({ customer_id: ID(1), latitude: "30", longitude: "31", source: "gps" }).success).toBe(false);
  });

  it("maps its own error codes and passes the rest through", () => {
    expect(toMapsFailure({ code: "ALREADY_PINNED", messageKey: "UNKNOWN", detail: "", retryable: false })).toEqual({
      ok: false,
      messageKey: "UNKNOWN",
      mapsCode: "ALREADY_PINNED",
      requestId: undefined,
    });
    expect(toMapsFailure({ code: "PERMISSION_DENIED", messageKey: "PERMISSION_DENIED", detail: "", retryable: false, requestId: "r1" })).toEqual({
      ok: false,
      messageKey: "PERMISSION_DENIED",
      requestId: "r1",
    });
  });
});
