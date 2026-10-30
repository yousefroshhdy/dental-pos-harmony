import { expect, test } from "@playwright/test";

/**
 * Every Phase 3 screen is behind the session check in src/proxy.ts: with no
 * Supabase session, each must answer 307 to the same-locale login page with
 * ?next= set, and never render module content.
 */
const ROUTES = [
  "/today",
  "/visits",
  "/visits/new",
  "/visits/privacy",
  "/tasks",
  "/customers",
  "/customers/new",
  "/customers/00000000-0000-0000-0000-000000000001",
  "/customers/00000000-0000-0000-0000-000000000001/edit",
  "/opportunities",
  "/opportunities/new",
  "/orders",
  "/orders/new",
  "/orders/00000000-0000-0000-0000-000000000001",
  "/approvals",
  "/approvals/00000000-0000-0000-0000-000000000001",
  "/notifications",
  "/inventory",
  "/inventory/movements",
  "/inventory/receipts",
  "/inventory/receipts/new",
  "/inventory/transfers",
  "/inventory/transfers/new",
  "/inventory/adjustments/new",
  "/catalog",
  "/catalog/products/new",
  "/catalog/price-lists",
  "/catalog/promotions",
  "/sync",
  "/dashboard",
  "/dashboard/targets",
  "/tracking",
  "/tracking/00000000-0000-0000-0000-000000000001/2026-10-30",
  "/finance/invoices",
  "/finance/invoices/new",
  "/finance/invoices/00000000-0000-0000-0000-000000000001",
  "/finance/payments",
  "/finance/payments/new",
  "/finance/payments/00000000-0000-0000-0000-000000000001",
  "/finance/customers/00000000-0000-0000-0000-000000000001/statement",
  "/finance/aging",
  "/finance/collections",
] as const;

test.describe("Phase 3 screens without a session", () => {
  for (const locale of ["ar", "en"] as const) {
    for (const route of ROUTES) {
      test(`/${locale}${route} redirects to login`, async ({ request }) => {
        const path = `/${locale}${route}`;
        const res = await request.get(path, { maxRedirects: 0 });
        expect(res.status()).toBe(307);
        expect(res.headers()["location"]).toBe(`/${locale}/login?next=${encodeURIComponent(path)}`);
        expect(await res.text()).not.toContain("<table");
      });
    }
  }
});
