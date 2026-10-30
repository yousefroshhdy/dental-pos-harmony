import { describe, expect, it } from "vitest";
import {
  CSP_META_REQUEST_HEADER,
  META_UNSUPPORTED_DIRECTIVES,
  NONCE_REQUEST_HEADER,
  buildContentSecurityPolicy,
  buildPageContentSecurityPolicies,
  metaPolicyForNonce,
} from "@/lib/security-headers";

/**
 * F1 (web half): the Android app (Capacitor) fetches top-level HTML itself and drops the
 * response headers, so the page also carries the policy as <meta http-equiv>. Browsers
 * enforce both, which intersect, so the meta copy must be the header policy minus only
 * the directives a meta policy may not carry (CSP3: frame-ancestors, report-uri, sandbox).
 */

const NONCE = "dGVzdC1ub25jZS0xMjM0NQ==";

function directives(csp: string): string[] {
  return csp.split(";").map((p) => p.trim()).filter(Boolean);
}
const nameOf = (d: string) => d.split(/\s+/)[0]!;

describe.each([
  { label: "production over https", opts: { nonce: NONCE, supabaseUrl: "https://abcd.supabase.co", upgradeInsecureRequests: true } },
  { label: "production over http", opts: { nonce: NONCE, supabaseUrl: "https://abcd.supabase.co" } },
  { label: "development", opts: { nonce: NONCE, supabaseUrl: "http://127.0.0.1:54321", isDev: true } },
  { label: "no supabase url", opts: { nonce: NONCE } },
])("meta policy = header policy minus meta-invalid directives ($label)", ({ opts }) => {
  const header = buildContentSecurityPolicy(opts);
  const meta = buildContentSecurityPolicy({ ...opts, delivery: "meta" });

  it("keeps every other directive, in the same order, byte for byte", () => {
    const expected = directives(header).filter((d) => !(META_UNSUPPORTED_DIRECTIVES as readonly string[]).includes(nameOf(d)));
    expect(directives(meta)).toEqual(expected);
  });

  it("drops frame-ancestors, report-uri and sandbox (and only those)", () => {
    for (const name of META_UNSUPPORTED_DIRECTIVES) expect(directives(meta).map(nameOf)).not.toContain(name);
    expect(directives(header).length - directives(meta).length).toBe(1); // the header carries frame-ancestors only
    expect(header).toContain("frame-ancestors 'none'");
  });

  it("carries the same nonce", () => {
    expect(meta).toContain(`'nonce-${NONCE}'`);
    expect(meta).toContain("'strict-dynamic'");
  });
});

describe("buildPageContentSecurityPolicies", () => {
  it("builds both copies from one options object, so they cannot drift", () => {
    const opts = { nonce: NONCE, supabaseUrl: "https://abcd.supabase.co", upgradeInsecureRequests: true };
    const both = buildPageContentSecurityPolicies(opts);
    expect(both.header).toBe(buildContentSecurityPolicy(opts));
    expect(both.meta).toBe(buildContentSecurityPolicy({ ...opts, delivery: "meta" }));
  });

  it("the meta copy still blocks frames, plugins, base and form hijacking", () => {
    const { meta } = buildPageContentSecurityPolicies({ nonce: NONCE });
    expect(meta).toContain("frame-src 'none'");
    expect(meta).toContain("object-src 'none'");
    expect(meta).toContain("base-uri 'self'");
    expect(meta).toContain("form-action 'self'");
    expect(meta).not.toContain("'unsafe-inline' 'strict-dynamic'");
    expect(meta).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});

describe("metaPolicyForNonce (what the root layout emits)", () => {
  const { meta } = buildPageContentSecurityPolicies({ nonce: NONCE });

  it("returns the forwarded meta policy when it carries the forwarded nonce", () => {
    expect(metaPolicyForNonce(meta, NONCE)).toBe(meta);
  });

  it.each([
    ["no headers (the proxy did not run)", null, null],
    ["no nonce", meta, null],
    ["no policy", null, NONCE],
    ["a nonce the policy does not carry", meta, "b3RoZXItbm9uY2U="],
    ["a nonce that is not base64", meta, "x' 'unsafe-inline"],
    ["a policy that tries to re-allow framing", `${meta}; frame-ancestors *`, NONCE],
  ])("returns null for %s", (_label, policy, nonce) => {
    expect(metaPolicyForNonce(policy, nonce)).toBeNull();
  });

  it("uses the request header names the proxy sets", () => {
    expect(NONCE_REQUEST_HEADER).toBe("x-nonce");
    expect(CSP_META_REQUEST_HEADER).toBe("x-csp-meta");
  });
});
