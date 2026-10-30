import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLANNING_ERROR_CODES } from "@/modules/planning/logic";
import { planningNav } from "@/modules/planning/nav";
import { PLAN_STATUSES, PROPOSAL_REASONS, VISIT_CLASSES } from "@/modules/planning/types";

const load = (locale: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "planning.json"), "utf8")) as Record<string, Record<string, unknown>>;

/** Every value the UI shows has a label (ar/en key parity is checked in module-messages.test.ts). */
describe.each(["ar", "en"])("planning messages (%s)", (locale) => {
  const m = load(locale);
  const keysOf = (path: string) => Object.keys(path.split(".").reduce<Record<string, unknown>>((n, k) => n[k] as Record<string, unknown>, m));

  it.each([
    ["class", VISIT_CLASSES],
    ["status", PLAN_STATUSES],
    ["errors", PLANNING_ERROR_CODES],
    ["generate.reason", PROPOSAL_REASONS],
  ] as const)("labels every value of %s", (path, values) => {
    expect(keysOf(path).sort()).toEqual([...values].sort());
  });

  it("has the nav labels, gated on the planning and visit-read permissions", () => {
    expect(planningNav).toEqual([
      { href: "/planning", labelKey: "planning.nav.planning", permission: "field.visit.plan" },
      { href: "/planning/coverage", labelKey: "planning.nav.coverage", permission: "field.visit.read" },
    ]);
    for (const item of planningNav) {
      const key = item.labelKey.split(".").pop()!;
      expect(typeof (m.nav as Record<string, unknown>)[key]).toBe("string");
    }
  });
});
