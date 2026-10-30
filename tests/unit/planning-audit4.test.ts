import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planningErrorCode } from "@/modules/planning/logic";

const load = (locale: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "planning.json"), "utf8")) as {
    errors: Record<string, string>;
    generate: Record<string, unknown>;
  };

/** Audit 4 (F2, F6): the new planning refusals have their own text, and "Remove" follows the planner rule. */
describe("planning audit-4 fixes", () => {
  it("translates the daily-cap and generator-budget refusals with planning-specific text", () => {
    expect(planningErrorCode("DAILY_CAP")).toBe("DAILY_CAP");
    expect(planningErrorCode("TIMEOUT")).toBe("TIMEOUT");
    // A visit planned by someone else is refused as PERMISSION_DENIED: the shared text covers it.
    expect(planningErrorCode("PERMISSION_DENIED")).toBeNull();
  });

  it.each(["ar", "en"])("has the new strings in %s", (locale) => {
    const m = load(locale);
    expect(m.errors.DAILY_CAP?.length).toBeGreaterThan(0);
    expect(m.errors.TIMEOUT?.length).toBeGreaterThan(0);
    expect(m.generate.skipped).toMatch(/\{skipped, plural,/);
    expect(m.generate.skipped).toMatch(/\{max\}/);
  });

  it("reads the Remove flag from may_unplan (who planned the visit counts), not from the state-only can_unplan", () => {
    const source = readFileSync(join(__dirname, "../../src/modules/planning/queries.ts"), "utf8");
    expect(source).toContain('"can_unplan:may_unplan, is_missed, created_at"');
  });
});
