import { describe, expect, it } from "vitest";
import { enrolSchema, factorSchema, formToFields, stepUpSchema, verifyEnrolmentSchema } from "@/modules/security/schemas";

const ID = "8f3c2a10-0000-4000-8000-000000000001";

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("security schemas", () => {
  it("step-up code: exactly six digits after normalising", () => {
    expect(stepUpSchema.parse({ code: "123 456" })).toEqual({ code: "123456" });
    expect(stepUpSchema.parse({ code: "١٢٣٤٥٦" })).toEqual({ code: "123456" });
    expect(stepUpSchema.safeParse({ code: "12345" }).success).toBe(false);
    expect(stepUpSchema.safeParse({ code: "1234567" }).success).toBe(false);
    expect(stepUpSchema.safeParse({ code: "12a456" }).success).toBe(false);
    expect(stepUpSchema.safeParse({}).success).toBe(false);
  });

  it("enrolment confirmation needs a factor id and a code", () => {
    expect(verifyEnrolmentSchema.parse({ factor_id: ID, code: "000111" })).toEqual({ factor_id: ID, code: "000111" });
    expect(verifyEnrolmentSchema.safeParse({ factor_id: "not-an-id", code: "000111" }).success).toBe(false);
    expect(factorSchema.safeParse({ factor_id: ID }).success).toBe(true);
    expect(factorSchema.safeParse({}).success).toBe(false);
  });

  it("friendly name is optional and at most 60 characters", () => {
    expect(enrolSchema.parse({})).toEqual({});
    expect(enrolSchema.parse({ friendly_name: "  My phone " })).toEqual({ friendly_name: "My phone" });
    expect(enrolSchema.safeParse({ friendly_name: "x".repeat(61) }).success).toBe(false);
  });

  it("formToFields keeps only the named, non-empty fields", () => {
    expect(formToFields(form({ code: " 123456 ", factor_id: "", extra: "x" }), ["code", "factor_id"])).toEqual({ code: "123456" });
  });
});
