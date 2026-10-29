import { describe, expect, it } from "vitest";
import { crmNav } from "@/modules/crm/nav";
import {
  createCustomerSchema,
  createOpportunitySchema,
  customerListParamsSchema,
  firstValues,
  formToObject,
  invalidFieldsOf,
  logActivitySchema,
  moveOpportunitySchema,
  reassignSchema,
  setLocationSchema,
  updateCustomerSchema,
} from "@/modules/crm/schemas";

// Synthetic values only (D-03).
const ID = "40000000-0000-0000-0000-000000000001";
const REF = "c1000000-0000-0000-0000-000000000001";

const newCustomer = {
  clinic_name: "Sample Dental Center",
  phone_primary: "010 0123-4567",
  governorate_code: "eg-c",
  client_ref: REF,
  locale: "ar",
};

describe("createCustomerSchema", () => {
  it("normalises the phone and governorate and applies defaults", () => {
    const parsed = createCustomerSchema.parse({ ...newCustomer, tags: "vip, implants", phone_secondary: "٠١١١٢٣٤٥٦٧٨" });
    expect(parsed.phone_primary).toBe("+201001234567");
    expect(parsed.phone_secondary).toBe("+201112345678");
    expect(parsed.governorate_code).toBe("EG-C");
    expect(parsed.kind).toBe("clinic");
    expect(parsed.source).toBe("field");
    expect(parsed.tags).toEqual(["implants", "vip"]);
  });

  it("needs a clinic or a doctor name", () => {
    const result = createCustomerSchema.safeParse({ ...newCustomer, clinic_name: undefined });
    expect(result.success).toBe(false);
    if (!result.success) expect(invalidFieldsOf(result.error)).toEqual(["clinic_name"]);
    expect(createCustomerSchema.safeParse({ ...newCustomer, clinic_name: undefined, doctor_name: "Dr. Test" }).success).toBe(true);
  });

  it("rejects a missing or invalid phone", () => {
    for (const phone of [undefined, "12345", "+14155550100"]) {
      const result = createCustomerSchema.safeParse({ ...newCustomer, phone_primary: phone });
      expect(result.success).toBe(false);
      if (!result.success) expect(invalidFieldsOf(result.error)).toContain("phone_primary");
    }
  });

  it("rejects unknown kinds, sources and malformed governorates or emails", () => {
    expect(createCustomerSchema.safeParse({ ...newCustomer, kind: "shop" }).success).toBe(false);
    expect(createCustomerSchema.safeParse({ ...newCustomer, source: "cold_call" }).success).toBe(false);
    expect(createCustomerSchema.safeParse({ ...newCustomer, governorate_code: "Cairo" }).success).toBe(false);
    expect(createCustomerSchema.safeParse({ ...newCustomer, email: "not-an-email" }).success).toBe(false);
  });

  it("requires an idempotency key", () => {
    expect(createCustomerSchema.safeParse({ ...newCustomer, client_ref: undefined }).success).toBe(false);
    expect(createCustomerSchema.safeParse({ ...newCustomer, client_ref: "abc" }).success).toBe(false);
  });

  it("only accepts the literal confirmation flag", () => {
    expect(createCustomerSchema.parse({ ...newCustomer, confirm_duplicates: "1" }).confirm_duplicates).toBe("1");
    expect(createCustomerSchema.safeParse({ ...newCustomer, confirm_duplicates: "yes" }).success).toBe(false);
  });
});

describe("updateCustomerSchema", () => {
  const edit = { ...newCustomer, client_ref: undefined, customer_id: ID, version: "3" };

  it("coerces the version and accepts a lifecycle stage", () => {
    const parsed = updateCustomerSchema.parse({ ...edit, lifecycle_stage: "prospect" });
    expect(parsed.version).toBe(3);
    expect(parsed.lifecycle_stage).toBe("prospect");
  });

  it("rejects a missing version or an unknown stage", () => {
    expect(updateCustomerSchema.safeParse({ ...edit, version: undefined }).success).toBe(false);
    expect(updateCustomerSchema.safeParse({ ...edit, lifecycle_stage: "vip" }).success).toBe(false);
  });
});

