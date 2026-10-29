import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGE_MODULES } from "@/i18n/modules";

const root = join(__dirname, "../../messages");

function keys(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}
const load = (locale: string, m: string) => JSON.parse(readFileSync(join(root, locale, `${m}.json`), "utf8")) as unknown;
const leaves = (tree: unknown) => keys(tree).map((path) => path.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], tree));

describe("module translations (messages/<locale>/<module>.json)", () => {
  it("every module file is registered, and every registered module has a file", () => {
    for (const locale of ["ar", "en"]) {
      const files = readdirSync(join(root, locale)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
      expect(files.sort()).toEqual([...MESSAGE_MODULES].sort());
    }
  });

  it.each(MESSAGE_MODULES)("%s has the same keys in Arabic and English, none empty", (m) => {
    const ar = load("ar", m);
    const en = load("en", m);
    expect(keys(ar).sort()).toEqual(keys(en).sort());
    expect(leaves(ar).filter((v) => v === "")).toEqual([]);
    expect(leaves(en).filter((v) => v === "")).toEqual([]);
  });

  it("module namespaces do not collide with core message namespaces", () => {
    const core = JSON.parse(readFileSync(join(root, "en.json"), "utf8")) as Record<string, unknown>;
    expect(MESSAGE_MODULES.filter((m) => m in core)).toEqual([]);
  });
});
