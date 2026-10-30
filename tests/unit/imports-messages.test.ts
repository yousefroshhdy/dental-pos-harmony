import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IMPORT_KINDS, KIND_SPECS } from "@/modules/imports/kinds";
import { ROW_ERROR_CODES } from "@/modules/imports/logic";
import { importsNav } from "@/modules/imports/nav";

type Tree = Record<string, unknown>;
const load = (locale: string) => JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "imports.json"), "utf8")) as Tree;
const at = (tree: Tree, path: string): unknown => path.split(".").reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], tree);

const migration = readFileSync(join(__dirname, "../../supabase/migrations/20261103000110_import_commands.sql"), "utf8");

/** Arrays per kind from a `case p_kind when '<kind>' then array[...]` SQL function. */
function sqlArrays(fn: string): Record<string, string[]> {
  const body = migration.split(`create or replace function import.${fn}(`)[1]?.split("$$;")[0] ?? "";
  const out: Record<string, string[]> = {};
  for (const [, kind = "", list = ""] of body.matchAll(/when '([a-z_]+)' then array\[([^\]]*)\]/g)) {
    out[kind] = [...list.matchAll(/'([a-z_]+)'/g)].map((x) => x[1] ?? "");
  }
  return out;
}

describe("import kinds match the database", () => {
  it("columns per kind are the ones import._columns accepts", () => {
    const sql = sqlArrays("_columns");
    expect(Object.keys(sql).sort()).toEqual([...IMPORT_KINDS].sort());
    for (const kind of IMPORT_KINDS) expect([...KIND_SPECS[kind].columns], kind).toEqual(sql[kind]);
  });

  it("required columns are the ones import._required_columns demands", () => {
    const sql = sqlArrays("_required_columns");
    for (const kind of IMPORT_KINDS) expect([...KIND_SPECS[kind].required], kind).toEqual(sql[kind]);
  });

  it("the kind permission is the one import._kind_permission requires", () => {
    const body = migration.split("create or replace function import._kind_permission(")[1]?.split("$$;")[0] ?? "";
    for (const kind of IMPORT_KINDS) {
      const perm = KIND_SPECS[kind].permission;
      if (perm) expect(body).toContain(`when '${kind}' then '${perm}'`);
      else expect(body).not.toContain(`when '${kind}'`);
    }
  });

  it("every row error code the database writes has a translation key", () => {
    const written = new Set([...migration.matchAll(/'([a-z_]+):[a-z_/]+'/g)].map((m) => m[1]));
    written.delete("import_row");
    for (const code of written) expect(ROW_ERROR_CODES as readonly string[], code).toContain(code);
  });
});

describe("imports messages", () => {
  it.each(["ar", "en"])("%s has a title and description for every kind", (locale) => {
    const m = load(locale);
    for (const kind of IMPORT_KINDS) {
      expect(typeof at(m, `kinds.${kind}.title`), kind).toBe("string");
      expect(typeof at(m, `kinds.${kind}.description`), kind).toBe("string");
    }
  });

  it.each(["ar", "en"])("%s has a hint for every template column", (locale) => {
    const m = load(locale);
    for (const kind of IMPORT_KINDS) for (const c of KIND_SPECS[kind].columns) expect(typeof at(m, `columns.${c}`), c).toBe("string");
  });

  it.each(["ar", "en"])("%s translates every row error code, status and nav label", (locale) => {
    const m = load(locale);
    for (const code of ROW_ERROR_CODES) expect(typeof at(m, `rowErrors.${code}`), code).toBe("string");
    for (const s of ["uploaded", "validated", "committed", "failed", "discarded"]) expect(typeof at(m, `status.${s}`), s).toBe("string");
    for (const s of ["pending", "valid", "invalid", "committed"]) expect(typeof at(m, `rowStatus.${s}`), s).toBe("string");
    for (const item of importsNav) expect(typeof at(m, item.labelKey.replace(/^imports\./, "")), item.labelKey).toBe("string");
  });

  it.each(["ar", "en"])("%s has a label for every commit result the database returns", (locale) => {
    const m = load(locale);
    // The keys returned by import._commit_<kind>().
    const keys = migration
      .split(/create or replace function import\._commit_[a-z_]+\(/)
      .slice(1)
      .flatMap((fn) => {
        const ret = /return jsonb_build_object\(([^;]*)\);\s*end \$\$;/.exec(fn)?.[1] ?? "";
        return [...ret.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      });
    expect(keys.length).toBe(11);
    for (const k of keys) expect(typeof at(m, `result.${k}`), k).toBe("string");
  });

  it("warns about synthetic data in both languages (D-03)", () => {
    expect(String(at(load("en"), "synthetic.title"))).toMatch(/synthetic/i);
    expect(String(at(load("ar"), "synthetic.title"))).toContain("تجريبية");
    expect(String(at(load("en"), "upload.fileHint"))).toContain("CSV (UTF-8)");
  });

  it("the nav entry needs admin.import.run", () => {
    expect(importsNav).toEqual([{ href: "/imports", labelKey: "imports.nav.imports", permission: "admin.import.run" }]);
  });
});
