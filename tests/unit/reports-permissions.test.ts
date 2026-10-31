import { describe, expect, it } from "vitest";
import type { Grant, Scope, UserContext } from "@/lib/authz/can";
import { columnsFor } from "@/modules/reports/columns";
import { dynamicSourcesFor, fieldSpecs } from "@/modules/reports/forms";
import { availableExports, canExport, EXPORT_KINDS, EXPORT_PERMISSIONS, exportHref } from "@/modules/reports/kinds";
import { EXPORT_PERMISSION_CODES, reportsNav } from "@/modules/reports/nav";

function ctx(perms: Record<string, Scope> = {}, extra: Partial<UserContext> = {}): UserContext {
  const permissions: Record<string, Grant> = Object.fromEntries(Object.entries(perms).map(([p, scope]) => [p, { scope, limit: null }]));
  return { user_id: "u1", active: true, is_owner: false, locale: "ar", status: "active", employee: null, permissions, ...extra };
}

describe("export permission mapping", () => {
  it("each export uses the permission its list page checks plus its own export permission", () => {
    expect(EXPORT_PERMISSIONS).toEqual({
      orders: [["sales.order.read", "sales.order.export"]],
      order_lines: [["sales.order.read", "sales.order.export"]],
      invoices: [["finance.invoice.read", "finance.invoice.export"]],
      payments: [["finance.payment.read", "finance.payment.export"]],
      aging: [
        ["finance.page.aging", "finance.aging.export"],
        ["finance.ledger.read", "finance.aging.export"],
      ],
      visits: [["field.visit.read", "field.visit.export"]],
      customers: [["crm.customer.read", "crm.customer.export"]],
      stock: [["inventory.stock.read", "inventory.stock.export"]],
      tracking: [["field.tracking.read", "field.tracking.export"]],
    });
  });

  it("orders and customers also need the catalogue's dedicated export permission", () => {
    expect(canExport(ctx({ "sales.order.read": "all" }), "orders")).toBe(false);
    expect(canExport(ctx({ "sales.order.read": "own", "sales.order.export": "all" }), "orders")).toBe(true);
    expect(canExport(ctx({ "sales.order.export": "all" }), "order_lines")).toBe(false);
    expect(canExport(ctx({ "crm.customer.read": "territory" }), "customers")).toBe(false);
    expect(canExport(ctx({ "crm.customer.read": "territory", "crm.customer.export": "all" }), "customers")).toBe(true);
  });

  it("aging accepts either the aging page permission or the ledger permission, with finance.aging.export", () => {
    expect(canExport(ctx({ "finance.page.aging": "all", "finance.aging.export": "all" }), "aging")).toBe(true);
    expect(canExport(ctx({ "finance.ledger.read": "all", "finance.aging.export": "all" }), "aging")).toBe(true);
    expect(canExport(ctx({ "finance.page.aging": "all", "finance.ledger.read": "all" }), "aging")).toBe(false);
    expect(canExport(ctx({ "finance.invoice.read": "all", "finance.aging.export": "all" }), "aging")).toBe(false);
  });

  it("denies by default, and denies inactive users", () => {
    expect(availableExports(ctx())).toEqual([]);
    expect(availableExports(ctx({ "field.visit.read": "own", "field.visit.export": "own" }, { active: false }))).toEqual([]);
  });

  it("a field rep sees only the exports of their own lists", () => {
    const rep = ctx({
      "sales.order.read": "own",
      "field.visit.read": "own",
      "field.visit.export": "own",
      "crm.customer.read": "own",
      "inventory.stock.read": "all",
      "inventory.stock.export": "all",
      "finance.invoice.read": "own",
      "finance.invoice.export": "own",
    });
    expect(availableExports(rep)).toEqual(["invoices", "visits", "stock"]);
  });

  it("the owner may run every export", () => {
    expect(availableExports(ctx({}, { is_owner: true }))).toEqual([...EXPORT_KINDS]);
  });
});

describe("permission-dependent columns and fields", () => {
  it("aging shows ledger columns only with finance.ledger.read", () => {
    const keys = (c: UserContext) => columnsFor("aging", c).map((x) => x.key);
    expect(keys(ctx({ "finance.page.aging": "all" }))).not.toContain("ledger_balance");
    expect(keys(ctx({ "finance.ledger.read": "all" }))).toEqual(expect.arrayContaining(["ledger_balance", "unapplied_credit"]));
  });

  it("stock: sellable availability only without inventory.module.access, and no brand filter", () => {
    const rep = ctx({ "inventory.stock.read": "all" });
    expect(columnsFor("stock", rep).map((c) => c.key)).toEqual(["warehouse_code", "warehouse_name", "sku", "variant_name", "product_name", "available"]);
    expect(fieldSpecs("stock", rep).map((f) => f.name)).toEqual(["warehouse"]);
    const keeper = ctx({ "inventory.stock.read": "all", "inventory.module.access": "all" });
    expect(columnsFor("stock", keeper).map((c) => c.key)).toContain("on_hand");
    expect(fieldSpecs("stock", keeper).map((f) => f.name)).toEqual(["warehouse", "brand"]);
  });

  it("visits: the who filter appears only for team-or-wider read scopes", () => {
    expect(fieldSpecs("visits", ctx({ "field.visit.read": "own" })).map((f) => f.name)).not.toContain("who");
    expect(fieldSpecs("visits", ctx({ "field.visit.read": "team" })).map((f) => f.name)).toContain("who");
  });

  it("customers never export address, e-mail, coordinates or balance", () => {
    const keys = columnsFor("customers", ctx({}, { is_owner: true })).map((c) => c.key);
    for (const k of ["email", "address_line", "latitude", "longitude", "balance", "credit_limit", "phone_secondary", "notes"]) expect(keys).not.toContain(k);
  });

  it("the page reads only the pickers its exports need", () => {
    const rep = ctx({ "inventory.stock.read": "all", "inventory.stock.export": "all", "field.visit.read": "own", "field.visit.export": "own" });
    expect([...dynamicSourcesFor(availableExports(rep), rep)]).toEqual(["warehouses"]);
  });
});

describe("exportHref and nav", () => {
  it("builds the export URL from list filters, dropping empty values", () => {
    expect(exportHref("orders")).toBe("/api/export/orders");
    expect(exportHref("invoices", { status: "open", customer: undefined, bucket: "" }, "en")).toBe("/api/export/invoices?status=open&locale=en");
    expect(exportHref("customers", { q: "a&b=c" })).toBe("/api/export/customers?q=a%26b%3Dc");
  });

  it("nav entry lives in the reports namespace", () => {
    expect(reportsNav).toEqual([
      { href: "/reports", labelKey: "reports.nav.reports", permission: null, anyPermission: EXPORT_PERMISSION_CODES },
    ]);
  });
});
