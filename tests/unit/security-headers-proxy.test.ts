import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { proxy as ProxyFn } from "@/proxy";

/**
 * The proxy's CSP wiring, without a browser: the nonce must reach both the
 * response header (what the browser enforces) and the forwarded request headers
 * (what Next.js reads to stamp its scripts), and the auth redirect must stay as
 * it was. No cookies → no Supabase call leaves the process.
 *
 * next-intl's ESM build cannot load under plain Node (it imports "next/server"
 * without an extension), so it is replaced by a stand-in with the same contract
 * the proxy relies on: redirect a bare "/" to the default locale, otherwise
 * NextResponse.next() forwarding a *copy of request.headers* plus its locale
 * header (next-intl 4 middleware.js `next()`). The real middleware is covered by
 * the e2e routing and security-headers specs.
 */
vi.mock("next-intl/middleware", () => ({
  default: () => (request: NextRequest) => {
    if (request.nextUrl.pathname === "/") return NextResponse.redirect(new URL("/ar", request.url));
    const headers = new Headers(request.headers);
    headers.set("X-NEXT-INTL-LOCALE", request.nextUrl.pathname.split("/")[1] ?? "ar");
    return NextResponse.next({ request: { headers } });
  },
}));

let proxy: typeof ProxyFn;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "placeholder-anon-key-000000000";
  ({ proxy } = await import("@/proxy"));
});

const nonceOf = (csp: string | null) => csp?.match(/'nonce-([^']+)'/)?.[1];

describe("proxy CSP", () => {
  it("sets a nonce CSP on the response and forwards the same one to the render", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/ar/login"));
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' https://placeholder.supabase.co wss://placeholder.supabase.co");

    const nonce = nonceOf(csp);
    expect(nonce).toBeTruthy();
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(res.headers.get("x-middleware-override-headers")).toContain("content-security-policy");
  });

  it("uses a different nonce on every request", async () => {
    const a = await proxy(new NextRequest("http://localhost:3000/en/login"));
    const b = await proxy(new NextRequest("http://localhost:3000/en/login"));
    expect(nonceOf(a.headers.get("content-security-policy"))).not.toBe(nonceOf(b.headers.get("content-security-policy")));
  });

  it("overwrites a CSP or nonce the client tried to send", async () => {
    const res = await proxy(
      new NextRequest("http://localhost:3000/ar/login", {
        headers: { "content-security-policy": "script-src *", "x-nonce": "attacker" },
      }),
    );
    expect(res.headers.get("x-middleware-request-x-nonce")).not.toBe("attacker");
    expect(res.headers.get("x-middleware-request-content-security-policy")).not.toBe("script-src *");
  });

  it("does not upgrade insecure requests on plain http", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/ar/login"));
    expect(res.headers.get("content-security-policy")).not.toContain("upgrade-insecure-requests");
  });
});

describe("proxy auth behaviour is unchanged", () => {
  it("returns a locale redirect untouched", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/ar");
  });

  it("redirects an unauthenticated protected page to login with ?next", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/en/orders?status=draft"));
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/en/login");
    expect(location.searchParams.get("next")).toBe("/en/orders?status=draft");
  });

  it("lets the login page through without a redirect", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/ar/login"));
    expect(res.headers.get("location")).toBeNull();
  });
});
