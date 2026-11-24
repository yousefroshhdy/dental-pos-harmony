import type { Browser } from "@playwright/test";
import en from "../../messages/en.json";

/**
 * Signs one user in through the real login form (password) and saves the session cookies to
 * `statePath`. Used by the local screenshot run and by the verification run (local and preview).
 */
export async function signIn(browser: Browser, baseURL: string, email: string, password: string, statePath: string): Promise<void> {
  const context = await browser.newContext({ baseURL, locale: "en-US" });
  try {
    const page = await context.newPage();
    await page.goto("/en/login");
    await page.getByLabel(en.auth.email).fill(email);
    await page.getByLabel(en.auth.password).fill(password);
    await page.getByRole("button", { name: en.auth.submit, exact: true }).click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 30_000 });
    await context.storageState({ path: statePath });
  } finally {
    await context.close();
  }
}
