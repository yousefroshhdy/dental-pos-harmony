import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORDER_ERROR_CODES, STATUS_FILTERS } from "@/modules/orders/logic";
import { ordersNav } from "@/modules/orders/nav";
import { ORDER_STATUSES } from "@/modules/orders/types";

type Tree = Record<string, unknown>;
const load = (locale: string) => JSON.parse(readFileSync(join(__dirname, `../../messages/${locale}/orders.json`), "utf8")) as Tree;
const at = (tree: Tree, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], tree);

describe.each(["ar", "en"])("orders messages (%s)", (locale) => {
  const messages = load(locale);

  it("translate every status, filter and error code", () => {
    for (const s of ORDER_STATUSES) expect(at(messages, `status.${s}`), s).toEqual(expect.any(String));
    for (const f of Object.keys(STATUS_FILTERS)) expect(at(messages, `filters.${f}`), f).toEqual(expect.any(String));
    for (const c of ORDER_ERROR_CODES) expect(at(messages, `errors.${c}`), c).toEqual(expect.any(String));
  });

  it("translate approval reasons, history phrases and nav entries", () => {
    for (const r of ["discount", "credit"]) expect(at(messages, `reasons.${r}`)).toEqual(expect.any(String));
    for (const k of ["draftCreated", "accepted", "approvalDecision"]) expect(at(messages, `historyReason.${k}`)).toEqual(expect.any(String));
    for (const item of ordersNav) expect(at(messages, item.labelKey.replace(/^orders\./, "")), item.labelKey).toEqual(expect.any(String));
  });

  it("UNKNOWN carries the request id placeholder", () => {
    expect(at(messages, "errors.UNKNOWN")).toContain("{requestId}");
  });
});

describe("orders nav", () => {
  it("each entry is permission-gated and lives in the orders namespace", () => {
    expect(ordersNav.map((i) => [i.href, i.permission])).toEqual([
      ["/orders", "sales.order.read"],
      ["/orders/new", "sales.order.create"],
    ]);
    for (const item of ordersNav) expect(item.labelKey.startsWith("orders.nav.")).toBe(true);
  });
});
