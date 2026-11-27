import type { Page } from "@playwright/test";
import { buildSyntheticWorkbook, syntheticWorkbookBytes } from "../unit/legacy-synthetic";
import type { Ids, Persona } from "./stack";
import { msg } from "./verify/messages";

/**
 * The screens to capture, in review order (Phase P step 2b first, then the rest of the nav),
 * each with the persona that uses it. `path` is after the locale prefix. `prepare` runs after
 * the page loaded and before the shot (local stack, synthetic data only).
 */
export type Screen = {
  slug: string;
  persona: Persona;
  path: (ids: Ids) => string;
  prepare?: (page: Page, locale: "ar" | "en") => Promise<void>;
};

/**
 * /admin/setup/legacy-import with the synthetic workbook checked, so the reconciliation, the
 * step counts and the negative-stock decision show. "Upload and check" stores nothing; an
 * import left open by the verification run is abandoned first.
 */
async function uploadSyntheticWorkbook(page: Page, locale: "ar" | "en"): Promise<void> {
  const t = (key: string) => msg(locale, `legacyImport.${key}`);
  const abandon = page.getByRole("button", { name: t("session.abandon") });
  if (await abandon.isVisible()) {
    await page.getByLabel(t("session.abandonCheckbox")).check();
    page.once("dialog", (d) => void d.accept());
    await abandon.click();
  }
  await page.getByLabel(t("upload.file")).setInputFiles({
    name: "synthetic-old-system.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await syntheticWorkbookBytes(buildSyntheticWorkbook())),
  });
  await page.getByRole("button", { name: t("upload.analyze") }).click();
  await page.getByRole("heading", { name: t("recon.title") }).waitFor();
}

