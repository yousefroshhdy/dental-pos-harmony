import { describe, expect, it } from "vitest";
import {
  API_CONTENT_SECURITY_POLICY,
  OFFLINE_PAGE_CONTENT_SECURITY_POLICY,
  buildContentSecurityPolicy,
  generateNonce,
  isHttpsRequest,
  staticSecurityHeaders,
  supabaseConnectSources,
} from "@/lib/security-headers";

/** "a b; c d" → { a: ["b"], c: ["d"] } */
function parse(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";").map((p) => p.trim()).filter(Boolean)) {
    const [name, ...values] = part.split(/\s+/);
    expect(out[name!], `duplicate directive ${name}`).toBeUndefined();
    out[name!] = values;
  }
  return out;
}

const NONCE = "dGVzdC1ub25jZS0xMjM0NQ==";
const SUPABASE = "https://abcd.supabase.co";

describe("generateNonce", () => {
  it("is base64 of 16 random bytes and differs per call", () => {
    const seen = new Set(Array.from({ length: 50 }, generateNonce));
    expect(seen.size).toBe(50);
    for (const n of seen) {
      expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(atob(n)).toHaveLength(16);
    }
  });
});

describe("buildContentSecurityPolicy (production)", () => {
  const csp = parse(buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl: SUPABASE, upgradeInsecureRequests: true }));

  it("allows scripts only by nonce + strict-dynamic, never unsafe-inline or unsafe-eval", () => {
    expect(csp["script-src"]).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
    expect(csp["script-src"]).not.toContain("'unsafe-inline'");
    expect(csp["script-src"]).not.toContain("'unsafe-eval'");
    expect(csp["default-src"]).toEqual(["'self'"]);
  });

  it("allows inline styles (React style attributes, Next-injected styles)", () => {
    expect(csp["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("restricts images, fonts, objects, base, forms and framing", () => {
    expect(csp["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(csp["font-src"]).toEqual(["'self'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
    expect(csp["form-action"]).toEqual(["'self'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["frame-src"]).toEqual(["'none'"]);
  });

  it("keeps the service worker and the web manifest loadable", () => {
    // Without worker-src the browser falls back to script-src, where 'strict-dynamic' voids 'self'.
    expect(csp["worker-src"]).toEqual(["'self'"]);
    expect(csp["manifest-src"]).toEqual(["'self'"]);
  });

  it("allows connections to our origin and Supabase over https and wss only", () => {
    expect(csp["connect-src"]).toEqual(["'self'", "https://abcd.supabase.co", "wss://abcd.supabase.co"]);
  });

  it("upgrades insecure requests when asked", () => {
    expect(csp["upgrade-insecure-requests"]).toEqual([]);
  });
});

describe("buildContentSecurityPolicy (options)", () => {
  it("adds unsafe-eval only in development", () => {
    const dev = parse(buildContentSecurityPolicy({ nonce: NONCE, isDev: true }));
    expect(dev["script-src"]).toContain("'unsafe-eval'");
    expect(dev["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("omits upgrade-insecure-requests by default", () => {
    expect(buildContentSecurityPolicy({ nonce: NONCE })).not.toContain("upgrade-insecure-requests");
  });

  it("falls back to 'self' when the Supabase URL is missing or invalid", () => {
    for (const supabaseUrl of [undefined, "", "not a url", "javascript:alert(1)", "ftp://x.example"]) {
      expect(parse(buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl }))["connect-src"]).toEqual(["'self'"]);
    }
  });

  it("rejects a nonce that could inject directives", () => {
    expect(() => buildContentSecurityPolicy({ nonce: "abc'; script-src *" })).toThrow();
    expect(() => buildContentSecurityPolicy({ nonce: "" })).toThrow();
  });

  it("uses a fresh nonce per call", () => {
    const a = buildContentSecurityPolicy({ nonce: generateNonce() });
    const b = buildContentSecurityPolicy({ nonce: generateNonce() });
    expect(a).not.toBe(b);
  });
});

describe("supabaseConnectSources", () => {
  it("uses the origin only (no path) and the matching socket scheme", () => {
    expect(supabaseConnectSources("https://abcd.supabase.co/rest/v1/")).toEqual([
      "https://abcd.supabase.co",
      "wss://abcd.supabase.co",
    ]);
    expect(supabaseConnectSources("http://127.0.0.1:54321")).toEqual(["http://127.0.0.1:54321", "ws://127.0.0.1:54321"]);
  });
});

describe("staticSecurityHeaders", () => {
  const toMap = (h: { key: string; value: string }[]) => Object.fromEntries(h.map(({ key, value }) => [key, value]));

  it("sets the baseline headers everywhere", () => {
    const h = toMap(staticSecurityHeaders({ isProduction: false }));
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(h["Permissions-Policy"]).toContain("geolocation=(self)");
    expect(h["Permissions-Policy"]).toContain("camera=()");
    expect(h["Permissions-Policy"]).toContain("microphone=()");
  });

  it("adds HSTS only in production", () => {
    expect(toMap(staticSecurityHeaders({ isProduction: false }))["Strict-Transport-Security"]).toBeUndefined();
    expect(toMap(staticSecurityHeaders({ isProduction: true }))["Strict-Transport-Security"]).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("never sets a page CSP (the proxy owns it; two CSP headers would both be enforced)", () => {
    for (const isProduction of [true, false]) {
      expect(toMap(staticSecurityHeaders({ isProduction }))["Content-Security-Policy"]).toBeUndefined();
    }
  });
});

describe("static CSPs", () => {
  it("API responses may load, run and embed nothing", () => {
    const csp = parse(API_CONTENT_SECURITY_POLICY);
    expect(csp["default-src"]).toEqual(["'none'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
  });

  it("the offline page allows its inline style but no scripts", () => {
    const csp = parse(OFFLINE_PAGE_CONTENT_SECURITY_POLICY);
    expect(csp["default-src"]).toEqual(["'none'"]);
    expect(csp["style-src"]).toEqual(["'unsafe-inline'"]);
    expect(csp["script-src"]).toBeUndefined(); // falls back to default-src 'none'
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
  });
});

describe("isHttpsRequest", () => {
  it("trusts the first x-forwarded-proto value when present", () => {
    expect(isHttpsRequest("http://internal/ar", "https")).toBe(true);
    expect(isHttpsRequest("http://internal/ar", "https, http")).toBe(true);
    expect(isHttpsRequest("https://x/ar", "http")).toBe(false);
  });

  it("falls back to the request URL scheme", () => {
    expect(isHttpsRequest("https://honest.example/ar", null)).toBe(true);
    expect(isHttpsRequest("http://127.0.0.1:3100/ar", null)).toBe(false);
  });
});
