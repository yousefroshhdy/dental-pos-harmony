import { describe, expect, it } from "vitest";
import { adjustmentSchema, formToObject, invalidFieldsOf, parseEmployeeParam, periodActionSchema } from "@/modules/commissions/schemas";

const EMP = "20000000-0000-0000-0000-000000000004";
const KEY = "c3900000-0000-0000-0000-0000000000aa";
const valid = { employee_id: EMP, period: "2026-10", amount: "250.00", kind: "bonus", reason: "Quarterly bonus", idempotency_key: KEY };

describe("commission schemas", () => {
  it("period actions take a month key only", () => {
    expect(periodActionSchema.safeParse({ period: "2026-09" }).success).toBe(true);
    expect(periodActionSchema.safeParse({ period: "2026-09-01" }).success).toBe(false);
    expect(periodActionSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a well-formed adjustment and parses its amount", () => {
    const r = adjustmentSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amount).toBe(250);
  });

  it("refuses a sign that does not match the kind", () => {
    const r = adjustmentSchema.safeParse({ ...valid, amount: "-250" });
    expect(r.success).toBe(false);
    if (!r.success) expect(invalidFieldsOf(r.error)).toContain("amount");
    expect(adjustmentSchema.safeParse({ ...valid, kind: "clawback", amount: "-250" }).success).toBe(true);
    expect(adjustmentSchema.safeParse({ ...valid, kind: "correction", amount: "-0.01" }).success).toBe(true);
  });

  it("refuses bad ids, kinds, amounts and short reasons", () => {
    expect(adjustmentSchema.safeParse({ ...valid, employee_id: "x" }).success).toBe(false);
    expect(adjustmentSchema.safeParse({ ...valid, kind: "gift" }).success).toBe(false);
    expect(adjustmentSchema.safeParse({ ...valid, amount: "0" }).success).toBe(false);
    expect(adjustmentSchema.safeParse({ ...valid, amount: "1.005" }).success).toBe(false);
    const short = adjustmentSchema.safeParse({ ...valid, reason: "ok" });
    expect(short.success).toBe(false);
    if (!short.success) expect(invalidFieldsOf(short.error)).toEqual(["reason"]);
    expect(adjustmentSchema.safeParse({ ...valid, idempotency_key: undefined }).success).toBe(false);
  });

  it("never takes a computed amount from the client beyond the requested adjustment", () => {
    const r = adjustmentSchema.safeParse({ ...valid, commission_amount: "999", rate_pct: "50" });
    expect(r.success).toBe(true);
    if (r.success) expect(Object.keys(r.data).sort()).toEqual(["amount", "employee_id", "idempotency_key", "kind", "period", "reason"]);
  });

  it("parses the employee query parameter", () => {
    expect(parseEmployeeParam(EMP)).toBe(EMP);
    expect(parseEmployeeParam([EMP, "x"])).toBe(EMP);
    expect(parseEmployeeParam("me")).toBeNull();
    expect(parseEmployeeParam(undefined)).toBeNull();
  });

  it("formToObject trims and drops empty fields", () => {
    const f = new FormData();
    f.set("period", " 2026-09 ");
    f.set("reason", "   ");
    expect(formToObject(f)).toEqual({ period: "2026-09" });
  });
});
