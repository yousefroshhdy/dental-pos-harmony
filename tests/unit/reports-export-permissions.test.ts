import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Grant, Scope, UserContext } from "@/lib/authz/can";
import { navVisible } from "@/lib/nav";
import { ExportCsvButton } from "@/modules/reports/components/export-csv-button";
import { canExport, EXPORT_KINDS, EXPORT_PERMISSION, EXPORT_PERMISSIONS, type ExportKind } from "@/modules/reports/kinds";
import { EXPORT_PERMISSION_CODES, reportsNav } from "@/modules/reports/nav";

// Owner decision 2026-10-31: every CSV export kind has its own MFA-gated
// <module>.<resource>.export permission (migration 20261104001100).

function ctx(perms: Record<string, Scope> = {}, extra: Partial<UserContext> = {}): UserContext {
  const permissions: Record<string, Grant> = Object.fromEntries(Object.entries(perms).map(([p, scope]) => [p, { scope, limit: null }]));
  return { user_id: "u1", active: true, is_owner: false, locale: "ar", status: "active", employee: null, permissions, ...extra };
}

/** The read half of the first rule of a kind (what the list page checks). */
const readOf = (kind: ExportKind) => EXPORT_PERMISSIONS[kind][0]!.find((p) => p !== EXPORT_PERMISSION[kind])!;

describe("per-kind export permissions", () => {
  it("every kind has a dedicated <module>.<resource>.export permission", () => {
    expect(EXPORT_PERMISSION).toEqual({
      orders: "sales.order.export",
      order_lines: "sales.order.export",
      invoices: "finance.invoice.export",
      payments: "finance.payment.export",
      aging: "finance.aging.export",
      visits: "field.visit.export",
      customers: "crm.customer.export",
      stock: "inventory.stock.export",
      tracking: "field.tracking.export",
    });
    for (const code of Object.values(EXPORT_PERMISSION)) expect(code).toMatch(/^[a-z_]+\.[a-z_]+\.export$/);
  });

  it("every alternative of every kind requires that kind's export permission and one other (read) permission", () => {
    for (const kind of EXPORT_KINDS) {
      for (const rule of EXPORT_PERMISSIONS[kind]) {
        expect(rule, kind).toContain(EXPORT_PERMISSION[kind]);
        expect(rule.length, kind).toBe(2);
        // The read permission comes first (the database names it first when both are missing).
        expect(rule[1], kind).toBe(EXPORT_PERMISSION[kind]);
      }
    }
  });

  it.each([...EXPORT_KINDS])("%s: the read permission alone is not enough, nor the export permission alone", (kind) => {
    const read = readOf(kind);
    const exp = EXPORT_PERMISSION[kind];
    expect(canExport(ctx({ [read]: "all" }), kind)).toBe(false);
    expect(canExport(ctx({ [exp]: "all" }), kind)).toBe(false);
    expect(canExport(ctx({ [read]: "own", [exp]: "own" }), kind)).toBe(true);
    expect(canExport(ctx({ [read]: "all", [exp]: "all" }, { active: false }), kind)).toBe(false);
    expect(canExport(ctx({}, { is_owner: true }), kind)).toBe(true);
  });

  it("one kind's export permission does not open another kind", () => {
    const user = ctx({ "finance.invoice.read": "all", "finance.payment.read": "all", "finance.invoice.export": "all" });
    expect(canExport(user, "invoices")).toBe(true);
    expect(canExport(user, "payments")).toBe(false);
  });

  it("the export permission codes are listed once each", () => {
    expect(EXPORT_PERMISSION_CODES).toEqual([
      "crm.customer.export",
      "field.tracking.export",
      "field.visit.export",
      "finance.aging.export",
      "finance.invoice.export",
      "finance.payment.export",
      "inventory.stock.export",
      "sales.order.export",
    ]);
  });
});

describe("reports nav visibility", () => {
  const entry = reportsNav[0]!;

  it("is hidden from users without any export permission", () => {
    expect(navVisible(ctx(), entry)).toBe(false);
    expect(navVisible(ctx({ "crm.customer.read": "all", "finance.invoice.read": "all" }), entry)).toBe(false);
  });

  it("is shown with any one export permission, and to the owner", () => {
    expect(navVisible(ctx({ "field.visit.export": "own" }), entry)).toBe(true);
    expect(navVisible(ctx({}, { is_owner: true }), entry)).toBe(true);
    expect(navVisible(ctx({ "field.visit.export": "own" }, { active: false }), entry)).toBe(false);
  });

  it("entries without anyPermission keep the single-permission rule", () => {
    expect(navVisible(ctx(), { href: "/", labelKey: "nav.home", permission: null })).toBe(true);
    expect(navVisible(ctx(), { href: "/x", labelKey: "x", permission: "crm.customer.read" })).toBe(false);
    expect(navVisible(ctx({ "crm.customer.read": "own" }), { href: "/x", labelKey: "x", permission: "crm.customer.read" })).toBe(true);
  });
});

