import { expect, test, type Page } from "@playwright/test";

/**
 * docs/TESTING.md §2.8: nonce CSP (no unsafe-inline scripts), HSTS, frame-ancestors none.
 * The page CSP comes from src/proxy.ts; the other headers from next.config.ts
 * (both built by src/lib/security-headers.ts). The e2e server is a production
 * build on plain http, so HSTS is present but upgrade-insecure-requests is not.
 */

type Violation = { directive: string; blocked: string; sample: string };

/** Records every CSP violation (DOM event + console report) from the first byte of the page. */
async function watchCsp(page: Page): Promise<{ violations: () => Promise<Violation[]>; console: string[] }> {
  const consoleReports: string[] = [];
  page.on("console", (msg) => {
    if (/Content Security Policy/i.test(msg.text())) consoleReports.push(msg.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: Violation[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample });
    });
  });
  return {
    violations: () => page.evaluate(() => (window as unknown as { __csp: Violation[] }).__csp),
    console: consoleReports,
  };
}

function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const [name, ...values] = p.split(/\s+/);
        return [name!, values];
      }),
  );
}

test.describe("security headers", () => {
  test("/ar/login carries a nonce CSP and the hardening headers", async ({ request }) => {
    const res = await request.get("/ar/login");
    expect(res.status()).toBe(200);
    const h = res.headers();

    const csp = directives(h["content-security-policy"] ?? "");
    expect(csp["script-src"]).toEqual(expect.arrayContaining(["'strict-dynamic'"]));
    expect(csp["script-src"]?.some((v) => /^'nonce-[A-Za-z0-9+/=]+'$/.test(v))).toBe(true);
    expect(csp["script-src"]).not.toContain("'unsafe-inline'");
    expect(csp["script-src"]).not.toContain("'unsafe-eval'");
    expect(csp["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(csp["connect-src"]?.[0]).toBe("'self'");
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
    expect(csp["form-action"]).toEqual(["'self'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["worker-src"]).toEqual(["'self'"]);
    expect(csp["upgrade-insecure-requests"]).toBeUndefined(); // plain-http test server

    expect(h["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains; preload");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"]).toContain("geolocation=(self)");
    expect(h["permissions-policy"]).toContain("camera=()");
    expect(h["permissions-policy"]).toContain("microphone=()");
    expect(h["cross-origin-opener-policy"]).toBe("same-origin");
  });

  test("the nonce changes on every request", async ({ request }) => {
    const nonce = async () => (await request.get("/ar/login")).headers()["content-security-policy"]?.match(/'nonce-([^']+)'/)?.[1];
    const [a, b] = [await nonce(), await nonce()];
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  test("/api/health carries a locked-down CSP and the hardening headers", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const h = res.headers();
    const csp = directives(h["content-security-policy"] ?? "");
    expect(csp["default-src"]).toEqual(["'none'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(h["strict-transport-security"]).toContain("max-age=63072000");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["cross-origin-opener-policy"]).toBe("same-origin");
  });
});

test.describe("CSP in the browser", () => {
  test("the login page loads, hydrates and registers the service worker with no violations", async ({ page, baseURL }) => {
    const csp = await watchCsp(page);
    const response = await page.goto("/ar/login");
    const nonce = response?.headers()["content-security-policy"]?.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();

    // Next.js stamped this request's nonce on its scripts.
    const scriptNonces = await page.locator("script").evaluateAll((els) => els.map((s) => (s as HTMLScriptElement).nonce));
    expect(scriptNonces.length).toBeGreaterThan(0);
    expect(scriptNonces.every((n) => n === nonce)).toBe(true);

    // The registrar runs in a React effect, so a registered worker proves hydration
    // (nonce scripts ran) and that worker-src admits /sw.js.
    const swScope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(swScope).toBe(`${baseURL}/`);

    // The web manifest is fetchable under manifest-src.
    expect(await page.locator('link[rel="manifest"]').count()).toBeGreaterThan(0);

    await page.waitForLoadState("networkidle");
    expect(await csp.violations()).toEqual([]);
    expect(csp.console).toEqual([]);
  });

  // The XSS shape CSP must stop: injected markup carrying an inline event handler.
  // (A script element created from JS is allowed by 'strict-dynamic' by design:
  // only already-trusted code can create one.)
  test("an injected inline event handler is blocked", async ({ page }) => {
    const csp = await watchCsp(page);
    await page.goto("/en/login");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", '<img id="xss" src="/does-not-exist.png" onerror="window.__injected = 1">');
    });
    await expect.poll(async () => (await csp.violations()).length).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { __injected?: number }).__injected)).toBeUndefined();
    for (const v of await csp.violations()) expect(v.directive).toMatch(/^script-src/);
  });

  test("the offline fallback page renders with its own CSP and no violations", async ({ page }) => {
    const csp = await watchCsp(page);
    const res = await page.goto("/offline.html");
    expect(directives(res?.headers()["content-security-policy"] ?? "")["default-src"]).toEqual(["'none'"]);
    await expect(page.locator("h1")).toBeVisible();
    expect(await csp.violations()).toEqual([]);
  });
});
