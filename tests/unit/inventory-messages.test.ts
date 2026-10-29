import { describe, expect, it } from "vitest";
import ar from "../../messages/ar/inventory.json";
import en from "../../messages/en/inventory.json";
import { INVENTORY_ERROR_CODES, REASON_CODES, STOCK_ALERTS } from "@/modules/inventory/logic";
import { inventoryNav } from "@/modules/inventory/nav";
import { MOVEMENT_TYPES, RECEIPT_STATUSES, TRANSFER_STATUSES, WAREHOUSE_KINDS } from "@/modules/inventory/types";

type Tree = Record<string, unknown>;

function leaves(node: unknown, prefix = ""): [string, string][] {
  if (typeof node === "string") return [[prefix, node]];
  return Object.entries(node as Tree).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}
const get = (tree: unknown, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], tree);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();

describe("inventory translations", () => {
  it("Arabic and English use the same placeholders in every message", () => {
    const arLeaves = new Map(leaves(ar));
    for (const [path, text] of leaves(en)) expect([path, placeholders(arLeaves.get(path) ?? "")]).toEqual([path, placeholders(text)]);
  });

  it.each([
    ["kinds", WAREHOUSE_KINDS],
    ["movementTypes", MOVEMENT_TYPES],
    ["reasons", REASON_CODES],
    ["receiptStatus", RECEIPT_STATUSES],
    ["transferStatus", TRANSFER_STATUSES],
    ["stock.alerts", STOCK_ALERTS],
    ["errors", INVENTORY_ERROR_CODES],
    ["receiptForm.issue", ["EXPIRY_REQUIRED", "EXPIRED_NEEDS_QUARANTINE"]],
    ["adjustmentForm.outcome", ["posted", "pending_approval", "approved", "rejected", "cancelled"]],
  ] as const)("every %s value has a label in both languages", (ns, values) => {
    for (const v of values) {
      expect(typeof get(en, `${ns}.${v}`), `en ${ns}.${v}`).toBe("string");
      expect(typeof get(ar, `${ns}.${v}`), `ar ${ns}.${v}`).toBe("string");
    }
  });

  it("every nav entry has a label and an inventory.* permission", () => {
    for (const item of inventoryNav) {
      const key = item.labelKey.replace(/^inventory\./, "");
      expect(typeof get(en, key)).toBe("string");
      expect(typeof get(ar, key)).toBe("string");
      expect(item.permission).toMatch(/^inventory\.[a-z_]+\.[a-z_]+$/);
      expect(item.href.startsWith("/inventory")).toBe(true);
    }
  });

  it("synthetic examples only (D-03): no phone numbers or e-mail addresses in placeholders", () => {
    for (const [, text] of [...leaves(en), ...leaves(ar)]) {
      expect(text).not.toMatch(/\+?20\d{9,}|@[a-z]+\./i);
    }
  });
});