describe("logActivitySchema", () => {
  it("accepts manual types and converts Cairo time", () => {
    const parsed = logActivitySchema.parse({ customer_id: ID, type: "whatsapp", summary: "Sent the sample catalogue", occurred_at: "2026-01-15T10:30" });
    expect(parsed.occurred_at).toBe("2026-01-15T08:30:00.000Z");
  });

  it("leaves the time empty for now", () => {
    expect(logActivitySchema.parse({ customer_id: ID, type: "call", summary: "ok" }).occurred_at).toBeUndefined();
  });

  it("rejects system-only types", () => {
    for (const type of ["visit", "order", "payment", "stage_change", "assignment"]) {
      expect(logActivitySchema.safeParse({ customer_id: ID, type, summary: "x y" }).success).toBe(false);
    }
  });
});

describe("other action schemas", () => {
  it("reassignment needs a target and a reason", () => {
    expect(reassignSchema.safeParse({ customer_id: ID, to_employee_id: ID, reason: "territory change" }).success).toBe(true);
    const missing = reassignSchema.safeParse({ customer_id: ID, to_employee_id: ID });
    expect(missing.success).toBe(false);
    if (!missing.success) expect(invalidFieldsOf(missing.error)).toEqual(["reason"]);
  });

  it("location must be inside Egypt with an accuracy", () => {
    expect(setLocationSchema.safeParse({ customer_id: ID, latitude: "30.0444", longitude: "31.2357", accuracy_m: "12" }).success).toBe(true);
    expect(setLocationSchema.safeParse({ customer_id: ID, latitude: "51.5", longitude: "-0.12", accuracy_m: "5" }).success).toBe(false);
    expect(setLocationSchema.safeParse({ customer_id: ID, latitude: "30.0444", longitude: "31.2357" }).success).toBe(false);
  });

  it("opportunity value accepts thousands separators and refuses negatives", () => {
    expect(createOpportunitySchema.parse({ customer_id: ID, title: "Sample kit", expected_value: "12,500.50", locale: "en" }).expected_value).toBe(12500.5);
    expect(createOpportunitySchema.parse({ customer_id: ID, title: "Sample kit", locale: "en" }).expected_value).toBeUndefined();
    expect(createOpportunitySchema.safeParse({ customer_id: ID, title: "Sample kit", expected_value: "-1", locale: "en" }).success).toBe(false);
    expect(createOpportunitySchema.safeParse({ customer_id: ID, title: "Sample kit", expected_close_date: "29/10/2026", locale: "en" }).success).toBe(false);
  });

  it("a lost opportunity needs a reason", () => {
    expect(moveOpportunitySchema.safeParse({ opportunity_id: ID, stage: "qualified" }).success).toBe(true);
    const lost = moveOpportunitySchema.safeParse({ opportunity_id: ID, stage: "lost" });
    expect(lost.success).toBe(false);
    if (!lost.success) expect(invalidFieldsOf(lost.error)).toEqual(["lost_reason"]);
    expect(moveOpportunitySchema.safeParse({ opportunity_id: ID, stage: "lost", lost_reason: "chose a competitor" }).success).toBe(true);
    expect(moveOpportunitySchema.safeParse({ opportunity_id: ID, stage: "closed" }).success).toBe(false);
  });
});

describe("customer list params", () => {
  it("keeps valid filters and drops invalid ones instead of failing", () => {
    expect(customerListParamsSchema.parse({ q: " sample ", stage: "lead", territory: ID, specialty: "GP", page: "2" })).toEqual({
      q: "sample",
      stage: "lead",
      territory: ID,
      specialty: "GP",
      page: 2,
    });
    expect(customerListParamsSchema.parse({ stage: "vip", territory: "x", specialty: "a b", page: "-3" })).toEqual({
      q: undefined,
      stage: undefined,
      territory: undefined,
      specialty: undefined,
      page: 1,
    });
    expect(customerListParamsSchema.parse({}).page).toBe(1);
  });

  it("takes the first value of repeated params", () => {
    expect(firstValues({ q: ["a", "b"], stage: "", page: undefined })).toEqual({ q: "a" });
  });

  it("formToObject trims and drops empty strings", () => {
    const form = new FormData();
    form.set("a", "  x ");
    form.set("b", "   ");
    expect(formToObject(form)).toEqual({ a: "x" });
  });
});

describe("crm navigation", () => {
  it("shows each screen only with its read permission", () => {
    expect(crmNav).toEqual([
      { href: "/customers", labelKey: "crm.nav.customers", permission: "crm.customer.read" },
      { href: "/opportunities", labelKey: "crm.nav.opportunities", permission: "crm.opportunity.read" },
    ]);
  });
});
