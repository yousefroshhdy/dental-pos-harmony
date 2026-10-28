import { expect, test } from "@playwright/test";

/**
 * Locale prefixing (next-intl) and the unauthenticated redirect in src/proxy.ts.
 * No Supabase session exists in these tests, so every protected page must send
 * the visitor to the login page of the same locale.
 */
test.describe("routing without a session", () => {
  test("/ redirects to /ar, then /ar redirects to /ar/login", async ({ request }) => {
    const root = await request.get("/", { maxRedirects: 0, headers: { "Accept-Language": "ar-EG,ar;q=0.9" } });
    expect(root.status()).toBe(307);
    expect(root.headers()["location"]).toBe("/ar");

    const ar = await request.get("/ar", { maxRedirects: 0 });
    expect(ar.status()).toBe(307);
    // The locale home itself is not worth a ?next= round trip.
    expect(ar.headers()["location"]).toBe("/ar/login");
  });

  test("/ falls back to Arabic when the browser states no preference", async ({ request }) => {
    const root = await request.get("/", { maxRedirects: 0, headers: { "Accept-Language": "" } });
    expect(root.headers()["location"]).toBe("/ar");
  });

  test("/ stays Arabic even for an English browser (D-11: Arabic first; locale detection off)", async ({ request }) => {
    const root = await request.get("/", { maxRedirects: 0, headers: { "Accept-Language": "en-US,en;q=0.9" } });
    expect(root.headers()["location"]).toBe("/ar");
  });

  test("an Arabic browser opening / lands on the Arabic login page", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/ar\/login$/);
  });

  test("unauthenticated /en/admin/users goes to the English login with ?next", async ({ page, request }) => {
    const res = await request.get("/en/admin/users", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toBe("/en/login?next=%2Fen%2Fadmin%2Fusers");

    await page.goto("/en/admin/users");
    await expect(page).toHaveURL(/\/en\/login\?next=%2Fen%2Fadmin%2Fusers$/);
    await expect(page.locator('input[type="hidden"][name="next"]')).toHaveValue("/en/admin/users");
  });

  test("the query string is kept in ?next", async ({ request }) => {
    const res = await request.get("/ar/admin/roles?tab=permissions", { maxRedirects: 0 });
    expect(res.headers()["location"]).toBe("/ar/login?next=%2Far%2Fadmin%2Froles%3Ftab%3Dpermissions");
  });
});