export const SCREENS: readonly Screen[] = [
  { slug: "today", persona: "rep", path: () => "/today" },
  { slug: "home", persona: "owner", path: () => "/" },
  // The role homes of the other personas (H1 UI pass): each role's "what do I do now?" page.
  { slug: "home-sd", persona: "sd", path: () => "/" },
  { slug: "home-am", persona: "am", path: () => "/" },
  { slug: "home-rep", persona: "rep", path: () => "/" },
  { slug: "home-finance", persona: "finance", path: () => "/" },
  { slug: "home-inventory", persona: "inventory", path: () => "/" },
  { slug: "home-admin", persona: "admin", path: () => "/" },
  { slug: "leads", persona: "rep", path: () => "/leads" },
  { slug: "leads-team", persona: "am", path: () => "/leads/team" },
  { slug: "lead-detail", persona: "rep", path: (ids) => `/leads/${ids.lead}` },
  { slug: "customers", persona: "rep", path: () => "/customers" },
  { slug: "customer-overview", persona: "rep", path: (ids) => `/customers/${ids.customer}` },
  { slug: "customer-visits", persona: "rep", path: (ids) => `/customers/${ids.customer}?tab=visits` },
  { slug: "customer-orders", persona: "rep", path: (ids) => `/customers/${ids.customer}?tab=orders` },
  { slug: "customer-invoices", persona: "rep", path: (ids) => `/customers/${ids.customer}?tab=invoices` },
  { slug: "customer-activity", persona: "rep", path: (ids) => `/customers/${ids.customer}?tab=activity` },
  { slug: "customer-no-phone", persona: "rep", path: (ids) => `/customers/${ids.customerNoPhone}` },
  { slug: "customer-new", persona: "rep", path: () => "/customers/new" },
  { slug: "order-builder", persona: "rep", path: (ids) => `/orders/new?customer=${ids.customer}` },
  { slug: "order-edit-draft", persona: "rep", path: (ids) => `/orders/${ids.orderDraft}/edit` },
  { slug: "orders", persona: "rep", path: () => "/orders" },
  { slug: "order-detail", persona: "rep", path: (ids) => `/orders/${ids.orderInvoiced}` },
  { slug: "order-detail-pending", persona: "am", path: (ids) => `/orders/${ids.orderPending}` },
  { slug: "visits", persona: "rep", path: () => "/visits" },
  { slug: "visit-new", persona: "rep", path: () => "/visits/new" },
  { slug: "visit-detail", persona: "rep", path: (ids) => `/visits/${ids.visitDone}` },
  { slug: "visit-in-progress", persona: "rep", path: (ids) => `/visits/${ids.visitOpen}` },
  { slug: "map", persona: "rep", path: () => "/map" },
  { slug: "map-team", persona: "am", path: () => "/map/team" },
  { slug: "map-proposals", persona: "am", path: () => "/map/proposals" },
  { slug: "approvals", persona: "am", path: () => "/approvals" },
  { slug: "approval-detail", persona: "am", path: (ids) => `/approvals/${ids.approval}` },
  { slug: "commissions", persona: "rep", path: () => "/commissions" },
  { slug: "commissions-team", persona: "am", path: () => "/commissions/team" },
  { slug: "commission-plans", persona: "owner", path: () => "/commissions/plans" },
  { slug: "commission-plan-editor", persona: "owner", path: (ids) => `/commissions/plans/${ids.plan}` },
  { slug: "commission-periods", persona: "finance", path: () => "/commissions/periods" },
  { slug: "commission-adjustments", persona: "finance", path: () => "/commissions/adjustments" },
  { slug: "finance", persona: "finance", path: () => "/finance" },
  { slug: "finance-invoices", persona: "finance", path: () => "/finance/invoices" },
  { slug: "finance-invoice", persona: "finance", path: (ids) => `/finance/invoices/${ids.invoice}` },
  { slug: "finance-payments", persona: "finance", path: () => "/finance/payments" },
  { slug: "finance-payment", persona: "finance", path: (ids) => `/finance/payments/${ids.payment}` },
  { slug: "finance-payment-new", persona: "rep", path: () => "/finance/payments/new" },
  { slug: "finance-collections", persona: "finance", path: () => "/finance/collections" },
  { slug: "finance-aging", persona: "finance", path: () => "/finance/aging" },
  { slug: "finance-statement", persona: "finance", path: (ids) => `/finance/customers/${ids.customer}/statement` },
  { slug: "inventory", persona: "inventory", path: () => "/inventory" },
  { slug: "inventory-stock", persona: "inventory", path: (ids) => `/inventory/stock/${ids.variant}` },
  { slug: "inventory-receipts", persona: "inventory", path: () => "/inventory/receipts" },
  { slug: "inventory-receipt", persona: "inventory", path: (ids) => `/inventory/receipts/${ids.receipt}` },
  { slug: "inventory-movements", persona: "inventory", path: () => "/inventory/movements" },
  { slug: "inventory-transfers", persona: "inventory", path: () => "/inventory/transfers" },
  { slug: "inventory-adjustments", persona: "inventory", path: () => "/inventory/adjustments" },
  { slug: "returns", persona: "sd", path: () => "/returns" },
  { slug: "return-detail", persona: "sd", path: (ids) => `/returns/${ids.returnId}` },
  { slug: "offers", persona: "owner", path: () => "/offers" },
  { slug: "offer-detail", persona: "owner", path: (ids) => `/offers/${ids.offer}` },
  { slug: "offers-vat", persona: "owner", path: () => "/offers/vat" },
  { slug: "catalog", persona: "owner", path: () => "/catalog" },
  { slug: "catalog-product", persona: "owner", path: (ids) => `/catalog/products/${ids.product}` },
  { slug: "catalog-price-lists", persona: "owner", path: () => "/catalog/price-lists" },
  { slug: "catalog-price-list", persona: "owner", path: (ids) => `/catalog/price-lists/${ids.priceList}` },
  { slug: "catalog-promotions", persona: "owner", path: () => "/catalog/promotions" },
  { slug: "dashboard", persona: "sd", path: () => "/dashboard" },
  { slug: "dashboard-targets", persona: "sd", path: () => "/dashboard/targets" },
  { slug: "reports", persona: "owner", path: () => "/reports" },
  { slug: "planning", persona: "am", path: () => "/planning" },
  { slug: "planning-coverage", persona: "am", path: () => "/planning/coverage" },
  { slug: "tracking", persona: "am", path: () => "/tracking" },
  { slug: "tracking-day", persona: "am", path: (ids) => `/tracking/${ids.employee}/${ids.today}` },
  { slug: "tasks", persona: "rep", path: () => "/tasks" },
  { slug: "opportunities", persona: "rep", path: () => "/opportunities" },
  { slug: "notifications", persona: "rep", path: () => "/notifications" },
  { slug: "sync", persona: "rep", path: () => "/sync" },
  { slug: "admin-setup", persona: "owner", path: () => "/admin/setup" },
  { slug: "admin-legacy-import", persona: "owner", path: () => "/admin/setup/legacy-import", prepare: uploadSyntheticWorkbook },
  { slug: "admin-users", persona: "admin", path: () => "/admin/users" },
  { slug: "admin-user", persona: "admin", path: (ids) => `/admin/users/${ids.user}` },
  { slug: "admin-employees", persona: "admin", path: () => "/admin/employees" },
  { slug: "admin-employee", persona: "owner", path: (ids) => `/admin/employees/${ids.employee}` },
  { slug: "admin-roles", persona: "admin", path: () => "/admin/roles" },
  { slug: "admin-role", persona: "admin", path: (ids) => `/admin/roles/${ids.role}` },
  { slug: "admin-territories", persona: "admin", path: () => "/admin/territories" },
  { slug: "admin-settings", persona: "owner", path: () => "/admin/settings" },
  { slug: "admin-security", persona: "owner", path: () => "/admin/security" },
  { slug: "workflow", persona: "admin", path: () => "/workflow" },
  { slug: "workflow-rules", persona: "admin", path: () => "/workflow/rules" },
  { slug: "imports", persona: "owner", path: () => "/imports" },
  { slug: "audit", persona: "owner", path: () => "/audit" },
  { slug: "account-security", persona: "owner", path: () => "/account/security" },
  { slug: "account-security-rep", persona: "rep", path: () => "/account/security" },
];
