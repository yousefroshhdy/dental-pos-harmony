import { describe, expect, it } from "vitest";
import {
  createRoleSchema,
  formToObject,
  grantRoleSchema,
  invalidFieldsOf,
  inviteUserSchema,
  normalizeEgyptPhone,
  revokeRoleSchema,
  setRolePermissionSchema,
  suspendUserSchema,
  validationMessageKey,
} from "@/modules/admin/schemas";

const UID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const RID = "00000000-0000-0000-0000-000000000001"; // fixture-style id, not RFC v4

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

describe("formToObject", () => {
  it("trims values, drops empty strings and files", () => {
    const f = form({ a: "  x ", b: "   ", c: "" });
    f.append("file", new Blob(["x"]), "x.txt");
    expect(formToObject(f)).toEqual({ a: "x" });
  });
});

describe("normalizeEgyptPhone", () => {
  it.each([
    ["010 1234 5678", "+201012345678"],
    ["+20 115-123-4567", "+201151234567"],
    ["00201212345678", "+201212345678"],
    ["201512345678", "+201512345678"],
    ["02 2345 6789", "+20223456789"],
  ])("normalizes %s", (raw, expected) => {
    expect(normalizeEgyptPhone(raw)).toBe(expected);
  });

  it.each(["0131234567", "+441234567890", "12345", "01312345678"])("rejects %s", (raw) => {
    expect(normalizeEgyptPhone(raw)).toBeNull();
  });
});

describe("reason-bearing actions", () => {
  it("requires a reason of at least 3 characters and reports REASON_REQUIRED", () => {
    const r = suspendUserSchema.safeParse(formToObject(form({ user_id: UID, reason: "  " })));
    expect(r.success).toBe(false);
    if (!r.success) expect(validationMessageKey(r.error)).toBe("REASON_REQUIRED");
  });

  it("reports VALIDATION when only the id is wrong", () => {
    const r = suspendUserSchema.safeParse({ user_id: "not-a-uuid", reason: "left the company" });
    expect(r.success).toBe(false);
    if (!r.success) expect(validationMessageKey(r.error)).toBe("VALIDATION");
  });

  it("accepts fixture-style ids", () => {
    expect(revokeRoleSchema.safeParse({ user_role_id: RID, user_id: UID, reason: "moved team" }).success).toBe(true);
  });
});

describe("grantRoleSchema", () => {
  it("treats an empty territory as no binding", () => {
    const r = grantRoleSchema.parse(formToObject(form({ user_id: UID, role_id: RID, territory_id: "", reason: "new hire" })));
    expect(r.territory_id).toBeUndefined();
  });
});

describe("createRoleSchema", () => {
  it("enforces the same code pattern as api.create_role", () => {
    expect(createRoleSchema.safeParse({ code: "area_manager", name_en: "Area manager", locale: "ar" }).success).toBe(true);
    expect(createRoleSchema.safeParse({ code: "Area-Manager", name_en: "Area manager", locale: "ar" }).success).toBe(false);
    expect(createRoleSchema.safeParse({ code: "ab", name_en: "Too short", locale: "en" }).success).toBe(false);
  });
});

describe("setRolePermissionSchema", () => {
  const base = { role_id: RID, permission: "sales.discount.apply", scope: "team" };

  it("maps an empty limit to undefined (NULL = unlimited)", () => {
    const r = setRolePermissionSchema.parse(formToObject(form({ ...base, limit: "" })));
    expect(r.limit).toBeUndefined();
  });

  it("parses a numeric limit and rejects negatives and junk", () => {
    expect(setRolePermissionSchema.parse({ ...base, limit: "7.5" }).limit).toBe(7.5);
    expect(setRolePermissionSchema.safeParse({ ...base, limit: "-1" }).success).toBe(false);
    expect(setRolePermissionSchema.safeParse({ ...base, limit: "abc" }).success).toBe(false);
  });

  it("only accepts known scopes and well-formed permission codes", () => {
    expect(setRolePermissionSchema.safeParse({ ...base, scope: "galaxy" }).success).toBe(false);
    expect(setRolePermissionSchema.safeParse({ ...base, permission: "drop table" }).success).toBe(false);
  });
});

describe("inviteUserSchema", () => {
  const valid = {
    employee_no: "E-104",
    full_name_en: "Mona Adel",
    job_title: "Sales rep",
    email: "Mona.Adel@Honest.example",
    locale: "ar",
  };

  it("lower-cases the email and normalizes the phone", () => {
    const r = inviteUserSchema.parse({ ...valid, phone: "010 1234 5678" });
    expect(r.email).toBe("mona.adel@honest.example");
    expect(r.phone).toBe("+201012345678");
    expect(r.full_name_ar).toBeUndefined();
  });

  it("names every invalid field", () => {
    const r = inviteUserSchema.safeParse({ ...valid, email: "nope", phone: "123", locale: "fr" });
    expect(r.success).toBe(false);
    if (!r.success) expect(invalidFieldsOf(r.error).sort()).toEqual(["email", "locale", "phone"]);
  });

  it("accepts resume ids from a previous partial run", () => {
    const r = inviteUserSchema.parse({ ...valid, resume_employee_id: RID, resume_user_id: UID });
    expect(r.resume_employee_id).toBe(RID);
    expect(r.resume_user_id).toBe(UID);
  });
});
