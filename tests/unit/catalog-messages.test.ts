import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG_ERROR_CODES } from "@/modules/catalog/logic";
import { catalogNav } from "@/modules/catalog/nav";

const load = (locale: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "catalog.json"), "utf8")) as Record<string, Record<string, unknown>>;

describe("catalog messages", () => {
  it.each(["ar", "en"])("%s has a message for every catalogue error code", (locale) => {
    const errors = load(locale).errors ?? {};
    for (const code of CATALOG_ERROR_CODES) expect(typeof errors[code], code).toBe("string");
  });

  it.each(["ar", "en"])("%s has every nav label", (locale) => {
    const nav = load(locale).nav ?? {};
    for (const item of catalogNav) {
      const [, group, key] = item.labelKey.split(".");
      expect(group).toBe("nav");
      expect(typeof nav[key ?? ""]).toBe("string");
    }
  });

  it("nav entries use catalogue read permissions", () => {
    expect(catalogNav.length).toBeGreaterThan(0);
    for (const item of catalogNav) expect(item.permission).toMatch(/^catalog\.[a-z_]+\.read$/);
  });
});
