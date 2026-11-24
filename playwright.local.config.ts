import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/**
 * Screenshots of the signed-in app against the LOCAL stack (docs/TESTING.md "Local signed-in
 * stack"): start it with `pnpm e2e:local:up`, then `pnpm e2e:local:shots`. Separate from
 * playwright.config.ts, so CI's e2e suite is untouched. Nothing here runs in CI.
 *
 * Knobs: SHOTS_DIR (where PNGs and index.md go), SHOTS_ONLY (comma-separated screen slugs),
 * SHOTS_LOCALES ("ar,en"), SHOTS_WIDTHS ("390,1440"), PW_CHROMIUM_PATH (a Chromium binary when
 * the browsers installed for @playwright/test are not available, as in playwright.config.ts).
 */
const ENV_FILE = ".cache/e2e-local/env.local";

function localEnv(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const env = localEnv();
const port = env.E2E_LOCAL_APP_PORT ?? "3210";

export default defineConfig({
  testDir: "tests/e2e-local",
  // The verification walkthrough has its own config (playwright.verify.config.ts).
  testMatch: /screens\.spec\.ts$/,
  globalSetup: "./tests/e2e-local/global-setup.ts",
  globalTeardown: "./tests/e2e-local/global-teardown.ts",
  fullyParallel: true,
  workers: 4,
  retries: 0,
  timeout: 120_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: "ar-EG",
    timezoneId: "Africa/Cairo",
    deviceScaleFactor: 1,
    trace: "off",
    screenshot: "off",
    browserName: "chromium",
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  projects: [{ name: "local-shots" }],
});
