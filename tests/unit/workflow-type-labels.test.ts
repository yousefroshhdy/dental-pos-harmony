import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKFLOW_LABEL_KEYS as APPROVAL_KEYS, workflowLabelKey } from "@/modules/approvals/logic";
import { WORKFLOW_LABEL_KEYS as WORKFLOW_KEYS } from "@/modules/workflow/logic";

/**
 * Approval type names are stored in English only (wf.workflow_definitions.name).
 * Every seeded type code must have an Arabic and an English label in both
 * message modules that show it, so the Arabic UI never falls back to English.
 */

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

/** Codes inserted into wf.workflow_definitions by any migration. */
function seededWorkflowCodes(): string[] {
  const codes = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    if (!sql.includes("wf.workflow_definitions (code")) continue;
    // Value lists that feed the insert: the `defs(code, name, entity_type …) as (values …)` CTE
    // or a direct `insert into wf.workflow_definitions (code, name, entity_type) values …`.
    const blocks = [
      ...sql.matchAll(/defs\(code, name, entity_type[^)]*\) as \(values([\s\S]*?)\n\)/g),
      ...sql.matchAll(/wf\.workflow_definitions \(code, name, entity_type\)\s*values([\s\S]*?)(?:on conflict|;)/g),
    ];
    for (const block of blocks) {
      for (const m of (block[1] ?? "").matchAll(/\(\s*'([a-z_]+(?:\.[a-z_]+)+)'\s*,\s*'[^']+'/g)) {
        if (m[1]) codes.add(m[1]);
      }
    }
  }
  return [...codes].sort();
}

function messages(locale: "ar" | "en", mod: string): { workflows?: Record<string, string> } {
  return JSON.parse(readFileSync(join(process.cwd(), "messages", locale, `${mod}.json`), "utf8"));
}

const codes = seededWorkflowCodes();

describe("approval type labels", () => {
  it("finds the seeded workflow codes", () => {
    expect(codes.length).toBeGreaterThanOrEqual(12);
    expect(codes).toContain("sales.order.discount");
    expect(codes).toContain("finance.write_off");
  });

  it.each(codes)("%s has a label key in both modules", (code) => {
    expect(APPROVAL_KEYS[code]).toBeTruthy();
    expect(WORKFLOW_KEYS[code]).toBe(APPROVAL_KEYS[code]);
    expect(workflowLabelKey(code)).toBe(APPROVAL_KEYS[code]);
  });

  it.each(codes)("%s has ar and en labels", (code) => {
    const key = APPROVAL_KEYS[code] ?? "";
    for (const mod of ["approvals", "workflow"]) {
      const ar = messages("ar", mod).workflows?.[key] ?? "";
      const en = messages("en", mod).workflows?.[key] ?? "";
      expect(ar, `${mod} ar ${key}`).toMatch(/[؀-ۿ]/);
      expect(en, `${mod} en ${key}`).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it("an unknown code falls back to the stored name", () => {
    expect(workflowLabelKey("unknown.code")).toBeNull();
  });
});
