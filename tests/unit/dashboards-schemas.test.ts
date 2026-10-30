import { describe, expect, it } from "vitest";
import { parseEmployeeParam, targetSchema } from "@/modules/dashboards/schemas";

const ID = "20000000-0000-0000-0000-000000000004";
const base = {
  target_id: "29f10000-0000-0000-0000-000000000001",
  kpi_code: "VISITS_COMPLETED",
  subject: "employee",
  employee_id: ID,
  period_start: "2026-09-01",
  period_end: "2026-09-30",
  target_value: "70",
};

describe("employee filter", () => {
  it("accepts an id, ignores anything else", () => {
    expect(parseEmployeeParam(ID)).toBe(ID);
    expect(parseEmployeeParam([ID, "x"])).toBe(ID);
    expect(parseEmployeeParam("'; drop table")).toBeNull();
    expect(parseEmployeeParam(undefined)).toBeNull();
  });
});

describe("target form", () => {
  it("parses a valid employee target", () => {
    const r = targetSchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.success && r.data.target_value).toBe(70);
  });
  it("needs the id of the chosen subject", () => {
    expect(targetSchema.safeParse({ ...base, subject: "role" }).success).toBe(false);
    expect(targetSchema.safeParse({ ...base, subject: "role", role_id: ID }).success).toBe(true);
  });
  it("rejects unknown KPIs, bad periods and negative values", () => {
    expect(targetSchema.safeParse({ ...base, kpi_code: "REVENUE_X" }).success).toBe(false);
    expect(targetSchema.safeParse({ ...base, period_end: "2026-08-31" }).success).toBe(false);
    expect(targetSchema.safeParse({ ...base, period_end: "2028-01-01" }).success).toBe(false);
    expect(targetSchema.safeParse({ ...base, period_start: "2026-02-30" }).success).toBe(false);
    expect(targetSchema.safeParse({ ...base, target_value: "-1" }).success).toBe(false);
    expect(targetSchema.safeParse({ ...base, target_id: "nope" }).success).toBe(false);
  });
});
