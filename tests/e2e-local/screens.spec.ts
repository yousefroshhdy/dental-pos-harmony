import { writeFileSync } from "node:fs";
import path from "node:path";
import { test, type Page } from "@playwright/test";
import { SCREENS } from "./screens";
import { readIds, RESULTS_DIR, SHOTS_DIR, STATE_DIR, type ShotResult } from "./stack";

/**
 * One full-page screenshot per screen × locale × width (docs/TESTING.md "Local signed-in
 * stack"), plus automatic checks written next to it (global-teardown turns them into index.md):
 * horizontal scroll at phone width, visible buttons/links in <main> under 44 px, text that looks
 * like an untranslated message key, console errors, failed requests, error boundaries, 404/500.
 * Nothing is asserted: the run is a review aid, not a gate.
 */
const LOCALES = (process.env.SHOTS_LOCALES ?? "ar,en").split(",").map((s) => s.trim()).filter(Boolean);
const WIDTHS = (process.env.SHOTS_WIDTHS ?? "390,1440").split(",").map((s) => Number(s.trim())).filter(Boolean);
const ONLY = process.env.SHOTS_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
const HEIGHT: Record<number, number> = { 390: 844, 1440: 900 };
const MIN_TAP = 44;

// Error boundaries and the shared "could not load" states, in both languages.
const ERROR_TEXT = /something went wrong|could not be shown|حدث خطأ|تعذر عرض/i;
// A rendered next-intl fallback looks like "namespace.key" (no spaces, at least one dot).
const KEY_LIKE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+$/;

async function audit(page: Page, width: number) {
  return page.evaluate(
    ({ minTap, phone, keyLike }) => {
      const keyRe = new RegExp(keyLike);
      const doc = document.documentElement;
      const hScroll = phone && doc.scrollWidth > window.innerWidth ? { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth } : null;
      const main = document.querySelector("main") ?? document.body;
      const small: string[] = [];
      for (const el of Array.from(main.querySelectorAll<HTMLElement>("a[href], button, [role=button], [role=tab]"))) {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
        if (r.height < minTap || r.width < minTap) {
          const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
          small.push(`${el.tagName.toLowerCase()} "${label || "(no text)"}" ${Math.round(r.width)}×${Math.round(r.height)}`);
        }
      }
      const untranslated = new Set<string>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;
        const text = (n.textContent ?? "").trim();
        if (text && keyRe.test(text) && !text.includes("@")) untranslated.add(text);
      }
      const alerts = Array.from(document.querySelectorAll<HTMLElement>("[role=alert]"))
        .map((a) => (a.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 160))
        .filter(Boolean);
      const bodyText = document.body.innerText;
      return {
        hScroll,
        smallTargets: small,
        untranslated: [...untranslated],
        alerts,
        bodyText: bodyText.slice(0, 4000),
        notFound: /^\s*404\b/.test(bodyText),
      };
    },
    { minTap: MIN_TAP, phone: width < 600, keyLike: KEY_LIKE.source },
  );
}

const ids = readIds();
const screens = SCREENS.filter((s) => !ONLY || ONLY.includes(s.slug));

for (const screen of screens) {
  const nn = String(SCREENS.indexOf(screen) + 1).padStart(2, "0");
  for (const locale of LOCALES) {
    for (const width of WIDTHS) {
      const file = `${nn}-${screen.slug}-${screen.persona}-${locale}-${width}.png`;
      test(`${file}`, async ({ browser }) => {
        const context = await browser.newContext({
          storageState: path.join(STATE_DIR, `${screen.persona}.json`),
          viewport: { width, height: HEIGHT[width] ?? 900 },
          deviceScaleFactor: 1,
          locale: locale === "ar" ? "ar-EG" : "en-US",
          timezoneId: "Africa/Cairo",
          // A field user who allowed location, standing at the demo base in Nasr City.
          permissions: ["geolocation"],
          geolocation: { latitude: 30.06, longitude: 31.335, accuracy: 12 },
        });
        const page = await context.newPage();
        const consoleErrors: string[] = [];
        const failedRequests: string[] = [];
        page.on("console", (msg) => {
          if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
        });
        page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message.slice(0, 200)}`));
        page.on("requestfailed", (req) => {
          const reason = req.failure()?.errorText ?? "";
          // Cancelled prefetches and superseded navigations are normal, not failures.
          if (reason !== "net::ERR_ABORTED") failedRequests.push(`${req.method()} ${req.url()} ${reason}`);
        });
        page.on("response", (res) => {
          if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`);
        });

        const url = `/${locale}${screen.path(ids)}`;
        const response = await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
        await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
        const found = await audit(page, width);
        await page.screenshot({ path: path.join(SHOTS_DIR, file), fullPage: true });

        const result: ShotResult = {
          file,
          nn,
          screen: screen.slug,
          persona: screen.persona,
          locale,
          width,
          url: new URL(page.url()).pathname + new URL(page.url()).search,
          status: response?.status() ?? null,
          hScroll: found.hScroll,
          smallTargets: found.smallTargets,
          untranslated: found.untranslated,
          consoleErrors,
          failedRequests,
          alerts: found.alerts,
          errorBoundary: ERROR_TEXT.test(found.bodyText),
          notFound: found.notFound || response?.status() === 404,
        };
        writeFileSync(path.join(RESULTS_DIR, file.replace(/\.png$/, ".json")), JSON.stringify(result, null, 2));
        await context.close();
      });
    }
  }
}
