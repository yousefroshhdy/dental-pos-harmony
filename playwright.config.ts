import { defineConfig, devices, type Project } from "@playwright/test";

/**
 * End-to-end smoke tests (docs/TESTING.md §1, §2.7, §2.8).
 *
 * Runs against a production build (`pnpm build` first) served by `next start`
 * with placeholder public env, so no live Supabase is needed: the suite covers
 * what works without a session (routing, locale, layout, headers, PWA files).
 *
 * Local knobs (all optional):
 * - E2E_PORT          port for the app server (default 3100).
 * - PW_CHROMIUM_PATH  Chromium/Chrome binary for the chromium projects, when the
 *                     browsers installed for @playwright/test are not available.
 * - PW_PROJECTS       comma-separated project names to keep, e.g.
 *                     "mobile-android,desktop-chrome" (same effect as --project).
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CI = Boolean(process.env.CI);

// Public, non-secret placeholders: the build and server only need them to be well-formed.
const PLACEHOLDER_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "placeholder-anon-key-for-build-only",
  NEXT_TELEMETRY_DISABLED: "1",
};

const chromiumLaunch = process.env.PW_CHROMIUM_PATH
  ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
  : {};

const allProjects: Project[] = [
  { name: "mobile-android", use: { ...devices["Pixel 7"], ...chromiumLaunch } },
  { name: "mobile-ios", use: { ...devices["iPhone 14"] } }, // WebKit
  { name: "desktop-chrome", use: { ...devices["Desktop Chrome"], ...chromiumLaunch } },
];

const only = process.env.PW_PROJECTS?.split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const projects = only?.length ? allProjects.filter((p) => only.includes(p.name ?? "")) : allProjects;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    // Our users: Arabic-first, in Egypt (D-11). Tests that need English set it explicitly.
    locale: "ar-EG",
    timezoneId: "Africa/Cairo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects,
  webServer: {
    command: `pnpm start --port ${PORT}`,
    url: `${BASE_URL}/api/health`,
    env: PLACEHOLDER_ENV,
    reuseExistingServer: !CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
