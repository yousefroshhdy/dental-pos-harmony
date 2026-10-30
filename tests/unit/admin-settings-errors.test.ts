import { describe, expect, it } from "vitest";
import { parseDbError } from "@/lib/errors";
import { failedResult } from "@/modules/admin/logic";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

/** Value at a dotted message path, or undefined. */
function lookup(tree: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((n, k) => (typeof n === "object" && n !== null ? (n as Record<string, unknown>)[k] : undefined), tree);
}

/** The message path the settings page renders for a failed result (see ErrorMessage in action-message.tsx). */
function renderedPath(result: ReturnType<typeof failedResult>): string {
  if (result.ok) throw new Error("expected a failure");
  return result.adminCode ? `admin.errors.${result.adminCode}` : `errors.${result.messageKey}`;
}

// The errors api.update_setting raises after 20261104000400_settings_hardening.sql (audit 4: A-H1, A-L3).
const CASES = [
  {
    name: "security.* at aal1 while MFA is enforced",
    db: { code: "42501", message: "MFA_REQUIRED: security.mfa_enforced needs a session verified with your authenticator app" },
    path: "errors.MFA_REQUIRED",
  },
  {
    name: "an admin changing an owner-only workflow limit",
    db: { code: "42501", message: "OWNER_ONLY: wf.delegation.max_days is an owner-only setting" },
    path: "errors.OWNER_ONLY",
  },
  {
    name: "a logo that is not a same-origin image path",
    db: { code: "P0001", message: "VALIDATION: company.logo_url must be a path on this site ending in .png, .svg, .jpg, .jpeg or .webp, e.g. /brand/logo.svg" },
    path: "errors.VALIDATION",
  },
  {
    name: "a text value over its maximum length",
    db: { code: "P0001", message: "SETTING_OUT_OF_RANGE: company.address_en must be 0 to 500 characters" },
    path: "admin.errors.SETTING_OUT_OF_RANGE",
  },
  {
    name: "a value containing a key",
    db: { code: "P0001", message: "SETTING_SECRET_REFUSED: company.address_en looks like a secret; secrets belong in the server environment" },
    path: "admin.errors.SETTING_SECRET_REFUSED",
  },
] as const;

describe("settings errors reach the admin settings page translated", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const result = failedResult(parseDbError(c.db, "req-1"));
      expect(result.ok).toBe(false);
      expect(renderedPath(result)).toBe(c.path);
      expect(lookup(en, c.path)).toEqual(expect.any(String));
      expect(lookup(ar, c.path)).toEqual(expect.any(String));
      // Admin codes are rendered from admin.errors.*; every other code needs its own errors.* key.
      if (!result.ok && !result.adminCode) expect(result.messageKey).not.toBe("UNKNOWN");
    });
  }

  it("never carries the raw database message to the browser", () => {
    const result = failedResult(parseDbError(CASES[0].db, "req-1"));
    expect(JSON.stringify(result)).not.toContain("security.mfa_enforced");
    expect(result).toEqual({ ok: false, messageKey: "MFA_REQUIRED", requestId: "req-1" });
  });
});
