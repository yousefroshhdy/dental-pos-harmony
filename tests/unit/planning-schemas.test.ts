import { describe, expect, it } from "vitest";
import { addVisitSchema, MAX_VISITS_PER_PLAN, savePlanSchema, setFrequencySchema, unplanSchema, visitsFromForm } from "@/modules/planning/schemas";

const CUSTOMER = "42000000-0000-0000-0000-000000000001";
const REF = "42e00000-0000-0000-0000-000000000001";
const EMP = "20000000-0000-0000-0000-000000000004";

describe("addVisitSchema", () => {
  it("accepts one visit with a device client ref", () => {
    expect(addVisitSchema.safeParse({ customer_id: CUSTOMER, date: "2026-11-02", client_ref: REF }).success).toBe(true);
    expect(addVisitSchema.safeParse({ employee_id: EMP, customer_id: CUSTOMER, date: "2026-11-02", client_ref: REF }).success).toBe(true);
  });

  it("refuses a malformed day, a missing client ref and unknown fields", () => {
    expect(addVisitSchema.safeParse({ customer_id: CUSTOMER, date: "2026-02-30", client_ref: REF }).success).toBe(false);
    expect(addVisitSchema.safeParse({ customer_id: CUSTOMER, date: "2026-11-02" }).success).toBe(false);
    expect(addVisitSchema.safeParse({ customer_id: "x", date: "2026-11-02", client_ref: REF }).success).toBe(false);
    expect(addVisitSchema.safeParse({ customer_id: CUSTOMER, date: "2026-11-02", client_ref: REF, price: "1" }).success).toBe(false);
  });
});

describe("savePlanSchema", () => {
  const visit = { customer_id: CUSTOMER, date: "2026-11-02" };
  it("needs 1 to 200 visits", () => {
    expect(savePlanSchema.safeParse({ employee_id: EMP, client_ref: REF, visits: [visit] }).success).toBe(true);
    expect(savePlanSchema.safeParse({ employee_id: EMP, client_ref: REF, visits: [] }).success).toBe(false);
    expect(
      savePlanSchema.safeParse({ employee_id: EMP, client_ref: REF, visits: Array.from({ length: MAX_VISITS_PER_PLAN + 1 }, () => visit) }).success,
    ).toBe(false);
  });

  it("reads the checked proposals from the form, dropping malformed values", () => {
    const form = new FormData();
    form.append("visit", `${CUSTOMER}|2026-11-02`);
    form.append("visit", "broken");
    form.append("visit", `${CUSTOMER}|2026-11-31`);
    form.append("other", `${CUSTOMER}|2026-11-03`);
    expect(visitsFromForm(form)).toEqual([{ customer_id: CUSTOMER, date: "2026-11-02" }]);
  });
});

describe("unplan and frequency", () => {
  it("validates ids and classes", () => {
    expect(unplanSchema.safeParse({ visit_id: REF }).success).toBe(true);
    expect(unplanSchema.safeParse({ visit_id: "nope" }).success).toBe(false);
    expect(setFrequencySchema.safeParse({ customer_id: CUSTOMER, visit_class: "B" }).success).toBe(true);
    expect(setFrequencySchema.safeParse({ customer_id: CUSTOMER, visit_class: "D" }).success).toBe(false);
  });
});
