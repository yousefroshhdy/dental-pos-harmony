import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type FullConfig } from "@playwright/test";
import { signIn } from "./sign-in";
import { IDS_FILE, localEnv, PERSONAS, queryIds, STATE_DIR } from "./stack";
import { PREVIEW, previewDir, previewRole, previewState } from "./verify/env";

/**
 * Verification run (docs/VERIFICATION.md). Local: every persona signs in through the login form
 * and the demo ids are read. Preview: the one test account signs in (real Supabase password
 * sign-in); its session is kept in a temporary folder outside the repository and deleted by
 * verify-teardown.ts.
 */
export default async function verifySetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL ?? "";
  const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
  try {
    if (PREVIEW) {
      previewRole(); // fail fast on a missing or unknown role
      const email = process.env.VERIFY_EMAIL ?? "";
      const password = process.env.VERIFY_PASSWORD ?? "";
      if (!email || !password) throw new Error("preview mode needs VERIFY_EMAIL and VERIFY_PASSWORD (the owner's test account)");
      mkdirSync(previewDir(), { recursive: true, mode: 0o700 });
      await signIn(browser, baseURL, email, password, previewState());
      return;
    }
    const env = localEnv();
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(IDS_FILE, JSON.stringify(queryIds(), null, 2));
    for (const [persona, email] of Object.entries(PERSONAS)) {
      await signIn(browser, baseURL, email, env.E2E_LOCAL_PASSWORD ?? "", path.join(STATE_DIR, `${persona}.json`));
    }
  } finally {
    await browser.close();
  }
}
