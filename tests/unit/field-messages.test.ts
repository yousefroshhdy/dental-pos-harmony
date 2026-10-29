import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIELD_ERROR_CODES } from "@/modules/field/logic";
import { fieldNav } from "@/modules/field/nav";
import {
  ANOMALY_FLAGS,
  TASK_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  VERIFICATION_STATUSES,
  VISIT_OUTCOMES,
  VISIT_STATUSES,
} from "@/modules/field/types";

const load = (locale: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "field.json"), "utf8")) as Record<string, Record<string, unknown>>;

/** Every database enum value the UI shows has a label (the parity of ar/en keys is checked in module-messages.test.ts). */
describe.each(["ar", "en"])("field messages (%s)", (locale) => {
  const m = load(locale);
  const keysOf = (path: string) => Object.keys(path.split(".").reduce<Record<string, unknown>>((n, k) => n[k] as Record<string, unknown>, m));

  it.each([
    ["verdict", VERIFICATION_STATUSES],
    ["checkIn.help", VERIFICATION_STATUSES],
    ["visitStatus", VISIT_STATUSES],
    ["outcome", VISIT_OUTCOMES],
    ["anomaly", ANOMALY_FLAGS],
    ["taskKind", TASK_KINDS],
    ["priority", TASK_PRIORITIES],
    ["taskStatus", TASK_STATUSES],
    ["checkIn.geo", ["denied", "unavailable", "timeout", "unsupported", "insecure"]],
    ["errors", FIELD_ERROR_CODES],
  ] as const)("labels every value of %s", (path, values) => {
    expect(keysOf(path).sort()).toEqual([...values].sort());
  });

  it("has every nav label", () => {
    for (const item of fieldNav) {
      const [ns, group, key] = item.labelKey.split(".");
      expect(ns).toBe("field");
      expect((m[group ?? ""] ?? {})[key ?? ""]).toBeTypeOf("string");
    }
  });

  it("states the 12-month retention in the consent text", () => {
    expect(String(m.consent?.retention)).toMatch(/12/);
  });
});
