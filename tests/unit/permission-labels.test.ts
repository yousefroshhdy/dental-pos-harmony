import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { permissionLabel, permissionLabelKey } from "@/lib/i18n/permission-label";
import ar from "../../messages/ar/permissions.json";
import en from "../../messages/en/permissions.json";

const ROOT = join(__dirname, "../..");
const suite39 = readFileSync(join(ROOT, "supabase/tests/database/39_mfa.test.sql"), "utf8");
const migrations = readdirSync(join(ROOT, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(ROOT, "supabase/migrations", f), "utf8"))
  .join("\n");

/** The MFA-gated set pinned by suite 39, plus admin.import.run (excluded there by name). */
function mfaGated(): string[] {
  const m = suite39.match(/where requires_mfa and code <> 'admin\.import\.run'\),\s*array\[([^\]]+)\]/);
  if (!m?.[1]) throw new Error("suite 39 MFA array not found");
  return [...m[1].matchAll(/'([a-z_.]+)'/g)].map((x) => x[1] ?? "").concat("admin.import.run");
}
const decide = [...new Set([...migrations.matchAll(/'(wf\.decide\.[a-z_]+)'/g)].map((x) => x[1] ?? ""))];

function translator(messages: { label: Record<string, string> }) {
  const get = (key: string) => messages.label[key.replace(/^label\./, "")];
  const t = (key: string) => get(key) as string;
  t.has = (key: string) => get(key) !== undefined;
  return t;
}

describe("permission labels", () => {
  it.each([...mfaGated(), ...decide])("%s has an Arabic and an English label", (code) => {
    const key = permissionLabelKey(code).replace(/^label\./, "");
    expect(en.label).toHaveProperty([key]);
    expect(ar.label).toHaveProperty([key]);
    expect(permissionLabel(translator(en), code)).not.toBe(code);
  });

  it("covers the whole MFA set (sanity: suite 39 parsed)", () => {
    expect(mfaGated().length).toBeGreaterThanOrEqual(20);
    expect(decide).toContain("wf.decide.order_discount");
  });

  it("falls back to the code for an unknown permission", () => {
    expect(permissionLabel(translator(en), "x.y.z")).toBe("x.y.z");
  });

  it("ar and en have the same keys", () => {
    expect(Object.keys(ar.label).sort()).toEqual(Object.keys(en.label).sort());
  });
});
