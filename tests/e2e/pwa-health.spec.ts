import { expect, test } from "@playwright/test";

test("/api/health reports ok and is never cached", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  expect(res.headers()["cache-control"]).toContain("no-store");
  const body = (await res.json()) as { status: string; time: string };
  expect(body.status).toBe("ok");
  expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  // Liveness only: nothing about configuration or the database.
  expect(Object.keys(body).sort()).toEqual(["status", "time"]);
});

test("/manifest.webmanifest is valid JSON with an Arabic RTL start", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = JSON.parse(await res.text()) as Record<string, unknown>;
  expect(manifest.start_url).toBe("/ar");
  expect(manifest.dir).toBe("rtl");
  expect(manifest.lang).toBe("ar");
  expect(manifest.display).toBe("standalone");
  expect(Array.isArray(manifest.icons) && manifest.icons.length > 0).toBe(true);
});

test("/sw.js is served uncached so updates reach devices", async ({ request }) => {
  const res = await request.get("/sw.js");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("javascript");
  expect(res.headers()["cache-control"]).toContain("no-cache");
});

test("the offline fallback page exists and is Arabic RTL", async ({ request }) => {
  const res = await request.get("/offline.html");
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('dir="rtl"');
  expect(html).toContain('lang="ar"');
});
