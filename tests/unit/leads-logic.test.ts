import { describe, expect, it } from "vitest";
import {
  collectAttributions,
  distanceParts,
  filterConditions,
  leadListHref,
  leadTitle,
  nextManualStatuses,
  outcomeMessageKey,
  parseClaim,
  percent,
  placeIdsNeedingDetails,
  toLeadsFailure,
} from "@/modules/leads/logic";
import { convertLeadSchema, formToObject, leadPlanSchema, parseLeadListParams, reassignLeadsSchema } from "@/modules/leads/schemas";

const ID = "11111111-1111-4111-8111-111111111111";

describe("leads logic", () => {
  it("offers only the manual status moves the database allows", () => {
    expect(nextManualStatuses("new")).toEqual(["visited", "not_interested"]);
    expect(nextManualStatuses("visited")).toEqual(["new", "not_interested"]);
    expect(nextManualStatuses("not_interested")).toEqual(["new"]);
    expect(nextManualStatuses("prospect")).toEqual([]);
    expect(nextManualStatuses("customer")).toEqual([]);
  });

  it("maps list filters to view conditions", () => {
    expect(filterConditions("open", "2026-11-24")).toEqual([{ column: "status", op: "in", value: ["new", "visited"] }]);
    expect(filterConditions("planned", "2026-11-24")).toEqual([{ column: "planned_for", op: "eq", value: "2026-11-24" }]);
    expect(filterConditions("converted", "2026-11-24")).toEqual([{ column: "status", op: "in", value: ["prospect", "customer"] }]);
    expect(filterConditions("all", "2026-11-24")).toEqual([]);
  });

  it("formats distances and percentages", () => {
    expect(distanceParts(812.4)).toEqual({ value: 810, unit: "m" });
    expect(distanceParts("1490.0")).toEqual({ value: 1.5, unit: "km" });
    expect(distanceParts(null)).toBeNull();
    expect(percent("50.0")).toBe("50%");
    expect(percent(33.3)).toBe("33.3%");
    expect(percent(null)).toBe("—");
  });

  it("loads live details only for leads without a CRM name, once per place", () => {
    expect(
      placeIdsNeedingDetails([
        { place_id: "a", customer_name: null },
        { place_id: "b", customer_name: "Our own name" },
        { place_id: "a", customer_name: null },
      ]),
    ).toEqual(["a"]);
    expect(leadTitle({ customer_name: "Ours", place_id: "a" }, null)).toBe("Ours");
    expect(leadTitle({ customer_name: null, place_id: "a" }, { placeId: "a", name: "Google", address: null, lat: null, lng: null, mapsUri: null, attributions: [] })).toBe("Google");
    expect(leadTitle({ customer_name: null, place_id: "a" }, undefined)).toBeNull();
  });

  it("collects third-party attributions once per provider", () => {
    const d = (provider: string) => ({ placeId: "a", name: null, address: null, lat: null, lng: null, mapsUri: null, attributions: [{ provider, providerUri: null }] });
    expect(collectAttributions([d("X"), d("X"), null, d("Y")])).toEqual([
      { provider: "X", providerUri: null },
      { provider: "Y", providerUri: null },
    ]);
  });

  it("parses the claim answer strictly", () => {
    expect(parseClaim({ status: "none" })).toEqual({ status: "none" });
    expect(parseClaim({ status: "claimed", run_id: ID, center: { lat: "31.04", lng: 31.37 }, radius_m: "5000", max_requests: 200 })).toEqual({
      status: "claimed",
      runId: ID,
      center: { lat: 31.04, lng: 31.37 },
      radiusM: 5000,
      maxRequests: 200,
    });
    expect(parseClaim({ status: "claimed", run_id: ID, center: {}, radius_m: 5000, max_requests: 200 })).toEqual({ status: "invalid" });
    expect(parseClaim({ status: "refused", run_id: ID, reason: "other" })).toEqual({ status: "invalid" });
    expect(parseClaim(null)).toEqual({ status: "invalid" });
  });

  it("names outcomes and errors", () => {
    expect(outcomeMessageKey({ status: "refused", runId: ID, reason: "daily_cap" })).toBe("refusedDaily");
    expect(outcomeMessageKey({ status: "done", runId: ID, requests: 3, leadsNew: 1, truncated: true, errorCode: null })).toBe("doneTruncated");
    expect(toLeadsFailure({ code: "DAILY_CAP", messageKey: "UNKNOWN", detail: "", retryable: false })).toEqual({
      ok: false,
      messageKey: "UNKNOWN",
      leadsCode: "DAILY_CAP",
      requestId: undefined,
    });
    expect(toLeadsFailure({ code: "NOT_FOUND", messageKey: "NOT_FOUND", detail: "", retryable: false })).toEqual({ ok: false, messageKey: "NOT_FOUND", requestId: undefined });
  });

  it("builds list links without defaults", () => {
    expect(leadListHref({ filter: "open", page: 1, view: "list" })).toBe("/leads");
    expect(leadListHref({ filter: "all", page: 2, view: "map", rep: ID })).toBe(`/leads?filter=all&view=map&rep=${ID}&page=2`);
  });
});

describe("leads schemas", () => {
  it("parses list params, falling back to the defaults", () => {
    expect(parseLeadListParams({})).toEqual({ filter: "open", page: 1, view: "list" });
    expect(parseLeadListParams({ filter: "converted", page: "3", view: "map", rep: ID })).toEqual({ filter: "converted", page: 3, view: "map", rep: ID });
    expect(parseLeadListParams({ filter: "bogus", page: "-1", view: "x", rep: "nope" })).toEqual({ filter: "open", page: 1, view: "list" });
  });

  it("the first visit needs a doctor or clinic name and a governorate; the phone is optional", () => {
    const base = { lead_id: ID, client_ref: ID, governorate_code: "EG-DK" };
    expect(convertLeadSchema.safeParse(base).success).toBe(false);
    expect(convertLeadSchema.safeParse({ ...base, clinic_name: "Synthetic Clinic" }).success).toBe(true);
    expect(convertLeadSchema.safeParse({ ...base, doctor_name: "Dr. Synthetic", phone: "01000000000" }).success).toBe(true);
    expect(convertLeadSchema.safeParse({ lead_id: ID, client_ref: ID, clinic_name: "X" }).success).toBe(false);
  });

  it("accepts one or many lead ids and requires a reason", () => {
    expect(reassignLeadsSchema.safeParse({ lead_ids: ID, employee_id: ID, reason: "split" }).success).toBe(true);
    expect(reassignLeadsSchema.safeParse({ lead_ids: [ID, ID], employee_id: ID, reason: "split" }).success).toBe(true);
    expect(reassignLeadsSchema.safeParse({ lead_ids: ID, employee_id: ID, reason: " " }).success).toBe(false);
  });

  it("plans need a calendar date", () => {
    expect(leadPlanSchema.safeParse({ lead_id: ID, date: "2026-11-24" }).data?.plan).toBe("add");
    expect(leadPlanSchema.safeParse({ lead_id: ID, date: "tomorrow" }).success).toBe(false);
  });

  it("turns repeated form keys into arrays and drops blanks", () => {
    const f = new FormData();
    f.append("lead_ids", "a");
    f.append("lead_ids", "b");
    f.append("reason", "  ");
    f.append("employee_id", " x ");
    expect(formToObject(f)).toEqual({ lead_ids: ["a", "b"], employee_id: "x" });
  });
});
