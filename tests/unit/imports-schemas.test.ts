import { describe, expect, it } from "vitest";
import { batchActionSchema, commitSchema, formToObject, kindParam, uploadSchema } from "@/modules/imports/schemas";

const form = (entries: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

describe("imports schemas", () => {
  it("formToObject keeps trimmed text fields and drops files and empty strings", () => {
    const obj = formToObject(form({ kind: " customers ", locale: "ar", empty: "  ", file: new Blob(["a"]) }));
    expect(obj).toEqual({ kind: "customers", locale: "ar" });
  });

  it("upload needs a known kind, an idempotency key and a locale", () => {
    expect(uploadSchema.safeParse({ kind: "opening_stock", idempotency_key: "2b0c9a3e-0000-4000-8000-000000000001", locale: "en" }).success).toBe(true);
    expect(uploadSchema.safeParse({ kind: "payroll", idempotency_key: "2b0c9a3e-0000-4000-8000-000000000001", locale: "en" }).success).toBe(false);
    expect(uploadSchema.safeParse({ kind: "customers", idempotency_key: "short", locale: "en" }).success).toBe(false);
    expect(uploadSchema.safeParse({ kind: "customers", idempotency_key: "2b0c9a3e-0000-4000-8000-000000000001", locale: "fr" }).success).toBe(false);
  });

  it("batch actions need a batch id; commit also needs the confirmation tick", () => {
    const id = "f8000000-0000-0000-0000-000000000001";
    expect(batchActionSchema.safeParse({ batch_id: id }).success).toBe(true);
    expect(batchActionSchema.safeParse({ batch_id: "1; drop" }).success).toBe(false);
    expect(commitSchema.safeParse({ batch_id: id }).success).toBe(false);
    expect(commitSchema.safeParse({ batch_id: id, confirm: "on" }).success).toBe(true);
  });

  it("route kinds are the import kinds", () => {
    expect(kindParam.safeParse("opening_ar").success).toBe(true);
    expect(kindParam.safeParse("../etc").success).toBe(false);
  });
});
