import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

function keys(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe("admin.* translations", () => {
  it("has the same keys in Arabic and English", () => {
    expect(keys(ar.admin).sort()).toEqual(keys(en.admin).sort());
  });

  it.each([
    ["ar", ar.admin],
    ["en", en.admin],
  ])("has no empty strings in %s", (_locale, tree) => {
    const empty = keys(tree).filter((path) => path.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], tree) === "");
    expect(empty).toEqual([]);
  });
});
