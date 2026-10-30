import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type UserContext } from "@/lib/authz/can";
import {
  canCredit,
  canReceive,
  canSeeReturns,
  checkRequestLines,
  lineKey,
  nextStepKey,
  normalizeDigits,
  orderAcceptsReturns,
  parseQuantity,
  parseStatusFilter,
  returnableRows,
  returnErrorCode,
  statusTone,
  STATUS_FILTERS,
  toNumber,
} from "@/modules/returns/logic";
import { returnsNav } from "@/modules/returns/nav";
import { RETURN_STATUSES } from "@/modules/returns/types";

const user = (permissions: Record<string, "own" | "team" | "all">): UserContext => ({
  ...ANONYMOUS_CONTEXT,
  user_id: "00000000-0000-0000-0000-0000000000a4",
  active: true,
  status: "active",
  permissions: Object.fromEntries(Object.entries(permissions).map(([p, scope]) => [p, { scope, limit: null }])),
});

const A = "a0000000-0000-0000-0000-000000000001";
const B = "b0000000-0000-0000-0000-000000000002";
const L1 = "61000000-0000-0000-0000-000000000001";
const L2 = "61000000-0000-0000-0000-000000000002";

describe("permission gating (UX only; Postgres enforces)", () => {
  it("shows the list to anyone who handles returns or reads orders", () => {
    expect(canSeeReturns(ANONYMOUS_CONTEXT)).toBe(false);
    expect(canSeeReturns(user({ "sales.return.request": "own" }))).toBe(true);
    expect(canSeeReturns(user({ "sales.return.receive": "all" }))).toBe(true);
    expect(canSeeReturns(user({ "sales.order.read": "own" }))).toBe(true);
    expect(canSeeReturns(user({ "crm.customer.read": "own" }))).toBe(false);
  });

  it("offers receive only for approved returns to receivers, credit only for received ones to finance", () => {
    const inv = user({ "sales.return.receive": "all" });
    const fin = user({ "sales.return.credit": "all" });
    expect(canReceive(inv, { status: "approved" })).toBe(true);
    expect(canReceive(inv, { status: "pending_approval" })).toBe(false);
    expect(canReceive(fin, { status: "approved" })).toBe(false);
    expect(canCredit(fin, { status: "received" })).toBe(true);
    expect(canCredit(fin, { status: "approved" })).toBe(false);
    expect(canCredit(inv, { status: "received" })).toBe(false);
  });

  it("knows which order statuses take returns", () => {
    expect(orderAcceptsReturns("invoiced")).toBe(true);
    expect(orderAcceptsReturns("partially_fulfilled")).toBe(true);
    expect(orderAcceptsReturns("returned")).toBe(false);
    expect(orderAcceptsReturns("draft")).toBe(false);
    expect(orderAcceptsReturns(null)).toBe(false);
  });

  it("nav entries name a permission and a returns.* label", () => {
    for (const item of returnsNav) {
      expect(item.permission).toMatch(/^sales\.return\.(request|receive|credit)$/);
      expect(item.labelKey).toMatch(/^returns\.nav\./);
      expect(item.href.startsWith("/returns")).toBe(true);
    }
  });
});

describe("errors", () => {
  it("maps known business codes and falls back to the generic message key", () => {
    expect(returnErrorCode({ code: "QTY_EXCEEDS_RETURNABLE", messageKey: "UNKNOWN" })).toBe("QTY_EXCEEDS_RETURNABLE");
    expect(returnErrorCode({ code: "WAREHOUSE_NOT_QUARANTINE", messageKey: "UNKNOWN" })).toBe("WAREHOUSE_NOT_QUARANTINE");
    expect(returnErrorCode({ code: "SOMETHING_NEW", messageKey: "INVALID_STATE" })).toBe("INVALID_STATE");
    expect(returnErrorCode({ code: "SOMETHING_NEW", messageKey: "UNKNOWN" })).toBe("UNKNOWN");
  });
});

