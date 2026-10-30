import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { proxy as ProxyFn } from "@/proxy";
import { metaPolicyForNonce } from "@/lib/security-headers";

/**
 * F1 (web half): the proxy forwards the <meta> copy of the page CSP to the render, built
 * from the same options and nonce as the response header. Same next-intl stand-in as
 * security-headers-proxy.test.ts (its ESM build cannot load under plain Node).
 */
vi.mock("next-intl/middleware", () => ({
  default: () => (request: NextRequest) => {
    if (request.nextUrl.pathname === "/") return NextResponse.redirect(new URL("/ar", request.url));
    return NextResponse.next({ request: { headers: new Headers(request.headers) } });
  },
}));

let proxy: typeof ProxyFn;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "placeholder-anon-key-000000000";
  ({ proxy } = await import("@/proxy"));
});

const nonceOf = (csp: string | null) => csp?.match(/'nonce-([^']+)'/)?.[1];

describe("proxy forwards the meta copy of the CSP", () => {
  it("is the response header minus frame-ancestors, with the same nonce", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/ar/login"));
    const header = res.headers.get("content-security-policy")!;
    const meta = res.headers.get("x-middleware-request-x-csp-meta")!;
    const nonce = res.headers.get("x-middleware-request-x-nonce")!;

    expect(meta).toBe(header.replace("; frame-ancestors 'none'", ""));
    expect(meta).not.toContain("frame-ancestors");
    expect(nonceOf(meta)).toBe(nonce);
    expect(nonceOf(header)).toBe(nonce);
    expect(res.headers.get("x-middleware-override-headers")).toContain("x-csp-meta");
    // What the root layout will emit.
    expect(metaPolicyForNonce(meta, nonce)).toBe(meta);
  });

  it("overwrites a meta policy the client tried to send", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/ar/login", { headers: { "x-csp-meta": "script-src *" } }));
    expect(res.headers.get("x-middleware-request-x-csp-meta")).toContain("'strict-dynamic'");
  });

  it("an audit history page (dotted path) is handled: login redirect keeps ?next", async () => {
    const path = "/ar/audit/crm.customers/0b9c5c1e-7d4a-4c51-9a55-3f1f2d3c4b5a";
    const res = await proxy(new NextRequest(`http://localhost:3000${path}`));
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/ar/login");
    expect(location.searchParams.get("next")).toBe(path);
  });
});
