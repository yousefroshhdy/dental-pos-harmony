import { describe, expect, it } from "vitest";
import { fail, networkError, ok, parseDbError } from "@/lib/errors";
import { toSendResult, versionConflictOf } from "@/lib/offline/result";
import { classifyFailure } from "@/lib/offline/sync";

/** Error texts copied from the migrations (crm_field_commands, orders_inventory_workflow). */
describe("toSendResult (server action → queued sender answer)", () => {
  it("passes success data through, replay included", () => {
    expect(toSendResult(ok({ visit_id: "v-1", replayed: true }))).toEqual({ ok: true, data: { visit_id: "v-1", replayed: true } });
    expect(toSendResult(ok(undefined))).toEqual({ ok: true, data: null });
  });

  it("update_customer CONFLICT with a current_version detail is a version conflict", () => {
    const error = parseDbError(
      {
        code: "P0001",
        message: "CONFLICT: customer was changed by someone else (your version 2, current 3)",
        details: '{"current_version": 3, "updated_at": "2026-10-29T08:00:00+00:00"}',
      },
      "req-9",
    );
    const result = toSendResult(fail(error));
    expect(result).toEqual({
      ok: false,
      error: {
        code: "CONFLICT",
        messageKey: "CONFLICT",
        retryable: false,
        ambiguous: false,
        requestId: "req-9",
        conflict: { currentVersion: 3, server: { current_version: 3, updated_at: "2026-10-29T08:00:00+00:00" } },
      },
    });
    if (!result.ok) expect(classifyFailure(result.error, true)).toBe("conflict");
  });

  it("save_order_draft 'current version N' message is a version conflict", () => {
    const error = parseDbError({ code: "P0001", message: "CONFLICT: order changed (current version 7)" });
    expect(versionConflictOf(error)).toEqual({ currentVersion: 7 });
  });

  it("a client ref reused by another user is a plain failure, not a conflict", () => {
    const result = toSendResult(fail(parseDbError({ code: "P0001", message: "CONFLICT: client_ref was already used by another request" })));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.conflict).toBeUndefined();
      expect(classifyFailure(result.error, true)).toBe("failed");
    }
  });

  it("a concurrent send of the same client ref is safe to retry (the next answer is the replay)", () => {
    const result = toSendResult(fail(parseDbError({ code: "P0001", message: "CONFLICT: a concurrent request used the same client_ref" })));
    if (!result.ok) expect(classifyFailure(result.error, true)).toBe("transient");
  });

  it("serialization failure is retryable; a lost connection is ambiguous", () => {
    const serialization = toSendResult(fail(parseDbError({ code: "40001", message: "could not serialize access" })));
    const lost = toSendResult(fail(networkError(new Error("socket hang up"))));
    expect(serialization.ok || serialization.error).toMatchObject({ retryable: true, ambiguous: false });
    expect(lost.ok || lost.error).toMatchObject({ code: "UNAVAILABLE", retryable: false, ambiguous: true });
  });

  it("business codes keep their code, and the developer detail never crosses to the client", () => {
    const result = toSendResult(
      fail(parseDbError({ code: "P0001", message: "INSUFFICIENT_STOCK: only 2 left in lot L-TEST", details: "secret-ish detail" })),
    );
    expect(result.ok || result.error).toMatchObject({ code: "INSUFFICIENT_STOCK", messageKey: "UNKNOWN" });
    expect(JSON.stringify(result)).not.toMatch(/secret-ish|L-TEST/);
  });
});
