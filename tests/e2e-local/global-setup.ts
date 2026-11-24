import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type FullConfig } from "@playwright/test";
import en from "../../messages/en.json";
import { IDS_FILE, localEnv, PERSONAS, queryIds, RESULTS_DIR, SHOTS_DIR, STATE_DIR } from "./stack";

/** Signs every persona in once through the real login form and keeps its cookies; reads the demo ids. */
export default async function globalSetup(config: FullConfig) {
  const env = localEnv();
  const baseURL = config.projects[0]?.use.baseURL ?? `http://127.0.0.1:${env.E2E_LOCAL_APP_PORT ?? "3210"}`;
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(SHOTS_DIR, { recursive: true });
  rmSync(RESULTS_DIR, { recursive: true, force: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(IDS_FILE, JSON.stringify(queryIds(), null, 2));

  const browser = await chromium.launch(
    process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  );
  try {
    for (const [persona, email] of Object.entries(PERSONAS)) {
      const context = await browser.newContext({ baseURL, locale: "en-US" });
      const page = await context.newPage();
      await page.goto("/en/login");
      await page.getByLabel(en.auth.email).fill(email);
      await page.getByLabel(en.auth.password).fill(env.E2E_LOCAL_PASSWORD ?? "");
      await page.getByRole("button", { name: en.auth.submit, exact: true }).click();
      await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 30_000 });
      await context.storageState({ path: path.join(STATE_DIR, `${persona}.json`) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
