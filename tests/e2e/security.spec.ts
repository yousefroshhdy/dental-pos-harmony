import { expect, test } from "@playwright/test";

/** docs/TESTING.md §2.8. Headers come from next.config.ts. */
test.describe("security headers", () => {
  test("are present on /ar/login", async ({ request }) => {
    const res = await request.get("/ar/login");
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["strict-transport-security"]).toContain("max-age=");
    expect(h["permissions-policy"]).toContain("geolocation=(self)");
    expect(h["x-powered-by"]).toBeUndefined();
  });

  test("are present on API responses too", async ({ request }) => {
    const h = (await request.get("/api/health")).headers();
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-powered-by"]).toBeUndefined();
  });
});

/**
 * Open-redirect guard. Submitting the form needs Supabase, so the server-side
 * check (safeNextPath) is unit-tested in tests/unit/safe-redirect.test.ts.
 * Here we prove the page treats ?next as inert data: it is echoed only into the
 * hidden form field, never followed, never turned into a link or markup.
 */
test.describe("login ?next parameter", () => {
  const nextField = 'input[type="hidden"][name="next"]';

  test("is absent when the query has no next", async ({ page }) => {
    await page.goto("/ar/login");
    await expect(page.locator(nextField)).toHaveCount(0);
  });

  test("an external //host target renders the page without navigating away", async ({ page, baseURL }) => {
    await page.goto("/ar/login?next=//evil.com");
    await page.waitForLoadState("networkidle");
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
    await expect(page).toHaveURL(/\/ar\/login\?next=/);
    await expect(page.locator(nextField)).toHaveValue("//evil.com");
    await expect(page.locator('a[href*="evil.com"], meta[http-equiv="refresh" i]')).toHaveCount(0);
  });

  test("an absolute https target is not followed either", async ({ page, baseURL }) => {
    await page.goto(`/en/login?next=${encodeURIComponent("https://evil.com/phish")}`);
    await page.waitForLoadState("networkidle");
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
    await expect(page.locator(nextField)).toHaveValue("https://evil.com/phish");
  });

  test("markup in next is escaped, not injected", async ({ page }) => {
    const payload = '"><img id="pwned" src="x" onerror="window.__pwned=1">';
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await page.goto(`/ar/login?next=${encodeURIComponent(payload)}`);
    await expect(page.locator(nextField)).toHaveValue(payload);
    await expect(page.locator("#pwned")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(dialogs).toEqual([]);
  });
});
