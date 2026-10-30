import { describe, expect, it } from "vitest";
import {
  assignTerritorySchema,
  coverageSchema,
  createEmployeeSchema,
  createTerritorySchema,
  employmentStatusSchema,
  moveTerritorySchema,
  normalizeDigits,
  parseSettingValue,
  removeCoverageSchema,
  territoryActiveSchema,
  updateEmployeeSchema,
  updateSettingSchema,
} from "@/modules/admin/schemas";

const ID = "20000000-0000-0000-0000-000000000004"; // fixture-style id, not RFC v4
const ID2 = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

describe("normalizeDigits", () => {
  it("turns Arabic-Indic and Persian digits into ASCII", () => {
    expect(normalizeDigits("١٥٠")).toBe("150");
    expect(normalizeDigits("۱۲")).toBe("12");
    expect(normalizeDigits("١٤٫٥")).toBe("14.5");
    expect(normalizeDigits("abc 12")).toBe("abc 12");
  });
});

describe("parseSettingValue", () => {
  it("reads integers, including Arabic digits", () => {
    expect(parseSettingValue("integer", { value: " 200 " })).toEqual({ ok: true, value: 200 });
    expect(parseSettingValue("integer", { value: "٢٠٠" })).toEqual({ ok: true, value: 200 });
    expect(parseSettingValue("integer", { value: "1.5" })).toEqual({ ok: false });
    expect(parseSettingValue("integer", { value: "" })).toEqual({ ok: false });
    expect(parseSettingValue("integer", { value: "1e3" })).toEqual({ ok: false });
  });

  it("reads numbers with at most two decimals", () => {
    expect(parseSettingValue("number", { value: "14.5" })).toEqual({ ok: true, value: 14.5 });
    expect(parseSettingValue("number", { value: "14.555" })).toEqual({ ok: false });
  });

  it("reads booleans, text and enums", () => {
    expect(parseSettingValue("boolean", { value: "true" })).toEqual({ ok: true, value: true });
    expect(parseSettingValue("boolean", { value: "yes" })).toEqual({ ok: false });
    expect(parseSettingValue("text", { value: "  Honest  " })).toEqual({ ok: true, value: "Honest" });
    expect(parseSettingValue("text", { value: "   " })).toEqual({ ok: false });
    expect(parseSettingValue("enum", { value: "daily" })).toEqual({ ok: true, value: "daily" });
  });

  it("reads checkbox lists (an empty list is left for the database to refuse)", () => {
    expect(parseSettingValue("enum_array", { values: ["sun", "mon", "sun"] })).toEqual({ ok: true, value: ["sun", "mon"] });
    expect(parseSettingValue("enum_array", { values: [] })).toEqual({ ok: true, value: [] });
    expect(parseSettingValue("enum_array", { values: ["Sun;drop"] })).toEqual({ ok: false });
  });

  it("reads HH:MM ranges", () => {
    expect(parseSettingValue("time_range", { start: "09:00", end: "17:00" })).toEqual({ ok: true, value: { start: "09:00", end: "17:00" } });
    expect(parseSettingValue("time_range", { start: "9:00", end: "17:00" })).toEqual({ ok: false });
    expect(parseSettingValue("time_range", { start: "09:00" })).toEqual({ ok: false });
  });
});

describe("updateSettingSchema", () => {
  it("accepts a dotted key and a known type", () => {
    expect(updateSettingSchema.safeParse({ key: "tracking.work_days", value_type: "enum_array" }).success).toBe(true);
    expect(
      updateSettingSchema.safeParse({ key: "field.geofence_radius_m", value_type: "integer", expected_updated_at: "2026-10-30T10:00:00.123456+00:00" })
        .success,
    ).toBe(true);
  });

  it("rejects malformed keys, unknown types and bad timestamps", () => {
    expect(updateSettingSchema.safeParse({ key: "nodot", value_type: "integer" }).success).toBe(false);
    expect(updateSettingSchema.safeParse({ key: "a.b; drop", value_type: "integer" }).success).toBe(false);
    expect(updateSettingSchema.safeParse({ key: "a.b", value_type: "json" }).success).toBe(false);
    expect(updateSettingSchema.safeParse({ key: "a.b", value_type: "integer", expected_updated_at: "yesterday" }).success).toBe(false);
  });
});