function render(locale: "ar" | "en", node: ReactNode): string {
  const root = join(__dirname, "../../messages");
  const messages = {
    ...JSON.parse(readFileSync(join(root, `${locale}.json`), "utf8")),
    reports: JSON.parse(readFileSync(join(root, locale, "reports.json"), "utf8")),
  };
  const html = renderToString(
    createElement(NextIntlClientProvider, { locale, messages, timeZone: "Africa/Cairo" } as ComponentProps<typeof NextIntlClientProvider>, node),
  );
  return html.replaceAll("&amp;", "&");
}

describe.each(["ar", "en"] as const)("ExportCsvButton (%s)", (locale) => {
  it("renders nothing without the kind's export permission", () => {
    expect(render(locale, createElement(ExportCsvButton, { ctx: ctx({ "finance.invoice.read": "all" }), kind: "invoices" }))).toBe("");
  });

  it("renders nothing without the list's read permission", () => {
    expect(render(locale, createElement(ExportCsvButton, { ctx: ctx({ "finance.invoice.export": "all" }), kind: "invoices" }))).toBe("");
  });

  it("links to the export with the page's filters and the locale, at a 44 px tap target", () => {
    const user = ctx({ "finance.invoice.read": "own", "finance.invoice.export": "own" });
    const html = render(locale, createElement(ExportCsvButton, { ctx: user, kind: "invoices", filters: { status: "overdue", bucket: null, customer: undefined }, label: "X" }));
    expect(html).toContain(`href="/api/export/invoices?status=overdue&locale=${locale}"`);
    expect(html).toContain("download");
    expect(html).toContain("min-h-11");
    expect(html).toContain(">X</a>");
    expect(html).not.toMatch(/\b(ml|mr|pl|pr|left|right)-/);
  });

  it("uses the default label when the page passes none", () => {
    const html = render(locale, createElement(ExportCsvButton, { ctx: ctx({}, { is_owner: true }), kind: "aging" }));
    const expected = JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "reports.json"), "utf8")).button.export as string;
    expect(html).toContain(expected);
    expect(html).toContain('href="/api/export/aging?locale=');
  });
});

describe("list pages render the export button with their own label", () => {
  const PAGES: [string, ExportKind[], string, string[]][] = [
    ["orders/page.tsx", ["orders", "order_lines"], "orders", ["list.exportOrders", "list.exportLines"]],
    ["finance/invoices/page.tsx", ["invoices"], "finance", ["invoices.export"]],
    ["finance/payments/page.tsx", ["payments"], "finance", ["payments.export"]],
    ["finance/aging/page.tsx", ["aging"], "finance", ["aging.export"]],
    ["visits/page.tsx", ["visits"], "field", ["visits.export"]],
    ["customers/page.tsx", ["customers"], "crm", ["list.export"]],
    ["inventory/page.tsx", ["stock"], "inventory", ["stock.export"]],
    ["tracking/page.tsx", ["tracking"], "tracking", ["team.export"]],
  ];
  const app = join(__dirname, "../../src/app/[locale]/(app)");
  const get = (o: unknown, path: string) => path.split(".").reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);

  it("covers every export kind", () => {
    expect(PAGES.flatMap(([, kinds]) => kinds).sort()).toEqual([...EXPORT_KINDS].sort());
  });

  it.each(PAGES)("%s", (file, kinds, module, keys) => {
    const src = readFileSync(join(app, file), "utf8");
    for (const kind of kinds) expect(src).toMatch(new RegExp(`<ExportCsvButton[\\s\\S]*?kind="${kind}"`));
    for (const locale of ["ar", "en"]) {
      const messages = JSON.parse(readFileSync(join(__dirname, "../../messages", locale, `${module}.json`), "utf8"));
      for (const key of keys) expect(typeof get(messages, key), `${locale} ${module}.${key}`).toBe("string");
    }
  });
});
