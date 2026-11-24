import { readFileSync } from "node:fs";
import path from "node:path";
import { MESSAGE_MODULES } from "../../../src/i18n/modules";

/**
 * The app's own strings (messages/{ar,en}.json + messages/{ar,en}/<module>.json, merged the way
 * src/i18n/request.ts does), so every label a verification line clicks is the real one.
 */
type Tree = { [k: string]: string | Tree };

function load(locale: "ar" | "en"): Tree {
  const root = path.resolve("messages");
  const core = JSON.parse(readFileSync(path.join(root, `${locale}.json`), "utf8")) as Tree;
  for (const m of MESSAGE_MODULES) core[m] = JSON.parse(readFileSync(path.join(root, locale, `${m}.json`), "utf8")) as Tree;
  return core;
}

const TREES = { ar: load("ar"), en: load("en") };

/** One message, with simple `{name}` placeholders filled (no plural or select forms). */
export function msg(locale: "ar" | "en", key: string, vars: Record<string, string | number> = {}): string {
  let node: string | Tree | undefined = TREES[locale];
  for (const part of key.split(".")) node = typeof node === "object" ? node[part] : undefined;
  if (typeof node !== "string") throw new Error(`no message ${locale}:${key}`);
  return node.replace(/\{(\w+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all));
}

/** Arabic, the default locale every line runs in. */
export const ar = (key: string, vars?: Record<string, string | number>) => msg("ar", key, vars);

/** A message as a regular expression (for labels that carry a count or a name). */
export function arRe(key: string): RegExp {
  // Split on top-level {…} blocks, nested ones included (plural and select forms).
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of ar(key)) {
    if (ch === "{") {
      if (depth === 0) {
        parts.push(current);
        current = "";
      }
      depth++;
    } else if (ch === "}") {
      depth--;
    } else if (depth === 0) {
      current += ch;
    }
  }
  parts.push(current);
  return new RegExp(parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*"));
}
