import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { IDS_FILE, type Ids, type Persona } from "../stack";
import { PREVIEW, previewRole, statePath } from "./env";
import { ar } from "./messages";

/**
 * One Playwright test per line of docs/VERIFICATION.md, titled with the line id ("OWN-03 …").
 * `writes: true` lines change data: they run only on the local stack and are skipped in
 * preview mode (staging holds real data). In preview mode a line runs only for the role of
 * the test account (VERIFY_ROLE).
 */
export type LineMeta = {
  /** The persona whose account runs the line. */
  as: Persona;
  /** The line changes data (or posts a file): local stack only. */
  writes?: boolean;
  /** Phone width (390 × 844) instead of desktop (1440 × 900). */
  phone?: boolean;
  /** Needs the demo ids (local only), e.g. a seeded customer or order. */
  demoData?: boolean;
};

export type LineArgs = { page: Page; context: BrowserContext; ids: Ids; local: boolean; browser: Browser };

const ids: Ids = !PREVIEW && existsSync(IDS_FILE) ? (JSON.parse(readFileSync(IDS_FILE, "utf8")) as Ids) : {};

export async function openAs(browser: Browser, persona: Persona, phone = false): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    storageState: statePath(persona),
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    locale: "ar-EG",
    timezoneId: "Africa/Cairo",
  });
  return { context, page: await context.newPage() };
}

export function line(id: string, title: string, meta: LineMeta, body: (args: LineArgs) => Promise<void>) {
  test(`${id} ${title}`, async ({ browser }) => {
    if (PREVIEW) {
      test.skip(meta.writes === true, "writes data: runs on the local stack only (staging holds real data)");
      test.skip(meta.demoData === true, "needs the local demo records");
      const role = previewRole();
      test.skip(meta.as !== role, `line for the ${meta.as} role; this run's test account is ${role} (VERIFY_ROLE)`);
    }
    const { context, page } = await openAs(browser, meta.as, meta.phone);
    try {
      await body({ page, context, ids, local: !PREVIEW, browser });
    } finally {
      await context.close();
    }
  });
}

/** Opens a page under /ar and checks it rendered: no error boundary, no 404, no sign-in redirect. */
export async function visit(page: Page, path: string): Promise<void> {
  const res = await page.goto(`/ar${path}`, { waitUntil: "domcontentloaded" });
  expect(res?.status(), `HTTP status of /ar${path}`).toBeLessThan(400);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText(/something went wrong|حدث خطأ|تعذر عرض/i)).toHaveCount(0);
}

/** The shared "Access denied" page. */
export async function expectForbidden(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: ar("admin.forbidden.title") })).toBeVisible();
}

export const heading = (page: Page, name: string | RegExp) => page.getByRole("heading", { name }).first();
