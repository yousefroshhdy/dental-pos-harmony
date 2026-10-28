import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, can, canAny, limitOf, SCOPES, type Grant, type Scope, type UserContext } from "@/lib/authz/can";

function ctx(overrides: Partial<UserContext> = {}): UserContext {
  return {
    user_id: "00000000-0000-0000-0000-000000000001",
    active: true,
    is_owner: false,
    locale: "ar",
    status: "active",
    employee: null,
    permissions: {},
    ...overrides,
  };
}

const grant = (scope: Scope, limit: Grant["limit"] = null): Grant => ({ scope, limit });

describe("can", () => {
  it("gives inactive users nothing, even with grants or the owner flag", () => {
    const suspended = ctx({ active: false, status: "suspended", is_owner: true, permissions: { "sales.order.create": grant("all") } });
    expect(can(suspended, "sales.order.create")).toBe(false);
    expect(can(suspended, "sales.order.create", "own")).toBe(false);
    expect(canAny(suspended, ["sales.order.create"])).toBe(false);
  });

  it("gives the anonymous context nothing", () => {
    expect(can(ANONYMOUS_CONTEXT, "core.dashboard.view")).toBe(false);
  });

  it("gives an active owner everything at every scope", () => {
    const owner = ctx({ is_owner: true });
    expect(can(owner, "anything.at.all")).toBe(true);
    for (const scope of SCOPES) expect(can(owner, "finance.payment.approve", scope)).toBe(true);
  });

  it("denies permissions the user does not hold", () => {
    expect(can(ctx({ permissions: { "crm.customer.view": grant("all") } }), "crm.customer.edit")).toBe(false);
  });

  it("defaults to the narrowest scope (own)", () => {
    expect(can(ctx({ permissions: { "field.visit.log": grant("own") } }), "field.visit.log")).toBe(true);
  });

  it("ranks scopes own < team < territory < department < warehouse < all", () => {
    expect(SCOPES).toEqual(["own", "team", "territory", "department", "warehouse", "all"]);
    SCOPES.forEach((held, heldRank) => {
      const user = ctx({ permissions: { p: grant(held) } });
      SCOPES.forEach((required, requiredRank) => {
        expect(can(user, "p", required), `${held} satisfies ${required}?`).toBe(heldRank >= requiredRank);
      });
    });
  });

  it("canAny is true when at least one permission is held", () => {
    const user = ctx({ permissions: { "inventory.stock.view": grant("warehouse") } });
    expect(canAny(user, ["admin.users.manage", "inventory.stock.view"])).toBe(true);
    expect(canAny(user, ["admin.users.manage"])).toBe(false);
    expect(canAny(user, [])).toBe(false);
  });
});

describe("limitOf", () => {
  it("is undefined for inactive users and for permissions not held", () => {
    expect(limitOf(ctx({ active: false, permissions: { d: grant("all", 5) } }), "d")).toBeUndefined();
    expect(limitOf(ctx(), "sales.discount.apply")).toBeUndefined();
  });

  it("is null (unlimited) for an active owner", () => {
    expect(limitOf(ctx({ is_owner: true }), "sales.discount.apply")).toBeNull();
  });

  it("is null when the grant has no limit", () => {
    expect(limitOf(ctx({ permissions: { d: grant("team", null) } }), "d")).toBeNull();
  });

  it("returns numeric limits as numbers", () => {
    expect(limitOf(ctx({ permissions: { d: grant("own", 10) } }), "d")).toBe(10);
    expect(limitOf(ctx({ permissions: { d: grant("own", 0) } }), "d")).toBe(0);
  });

  it("coerces numeric strings from JSON (e.g. a numeric limit serialised as \"3.00\")", () => {
    // Defensive: the Grant type says number, but JSON from the wire is not type-checked.
    const fromJson = JSON.parse('{"d":{"scope":"own","limit":"3.00"},"e":{"scope":"all","limit":"12500.50"}}') as Record<string, Grant>;
    const user = ctx({ permissions: fromJson });
    expect(limitOf(user, "d")).toBe(3);
    expect(limitOf(user, "e")).toBe(12500.5);
    expect(typeof limitOf(user, "d")).toBe("number");
  });
});
