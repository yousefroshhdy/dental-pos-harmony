import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UserContext } from "@/lib/authz/can";
import { allColumnKeys, columnHeader, csvNote } from "@/modules/reports/columns";
import { fieldSpecs, optionLabelKey } from "@/modules/reports/forms";
import { EXPORT_KINDS, FILTER_FIELDS } from "@/modules/reports/kinds";
import { reportsNav } from "@/modules/reports/nav";

type Tree = Record<string, unknown>;
const load = (locale: string) => JSON.parse(readFileSync(join(__dirname, `../../messages/${locale}/reports.json`), "utf8")) as Tree;
const at = (tree: Tree, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], tree);
const owner = { active: true, is_owner: true, permissions: {} } as unknown as UserContext;

describe.each(["ar", "en"] as const)("reports messages (%s)", (locale) => {
  const messages = load(locale);

  it("translate every column header", () => {
    for (const key of allColumnKeys()) {
      expect(at(messages, `columns.${key}`), key).toEqual(expect.any(String));
      expect(columnHeader(locale, key)).not.toBe(key);
    }
  });

  it("translate every export, filter and fixed option", () => {
    for (const kind of EXPORT_KINDS) {
      expect(at(messages, `kinds.${kind}.title`), kind).toEqual(expect.any(String));
      expect(at(messages, `kinds.${kind}.description`), kind).toEqual(expect.any(String));
      for (const name of FILTER_FIELDS[kind]) expect(at(messages, `filters.${name}`), name).toEqual(expect.any(String));
      for (const f of fieldSpecs(kind, owner)) {
        if (f.control === "select") for (const code of f.codes) expect(at(messages, optionLabelKey(f.group, code)), `${f.group}.${code}`).toEqual(expect.any(String));
      }
    }
    for (const item of reportsNav) expect(at(messages, item.labelKey.replace(/^reports\./, ""))).toEqual(expect.any(String));
  });

  it("CSV notes carry the row count", () => {
    expect(at(messages, "csv.truncated")).toContain("{count}");
    expect(csvNote(locale, "truncated", 50000)).toContain("50000");
    expect(at(messages, "page.rowCap")).toContain("{count}");
  });
});

describe("headers follow the locale", () => {
  it("Arabic and English differ", () => {
    expect(columnHeader("ar", "customer_name")).toBe("العميل");
    expect(columnHeader("en", "customer_name")).toBe("Customer");
  });
});
