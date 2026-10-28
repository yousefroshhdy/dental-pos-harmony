import { expect, test } from "@playwright/test";
import { ARABIC_SCRIPT, messages } from "./helpers";

test.describe("localisation of the login page", () => {
  test("Arabic page is RTL with Arabic text", async ({ page }) => {
    await page.goto("/ar/login");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("dir", "rtl");
    await expect(html).toHaveAttribute("lang", "ar");

    const title = messages.ar.auth.title;
    expect(title).toMatch(ARABIC_SCRIPT);
    await expect(page).toHaveTitle(new RegExp(title));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByRole("button", { name: messages.ar.auth.submit, exact: true })).toBeVisible();
  });

  test("English page is LTR", async ({ page }) => {
    await page.goto("/en/login");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("dir", "ltr");
    await expect(html).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle(new RegExp(messages.en.auth.title));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(messages.en.auth.title);
  });

  test("the locale switcher swaps language and keeps the path", async ({ page }) => {
    await page.goto("/ar/login");

    await page.getByRole("link", { name: messages.ar.common.language }).click();
    await expect(page).toHaveURL(/\/en\/login$/);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(messages.en.auth.title);

    await page.getByRole("link", { name: messages.en.common.language }).click();
    await expect(page).toHaveURL(/\/ar\/login$/);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(messages.ar.auth.title);
  });
});
