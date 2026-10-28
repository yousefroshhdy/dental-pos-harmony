import { describe, expect, it } from "vitest";
import { networkError, parseDbError } from "@/lib/errors";

describe("parseDbError", () => {
  it("uses the CODE: prefix raised by api.* commands", () => {
    const e = parseDbError({ code: "42501", message: "ESCALATION_BLOCKED: you do not hold finance.invoice.read" }, "req-1");
    expect(e.code).toBe("ESCALATION_BLOCKED");
    expect(e.messageKey).toBe("ESCALATION_BLOCKED");
    expect(e.retryable).toBe(false);
    expect(e.requestId).toBe("req-1");
  });

  it("keeps untranslated business codes but shows the generic message", () => {
    const e = parseDbError({ code: "P0001", message: "INSUFFICIENT_STOCK: warehouse x would go to -5" });
    expect(e.code).toBe("INSUFFICIENT_STOCK");
    expect(e.messageKey).toBe("UNKNOWN");
  });

  it("falls back to the SQLSTATE mapping", () => {
    expect(parseDbError({ code: "42501", message: "permission denied for table orders" }).code).toBe("PERMISSION_DENIED");
    expect(parseDbError({ code: "23505", message: "duplicate key value" }).code).toBe("DUPLICATE");
    expect(parseDbError({ code: "P0002", message: "no rows" }).code).toBe("NOT_FOUND");
  });

  it("marks serialization failures and deadlocks retryable", () => {
    expect(parseDbError({ code: "40001", message: "could not serialize access" }).retryable).toBe(true);
    expect(parseDbError({ code: "40P01", message: "deadlock detected" }).retryable).toBe(true);
  });

  it("never exposes raw SQL as the message key", () => {
    const e = parseDbError({ code: "XX000", message: "internal error at line 3" });
    expect(e.code).toBe("UNKNOWN");
    expect(e.messageKey).toBe("UNKNOWN");
    expect(e.detail).toContain("internal error");
  });

  it("treats network failures as retryable UNAVAILABLE", () => {
    const e = networkError(new TypeError("fetch failed"));
    expect(e).toMatchObject({ code: "UNAVAILABLE", messageKey: "UNAVAILABLE", retryable: true });
  });
});