describe("employee schemas", () => {
  const base = { full_name_en: "Test Person", job_title: "Sales Representative" };

  it("creates with the minimum and normalises the phone", () => {
    const parsed = createEmployeeSchema.safeParse({ ...base, employee_no: "E100", phone: "010 1234 5678", locale: "ar" });
    expect(parsed.success && parsed.data.phone).toBe("+201012345678");
  });

  it("accepts Arabic digits in the phone", () => {
    const parsed = createEmployeeSchema.safeParse({ ...base, employee_no: "E100", phone: "٠١٠١٢٣٤٥٦٧٨", locale: "en" });
    expect(parsed.success && parsed.data.phone).toBe("+201012345678");
  });

  it("rejects an invalid phone, email or date", () => {
    expect(createEmployeeSchema.safeParse({ ...base, employee_no: "E1", phone: "12345", locale: "ar" }).success).toBe(false);
    expect(createEmployeeSchema.safeParse({ ...base, employee_no: "E1", email: "nope", locale: "ar" }).success).toBe(false);
    expect(createEmployeeSchema.safeParse({ ...base, employee_no: "E1", hired_on: "30/10/2026", locale: "ar" }).success).toBe(false);
  });

  it("update needs the id and the concurrency token", () => {
    expect(updateEmployeeSchema.safeParse({ ...base, employee_id: ID }).success).toBe(false);
    expect(updateEmployeeSchema.safeParse({ ...base, employee_id: ID, expected_updated_at: "2026-10-30T10:00:00Z", manager_id: ID2 }).success).toBe(true);
    expect(updateEmployeeSchema.safeParse({ ...base, employee_id: ID, expected_updated_at: "2026-10-30T10:00:00Z", manager_id: "x" }).success).toBe(false);
  });

  it("status changes need a known status and a reason", () => {
    expect(employmentStatusSchema.safeParse({ employee_id: ID, status: "terminated", reason: "left" }).success).toBe(true);
    expect(employmentStatusSchema.safeParse({ employee_id: ID, status: "fired", reason: "left" }).success).toBe(false);
    expect(employmentStatusSchema.safeParse({ employee_id: ID, status: "suspended" }).success).toBe(false);
  });

  it("territory assignment types are member or manager", () => {
    expect(assignTerritorySchema.safeParse({ employee_id: ID, territory_id: ID2, assignment: "manager" }).success).toBe(true);
    expect(assignTerritorySchema.safeParse({ employee_id: ID, territory_id: ID2, assignment: "owner" }).success).toBe(false);
  });
});

describe("territory schemas", () => {
  it("upper-cases codes and checks their shape", () => {
    const parsed = createTerritorySchema.safeParse({ code: " cai-east ", name_en: "Cairo East", name_ar: "شرق القاهرة" });
    expect(parsed.success && parsed.data.code).toBe("CAI-EAST");
    expect(createTerritorySchema.safeParse({ code: "-bad", name_en: "x", name_ar: "س" }).success).toBe(false);
    expect(createTerritorySchema.safeParse({ code: "OK", name_en: "x" }).success).toBe(false);
  });

  it("'root' moves a territory to the top level", () => {
    const parsed = moveTerritorySchema.safeParse({ territory_id: ID, parent_id: "root" });
    expect(parsed.success && parsed.data.parent_id).toBeNull();
    const under = moveTerritorySchema.safeParse({ territory_id: ID, parent_id: ID2 });
    expect(under.success && under.data.parent_id).toBe(ID2);
    expect(moveTerritorySchema.safeParse({ territory_id: ID }).success).toBe(false);
  });

  it("activation flag is a strict true/false with a reason", () => {
    const parsed = territoryActiveSchema.safeParse({ territory_id: ID, active: "false", reason: "merged" });
    expect(parsed.success && parsed.data.active).toBe(false);
    expect(territoryActiveSchema.safeParse({ territory_id: ID, active: "no", reason: "merged" }).success).toBe(false);
    expect(territoryActiveSchema.safeParse({ territory_id: ID, active: "true" }).success).toBe(false);
  });

  it("coverage takes an ISO governorate code and an optional city", () => {
    expect(coverageSchema.safeParse({ territory_id: ID, governorate_code: "EG-C" }).success).toBe(true);
    expect(coverageSchema.safeParse({ territory_id: ID, governorate_code: "EG-C", city: "Heliopolis" }).success).toBe(true);
    expect(coverageSchema.safeParse({ territory_id: ID, governorate_code: "Cairo" }).success).toBe(false);
    expect(removeCoverageSchema.safeParse({ governorate_code: "EG-ALX", city: "*" }).success).toBe(true);
  });
});
