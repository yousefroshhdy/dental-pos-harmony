import { expect, type Locator, type Page } from "@playwright/test";
import { ar, arRe } from "./messages";
import { visit } from "./line";

/** Shared steps of the verification lines (Arabic labels from messages/ar). */

/** A visible button by its exact Arabic label (the order page renders an actions card and a phone sheet). */
export const button = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: typeof name === "string" }).filter({ visible: true }).first();

/** Visible text, exactly (a string) or by pattern. */
export const txt = (scope: Page | Locator, text: string | RegExp) =>
  scope.getByText(text, { exact: typeof text === "string" }).filter({ visible: true }).first();

export type BuilderLine = {
  /** SKU typed into the product search. */
  sku: string;
  /** How the line is priced: list price (default), a discount %, a net unit price, or free. */
  mode?: "discount" | "net" | "bonus";
  value?: string;
  quantity?: number;
};

export type BuilderInput = {
  customerId: string;
  offers?: string[];
  lines?: BuilderLine[];
  invoiceDiscountPct?: string;
};

/** Fills the order builder (/orders/new?customer=…); leaves the page on the builder. */
export async function fillBuilder(page: Page, input: BuilderInput): Promise<void> {
  await visit(page, `/orders/new?customer=${input.customerId}`);
  await expect(page.getByRole("heading", { name: ar("orders.builder.newTitle") })).toBeVisible();
  for (const code of input.offers ?? []) {
    await page.getByRole("button", { name: ar("orders.offers.addOffer", { code }) }).click();
    await expect(page.getByRole("button", { name: ar("orders.offers.removeOffer", { code }) })).toBeVisible();
  }
  const search = page.getByLabel(ar("orders.builder.search"));
  for (const l of input.lines ?? []) {
    await search.fill(l.sku);
    const result = page.getByRole("listitem").filter({ hasText: l.sku }).filter({ has: page.getByRole("button", { name: arRe("orders.builder.addLine") }) });
    await result.getByRole("button", { name: arRe("orders.builder.addLine") }).click();
    const card = page.getByRole("listitem").filter({ hasText: l.sku }).filter({ has: page.getByLabel(ar("orders.builder.priceMode")) });
    await expect(card).toBeVisible();
    if (l.quantity && l.quantity > 1) await card.getByLabel(ar("orders.builder.quantity"), { exact: true }).fill(String(l.quantity));
    if (l.mode) {
      await card.getByLabel(ar("orders.builder.priceMode")).selectOption(l.mode);
      if (l.mode !== "bonus") {
        const label = l.mode === "discount" ? ar("orders.builder.discountPct") : ar("orders.builder.netPrice");
        await card.getByLabel(label, { exact: true }).fill(l.value ?? "");
      }
    }
  }
  await search.fill("");
  if (input.invoiceDiscountPct) {
    await page.getByLabel(ar("orders.builder.invoiceDiscountKind")).selectOption("pct");
    await page.getByLabel(ar("orders.builder.discountPct"), { exact: true }).last().fill(input.invoiceDiscountPct);
  }
}

/** "Update prices": returns the preview card. */
export async function previewPrices(page: Page): Promise<Locator> {
  await button(page, ar("orders.builder.preview")).click();
  const card = page.locator("[aria-live=polite]").filter({ hasText: ar("orders.preview.title") });
  await expect(card).toBeVisible();
  return card;
}

/** "Save and review prices": lands on the draft's page and returns its id. */
export async function saveDraft(page: Page): Promise<string> {
  await button(page, ar("orders.builder.save")).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}\?saved=1/);
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  await expect(page.getByText(ar("orders.detail.savedOk"))).toBeVisible();
  return id;
}

/** "Submit order" on the order page. */
export async function submitOrder(page: Page): Promise<void> {
  await button(page, ar("orders.actions.submit")).click();
  await expect(page.getByText(new RegExp(`${ar("orders.detail.submittedOk")}|${ar("orders.detail.pendingTitle")}`)).first()).toBeVisible();
}

/** The status badge in the page header (h1). */
export const statusBadge = (page: Page, key: string) => page.getByRole("heading", { level: 1 }).getByText(ar(key), { exact: true });

/** The order number shown in the order page's header. */
export async function orderNumber(page: Page, orderId: string): Promise<string> {
  await visit(page, `/orders/${orderId}`);
  const text = await page.getByRole("heading", { level: 1 }).innerText();
  const no = text.match(/SO-\d{4}-\d{6}/)?.[0];
  if (!no) throw new Error(`no order number in "${text}"`);
  return no;
}

/** Picks an option in the shared Combobox (the button showing its placeholder, then type and pick). */
export async function chooseInCombobox(page: Page, placeholder: string, option: string): Promise<void> {
  await page.getByRole("combobox").filter({ hasText: placeholder }).first().click();
  await page.keyboard.type(option);
  await page.getByRole("option", { name: new RegExp(`^${option}(\\s|$)`) }).first().click();
}
