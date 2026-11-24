import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type FullConfig } from "@playwright/test";
import { signIn } from "./sign-in";
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
      await signIn(browser, baseURL, email, env.E2E_LOCAL_PASSWORD ?? "", path.join(STATE_DIR, `${persona}.json`));
    }
  } finally {
    await browser.close();
  }
}