describe("status", () => {
  it("has a tone and a next step for every status", () => {
    for (const s of RETURN_STATUSES) {
      expect(statusTone(s)).toEqual(expect.any(String));
      expect(nextStepKey(s)).toEqual(expect.any(String));
    }
    expect(statusTone("credited")).toBe("success");
    expect(statusTone("rejected")).toBe("danger");
    expect(nextStepKey("approved")).toBe("receive");
    expect(nextStepKey("received")).toBe("credit");
  });

  it("parses filters safely", () => {
    expect(parseStatusFilter(undefined)).toBe("all");
    expect(parseStatusFilter("received")).toBe("received");
    expect(parseStatusFilter(["approved", "x"])).toBe("approved");
    expect(parseStatusFilter("toString")).toBe("all");
    expect(parseStatusFilter("__proto__")).toBe("all");
    for (const statuses of Object.values(STATUS_FILTERS)) {
      for (const s of statuses) expect(RETURN_STATUSES).toContain(s);
    }
  });
});

describe("values", () => {
  it("normalizes Arabic-Indic digits and parses whole quantities", () => {
    expect(normalizeDigits("٣٤")).toBe("34");
    expect(normalizeDigits("۱۲")).toBe("12");
    expect(parseQuantity("")).toBe(0);
    expect(parseQuantity(" 2 ")).toBe(2);
    expect(parseQuantity("٢")).toBe(2);
    expect(parseQuantity("1.5")).toBeNull();
    expect(parseQuantity("-1")).toBeNull();
    expect(parseQuantity("abc")).toBeNull();
    expect(toNumber("2234.40")).toBe(2234.4);
    expect(toNumber(null)).toBe(0);
    expect(toNumber("x")).toBe(0);
  });
});

describe("request form lines", () => {
  const r0 = { order_item_id: A, lot_id: L1, returnable_qty: 3 };
  const r1 = { order_item_id: A, lot_id: L2, returnable_qty: 1 };
  const r2 = { order_item_id: B, lot_id: L1, returnable_qty: 2 };
  const rows = [r0, r1, r2];
  const [k0, k1, k2] = [lineKey(r0), lineKey(r1), lineKey(r2)] as const;

  it("keeps only lines with a quantity, in the command's exact shape", () => {
    const result = checkRequestLines(
      { [k0]: "2", [k1]: "", [k2]: "٢" },
      { [k0]: "damaged", [k2]: "wrong_item" },
      rows,
      "",
    );
    expect(result).toEqual({
      ok: true,
      lines: [
        { order_item_id: A, lot_id: L1, quantity: 2, reason_code: "damaged" },
        { order_item_id: B, lot_id: L1, quantity: 2, reason_code: "wrong_item" },
      ],
    });
  });

  it("refuses an empty request, bad numbers, too many units and missing reasons", () => {
    expect(checkRequestLines({}, {}, rows, "")).toEqual({ ok: false, reason: "noLines" });
    expect(checkRequestLines({ [k0]: "1.5" }, {}, rows, "")).toEqual({ ok: false, reason: "invalidQuantity" });
    expect(checkRequestLines({ [k1]: "2" }, { [k1]: "damaged" }, rows, "")).toEqual({ ok: false, reason: "tooMany" });
    expect(checkRequestLines({ [k0]: "1" }, { [k0]: "bored" }, rows, "")).toEqual({ ok: false, reason: "missingReason" });
  });

  it("needs notes for the reason other", () => {
    const qty = { [k0]: "1" };
    const reason = { [k0]: "other" };
    expect(checkRequestLines(qty, reason, rows, "  ")).toEqual({ ok: false, reason: "notesRequired" });
    expect(checkRequestLines(qty, reason, rows, "Synthetic note").ok).toBe(true);
  });

  it("lists only rows with something returnable, by line then lot", () => {
    const list = returnableRows([
      { returnable_qty: 1, line_no: 2, lot_no: "B" },
      { returnable_qty: 0, line_no: 1, lot_no: "A" },
      { returnable_qty: 2, line_no: 1, lot_no: "C" },
      { returnable_qty: 2, line_no: 1, lot_no: "B" },
    ]);
    expect(list.map((r) => `${r.line_no}${r.lot_no}`)).toEqual(["1B", "1C", "2B"]);
  });
});
