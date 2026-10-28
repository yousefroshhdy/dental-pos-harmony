import { expect, test } from "@playwright/test";
import { messages, MIN_TAP_TARGET, scrollExtent, SMALL_PHONE, type Locale } from "./helpers";

// docs/TESTING.md §2.7: no horizontal scroll at 360×640, tap targets ≥ 44 px.
for (const locale of ["ar", "en"] as const satisfies readonly Locale[]) {
  test.describe(`login page at 360×640 (${locale})`, () => {
    test.use({ viewport: SMALL_PHONE });

    test("has no horizontal scroll", async ({ page }) => {
      await page.goto(`/${locale}/login`);
      const { scrollWidth, clientWidth } = await scrollExtent(page);
      expect(scrollWidth, `scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`).toBeLessThanOrEqual(clientWidth);
    });

    test("primary action and inputs are at least 44 px tall", async ({ page }) => {
      await page.goto(`/${locale}/login`);
      const t = messages[locale].auth;
      const targets = [
        page.getByRole("button", { name: t.submit, exact: true }),
        page.getByLabel(t.email),
        page.getByLabel(t.password),
      ];
      for (const target of targets) {
        await expect(target).toBeVisible();
        const box = await target.boundingBox();
        expect(box, "element has a layout box").not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET);
      }
    });
  });
}
