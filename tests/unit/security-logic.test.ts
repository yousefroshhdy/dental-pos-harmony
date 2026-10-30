import { describe, expect, it } from "vitest";
import { parseDbError } from "@/lib/errors";
import {
  authErrorKey,
  defaultFactorName,
  formatSecret,
  isMfaRequired,
  isSafeQrDataUrl,
  isStepUpAuthError,
  mfaStanding,
  needsStepUp,
  normaliseTotpCode,
  sortFactors,
  stepUpFactor,
  stepUpHref,
  stepUpReturnPath,
} from "@/modules/security/logic";
import type { FactorRow } from "@/modules/security/types";

const factor = (id: string, status: FactorRow["status"], created_at: string, friendly_name: string | null = null): FactorRow => ({
  id,
  status,
  created_at,
  friendly_name,
});

describe("MFA_REQUIRED error mapping", () => {
  // What PostgREST returns when authz.require refuses an aal1 session.
  const dbError = { code: "42501", message: "MFA_REQUIRED: finance.payment.reverse needs a session verified with your authenticator app" };

  it("parseDbError keeps the MFA_REQUIRED business code", () => {
    const error = parseDbError(dbError, "req-1");
    expect(error.code).toBe("MFA_REQUIRED");
    expect(isMfaRequired(error)).toBe(true);
  });

  it("a plain permission denial is not a step-up", () => {
    const error = parseDbError({ code: "42501", message: "PERMISSION_DENIED: finance.payment.reverse" });
    expect(isMfaRequired(error)).toBe(false);
    expect(isMfaRequired(null)).toBe(false);
  });

  it("an AppError's code is enough for the step-up prompt (no extra flag needed)", () => {
    const error = parseDbError(dbError);
    expect(needsStepUp({ ok: false, code: error.code, messageKey: error.messageKey })).toBe(true);
    expect(error.messageKey).toBe("MFA_REQUIRED");
  });

  it("needsStepUp recognises the flag, a raw code, or a nested AppError", () => {
    expect(needsStepUp({ ok: false, mfaRequired: true })).toBe(true);
    expect(needsStepUp({ ok: false, code: "MFA_REQUIRED" })).toBe(true);
    expect(needsStepUp({ ok: false, error: { code: "MFA_REQUIRED" } })).toBe(true);
    expect(needsStepUp({ ok: false, messageKey: "PERMISSION_DENIED" })).toBe(false);
    expect(needsStepUp({ ok: true, mfaRequired: true })).toBe(false);
    expect(needsStepUp(null)).toBe(false);
    expect(needsStepUp("MFA_REQUIRED")).toBe(false);
  });
});

describe("Supabase Auth error mapping", () => {
  it.each([
    ["mfa_verification_failed", "INVALID_CODE"],
    ["mfa_challenge_expired", "CODE_EXPIRED"],
    ["mfa_factor_not_found", "FACTOR_NOT_FOUND"],
    ["too_many_enrolled_mfa_factors", "TOO_MANY_FACTORS"],
    ["mfa_factor_name_conflict", "NAME_TAKEN"],
    ["mfa_totp_enroll_not_enabled", "TOTP_DISABLED"],
    ["insufficient_aal", "STEP_UP_FIRST"],
    ["over_request_rate_limit", "RATE_LIMITED"],
  ])("%s → %s", (code, key) => {
    expect(authErrorKey({ code, status: 400 })).toBe(key);
  });

  it("falls back by HTTP status", () => {
    expect(authErrorKey({ code: "something_new", status: 429 })).toBe("RATE_LIMITED");
    expect(authErrorKey({ code: "something_new", status: 503 })).toBe("UNAVAILABLE");
    expect(authErrorKey({ code: "something_new" })).toBe("UNAVAILABLE");
    expect(authErrorKey({ code: "something_new", status: 400 })).toBe("UNKNOWN");
    expect(authErrorKey(null)).toBe("UNKNOWN");
  });

  it("insufficient_aal on removal is a step-up", () => {
    expect(isStepUpAuthError({ code: "insufficient_aal" })).toBe(true);
    expect(isStepUpAuthError({ code: "mfa_verification_failed" })).toBe(false);
  });
});

describe("TOTP input", () => {
  it("normalises spaces, dashes and Arabic-Indic digits", () => {
    expect(normaliseTotpCode("123 456")).toBe("123456");
    expect(normaliseTotpCode("123-456")).toBe("123456");
    expect(normaliseTotpCode("١٢٣٤٥٦")).toBe("123456");
    expect(normaliseTotpCode("۱۲۳۴۵۶")).toBe("123456");
  });

  it("groups the secret in fours", () => {
    expect(formatSecret("ABCDEFGHIJKLMNOP")).toBe("ABCD EFGH IJKL MNOP");
    expect(formatSecret("ABCDEF")).toBe("ABCD EF");
  });

  it("accepts only image data URLs as the QR code", () => {
    expect(isSafeQrDataUrl("data:image/svg+xml;utf-8,<svg></svg>")).toBe(true);
    expect(isSafeQrDataUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeQrDataUrl("https://example.test/qr.svg")).toBe(false);
    expect(isSafeQrDataUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeQrDataUrl("data:text/html,<script></script>")).toBe(false);
  });
});

