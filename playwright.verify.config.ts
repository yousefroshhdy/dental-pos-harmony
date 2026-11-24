import { existsSync, readFileSync, rmSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import { previewDir, previewOutput } from "./tests/e2e-local/verify/env";

/**
 * The verification walkthrough (docs/VERIFICATION.md) as Playwright tests, one per line:
 * tests/e2e-local/verification.spec.ts.
 *
 * Local (default): against the local signed-in stack (`pnpm e2e:local:up`, then
 * `pnpm e2e:local:verify`). Every persona, every line, writing lines included (synthetic data).
 *
 * Preview (`pnpm verify:preview`): set VERIFY_BASE_URL (a Vercel preview or staging),
 * VERIFY_EMAIL, VERIFY_PASSWORD (a test account the owner creates; real password sign-in) and
 * VERIFY_ROLE (that account's role: owner, sd, am, rep, finance, inventory or admin). Staging
 * holds real data (owner decision A), so only read-only lines of that role run, and nothing that
 * could capture a page is kept: no screenshot, trace, video or failure page snapshot; the
 * session and Playwright's output folder live in a temporary folder deleted after the run.
 */
const preview = Boolean(process.env.VERIFY_BASE_URL);
if (process.env.VERIFY_EXPECT_PREVIEW && !preview) {
  throw new Error("pnpm verify:preview needs VERIFY_BASE_URL, VERIFY_EMAIL, VERIFY_PASSWORD and VERIFY_ROLE (docs/VERIFICATION.md)");
}
process.env.VERIFY_RUN_ID ??= String(process.pid);
if (preview) {
  // Playwright writes an ARIA snapshot of the page into error-context.md on a failure; this switches it off.
  process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
  // The runner (not a worker) removes the temporary folder when it exits, after Playwright has
  // written its last files there; verify-teardown.ts already removed the session.
  if (!process.env.TEST_WORKER_INDEX) process.on("exit", () => rmSync(previewDir(), { recursive: true, force: true }));
}

function localPort(): string {
  const file = ".cache/e2e-local/env.local";
  if (!existsSync(file)) return "3210";
  return readFileSync(file, "utf8").match(/^E2E_LOCAL_APP_PORT=(.*)$/m)?.[1] ?? "3210";
}

export default defineConfig({
  testDir: "tests/e2e-local",
  testMatch: /verification\.spec\.ts$/,
  globalSetup: "./tests/e2e-local/verify-setup.ts",
  globalTeardown: "./tests/e2e-local/verify-teardown.ts",
  outputDir: preview ? previewOutput() : "test-results/verify",
  fullyParallel: true,
  workers: preview ? 2 : 4,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: preview ? process.env.VERIFY_BASE_URL : `http://127.0.0.1:${localPort()}`,
    locale: "ar-EG",
    timezoneId: "Africa/Cairo",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "off",
    screenshot: "off",
    video: "off",
    browserName: "chromium",
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  projects: [{ name: preview ? "verify-preview" : "verify-local" }],
});
