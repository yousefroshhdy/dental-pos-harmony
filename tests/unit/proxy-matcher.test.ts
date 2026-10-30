import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { config as ProxyConfig } from "@/proxy";

/**
 * A-LM1: which paths the proxy (nonce CSP, session refresh, `next` on the login redirect)
 * runs on. It must run on every page, including pages whose path holds a dot (the audit
 * timeline links to `/audit/crm.customers/<id>`), and skip only real static files.
 *
 * next-intl's ESM build cannot load under plain Node (see security-headers-proxy.test.ts),
 * so it is replaced by a stand-in; only `config` is used here.
 */
vi.mock("next-intl/middleware", () => ({ default: () => () => NextResponse.next() }));

let config: typeof ProxyConfig;

type CompileMatchers = (matcher: unknown, nextConfig: object) => { regexp: string }[];

/**
 * Next's own matcher compiler (what `next build` runs on `config.matcher`; internal and
 * untyped), so the test checks the regex Next really uses, including its data-route prefix
 * and transport suffixes. At runtime Next tests it with `new RegExp(regexp)`: case-sensitive.
 */
async function matcher(): Promise<RegExp[]> {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon-key-000000000";
  ({ config } = await import("@/proxy"));
  const { getMiddlewareMatchers } = (await import("next/dist/build/analysis/get-page-static-info")) as unknown as {
    getMiddlewareMatchers: CompileMatchers;
  };
  return getMiddlewareMatchers(config.matcher, {}).map((m) => new RegExp(m.regexp));
}

const runs = async (path: string) => (await matcher()).some((re) => re.test(path));

const ID = "0b9c5c1e-7d4a-4c51-9a55-3f1f2d3c4b5a";

describe("proxy matcher: pages (proxy must run)", () => {
  it.each([
    "/",
    "/ar",
    "/en/",
    "/ar/login",
    "/en/auth/confirm",
    "/ar/today",
    "/en/orders",
    "/ar/audit",
    // The audit history pages: the table reference has a dot.
    `/ar/audit/crm.customers/${ID}`,
    `/en/audit/sales.orders/${ID}`,
    `/ar/audit/inventory.stock_movements/12345`,
    `/ar/audit/${encodeURIComponent("crm.customers")}/${ID}`,
    // Any other page segment that happens to contain a dot.
    "/ar/customers/x.y",
    "/en/catalog/products/RDT-1.2.5",
  ])("runs on %s", async (path) => {
    expect(await runs(path)).toBe(true);
  });
});

describe("proxy matcher: static files, API and Next internals (proxy must not run)", () => {
  it.each([
    // public/**
    "/sw.js",
    "/icon.svg",
    "/offline.html",
    // src/app/manifest.ts
    "/manifest.webmanifest",
    // conventional files Next or browsers may ask for
    "/favicon.ico",
    "/robots.txt",
    "/sitemap.xml",
    "/fonts/inter.woff2",
    "/images/logo.png",
    "/images/photo.webp",
    // Next internals and API routes
    "/_next/static/chunks/main-abc123.js",
    "/_next/static/css/app.css",
    "/_next/image",
    "/api/health",
    "/api/integrations/outbox",
  ])("skips %s", async (path) => {
    expect(await runs(path)).toBe(false);
  });
});

describe("proxy matcher covers everything that ships in public/", () => {
  it("every file in public/ is skipped", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(new URL("../../public/", import.meta.url), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => `${d.parentPath.split("/public")[1] ?? ""}/${d.name}`.replace(/^\/+/, "/"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(await runs(f), f).toBe(false);
  });
});
