import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMISSION_ERROR_CODES } from "@/modules/commissions/logic";
import { commissionsNav } from "@/modules/commissions/nav";
import { ADJUSTMENT_KINDS, ENTRY_KINDS, REQUEST_STATUSES } from "@/modules/commissions/types";

type Tree = Record<string, unknown>;
const load = (locale: string) => JSON.parse(readFileSync(join(__dirname, `../../messages/${locale}/commissions.json`), "utf8")) as Tree;
const at = (tree: Tree, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], tree);

describe.each(["ar", "en"])("commissions messages (%s)", (locale) => {
  const messages = load(locale);

  it("a label for every line kind, request status, period status and error code", () => {
    for (const k of [...ENTRY_KINDS, ...ADJUSTMENT_KINDS]) expect(at(messages, `kind.${k}`), k).toEqual(expect.any(String));
    for (const k of ADJUSTMENT_KINDS) expect(at(messages, `adjust.amountHint.${k}`), k).toEqual(expect.any(String));
    for (const s of REQUEST_STATUSES) expect(at(messages, `adjust.status.${s}`), s).toEqual(expect.any(String));
    for (const s of ["open", "calculated", "closed"]) expect(at(messages, `period.status.${s}`), s).toEqual(expect.any(String));
    for (const c of COMMISSION_ERROR_CODES) expect(at(messages, `errors.${c}`), c).toEqual(expect.any(String));
    for (const m of ["recalculated", "closed", "pending", "posted"]) expect(at(messages, `messages.${m}`), m).toEqual(expect.any(String));
    for (const item of commissionsNav) expect(at(messages, item.labelKey.replace(/^commissions\./, "")), item.labelKey).toEqual(expect.any(String));
  });

  it("placeholders survive translation", () => {
    expect(at(messages, "errors.UNKNOWN")).toContain("{requestId}");
    expect(at(messages, "periods.close")).toContain("{month}");
    expect(at(messages, "statement.otherTitle")).toContain("{name}");
    expect(at(messages, "statement.baseTimesRate")).toContain("{rate}");
  });
});

describe("commissions nav", () => {
  it("each screen is gated on the permission that opens it", () => {
    expect(commissionsNav.map((i) => [i.href, i.permission])).toEqual([
      ["/commissions", "perf.commission.read"],
      ["/commissions/periods", "perf.commission.calculate"],
      ["/commissions/adjustments", "perf.commission.adjust"],
    ]);
    for (const item of commissionsNav) expect(item.labelKey.startsWith("commissions.nav.")).toBe(true);
  });
});