describe("factors", () => {
  const rows = [
    factor("c", "unverified", "2026-10-03T00:00:00Z"),
    factor("b", "verified", "2026-10-02T00:00:00Z"),
    factor("a", "verified", "2026-10-01T00:00:00Z"),
  ];

  it("sorts verified first, then oldest first", () => {
    expect(sortFactors(rows).map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  it("step-up uses the oldest verified factor, or none", () => {
    expect(stepUpFactor(rows)?.id).toBe("a");
    expect(stepUpFactor([factor("x", "unverified", "2026-10-01T00:00:00Z")])).toBeNull();
    expect(stepUpFactor([])).toBeNull();
  });

  it("picks a free default name", () => {
    expect(defaultFactorName("Authenticator app", [])).toBe("Authenticator app");
    expect(defaultFactorName("Authenticator app", ["Authenticator app", null])).toBe("Authenticator app 2");
    expect(defaultFactorName("Authenticator app", ["Authenticator app", "Authenticator app 2"])).toBe("Authenticator app 3");
  });

  it("derives what the account page says", () => {
    const verified = [factor("a", "verified", "2026-10-01T00:00:00Z")];
    const none: FactorRow[] = [];
    expect(mfaStanding({ aal: "aal2", required_permissions: [] }, verified)).toBe("protected");
    expect(mfaStanding({ aal: "aal1", required_permissions: ["admin.role.assign"] }, verified)).toBe("verifyNow");
    expect(mfaStanding({ aal: null, required_permissions: ["admin.role.assign"] }, none)).toBe("enrolNeeded");
    expect(mfaStanding({ aal: "aal1", required_permissions: [] }, none)).toBe("optional");
    expect(mfaStanding({ aal: "aal1", required_permissions: ["x.y.z"] }, [factor("u", "unverified", "2026-10-01T00:00:00Z")])).toBe(
      "enrolNeeded",
    );
  });
});

describe("step-up link (MFA_REQUIRED → My security → back)", () => {
  it("links to the account page of the current locale with the current path as next", () => {
    expect(stepUpHref("ar", "/ar/inventory/transfers/new")).toBe("/ar/account/security?next=%2Far%2Finventory%2Ftransfers%2Fnew");
    expect(stepUpHref("en", "/en/admin/settings")).toBe("/en/account/security?next=%2Fen%2Fadmin%2Fsettings");
  });

  it("keeps a query string in next, encoded", () => {
    expect(stepUpHref("en", "/en/commissions/periods?period=2026-09")).toBe(
      "/en/account/security?next=%2Fen%2Fcommissions%2Fperiods%3Fperiod%3D2026-09",
    );
  });

  it("leaves next out when there is nothing useful or safe to return to", () => {
    for (const path of [null, undefined, "", "/ar", "/en", "/ar/account/security", "/ar/account/security?next=%2Far%2Fx", "/en/login?next=/en/x"]) {
      expect(stepUpHref("ar", path)).toBe("/ar/account/security");
    }
  });

  it("never builds an open redirect", () => {
    for (const path of ["//evil.example/ar", "https://evil.example/ar/x", "/\\evil.example", "/xx/inventory", "inventory", "/ar/x\r\nSet-Cookie:a"]) {
      expect(stepUpHref("en", path)).toBe("/en/account/security");
    }
  });
});

describe("stepUpReturnPath (the account page's ?next=)", () => {
  it("accepts a same-origin, locale-prefixed path", () => {
    expect(stepUpReturnPath("/ar/finance/payments/abc", "ar")).toBe("/ar/finance/payments/abc");
    expect(stepUpReturnPath("/en/audit?table=crm.customers", "ar")).toBe("/en/audit?table=crm.customers");
  });

  it("rejects anything else", () => {
    for (const next of [undefined, null, 42, ["/ar/x"], "", "/ar", "//evil.example", "https://evil.example/ar", "/ar/login", "/en/account/security", "/ar/account/security#x", "x".repeat(600)]) {
      expect(stepUpReturnPath(next, "ar")).toBeNull();
    }
  });

  it("does not mistake a longer path for the account page", () => {
    expect(stepUpReturnPath("/ar/account/security-log", "ar")).toBe("/ar/account/security-log");
  });
});
