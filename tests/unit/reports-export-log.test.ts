import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppError } from "@/lib/errors";
import { loggableFilters, refusalName } from "@/modules/reports/export";
import { EXPORT_KINDS, EXPORT_PERMISSIONS } from "@/modules/reports/kinds";
import { filterKeysOf } from "@/modules/reports/schemas";

// The database export gate (api.log_export) keeps its own whitelist of kinds, permissions and
// filter keys. It must match the app: a kind or filter the app sends but the database does not
// know would make every such export fail closed, and a weaker database rule would let PostgREST
// callers log exports the app would refuse.
const MIGRATION = join(__dirname, "../../supabase/migrations/20261104000710_audit4_export_log.sql");

function dbWhitelist(): Record<string, { perms: string[][]; filters: string[] }> {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = /-- export-kinds:begin\n\$json\$([\s\S]*?)\$json\$\n-- export-kinds:end/.exec(sql);
  if (!m?.[1]) throw new Error("export-kinds markers not found");
  return JSON.parse(m[1]) as Record<string, { perms: string[][]; filters: string[] }>;
}

describe("export whitelist: database and app agree", () => {
  const db = dbWhitelist();

  it("lists exactly the app's export kinds", () => {
    expect(Object.keys(db).sort()).toEqual([...EXPORT_KINDS].sort());
  });

  it("requires the same permissions per kind", () => {
    for (const kind of EXPORT_KINDS) {
      expect(db[kind]?.perms, kind).toEqual(EXPORT_PERMISSIONS[kind].map((all) => [...all]));
    }
  });

  it("accepts every filter key the app can send, and no other", () => {
    for (const kind of EXPORT_KINDS) {
      expect([...(db[kind]?.filters ?? [])].sort(), kind).toEqual(filterKeysOf(kind).sort());
    }
  });
});

describe("export log helpers", () => {
  it("redacts free-text search and drops unset values", () => {
    expect(loggableFilters({ q: "Dr Ahmed +201001234567", stage: "active", territory: undefined, from: "" })).toEqual({
      q: "[redacted]",
      stage: "active",
    });
    expect(loggableFilters({ status: "all", from: "2026-10-01" })).toEqual({ status: "all", from: "2026-10-01" });
  });

  it("names each refusal for the JSON error body", () => {
    const e = (code: string) => ({ code }) as AppError;
    expect(refusalName(e("PERMISSION_DENIED"))).toBe("forbidden");
    expect(refusalName(e("MFA_REQUIRED"))).toBe("mfa_required");
    expect(refusalName(e("RATE_LIMITED"))).toBe("rate_limited");
    expect(refusalName(e("UNAVAILABLE"))).toBe("export_failed");
  });
});
