import { describe, expect, it } from "vitest";
import {
  GOOGLE_MAPS_CSP_SOURCES,
  buildContentSecurityPolicy,
  buildPageContentSecurityPolicies,
  metaPolicyForNonce,
} from "@/lib/security-headers";

/**
 * Phase P step 3: the Google Maps JavaScript API sources (Google's CSP guide for Maps JS,
 * strict nonce variant) are added only when the proxy passes `googleMaps: true`, and they never
 * weaken script-src: still nonce + 'strict-dynamic', no host sources, no 'unsafe-eval'.
 */

const NONCE = "dGVzdC1ub25jZS0xMjM0NQ==";
const SUPABASE = "https://abcd.supabase.co";

function parse(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";").map((p) => p.trim()).filter(Boolean)) {
    const [name, ...values] = part.split(/\s+/);
    expect(out[name!], `duplicate directive ${name}`).toBeUndefined();
    out[name!] = values;
  }
  return out;
}

const withMaps = parse(buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl: SUPABASE, googleMaps: true }));
const without = parse(buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl: SUPABASE }));

describe("CSP with Google Maps", () => {
  it("keeps script-src exactly as without Maps: nonce + strict-dynamic, no hosts, no eval", () => {
    expect(withMaps["script-src"]).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
    expect(withMaps["script-src"]).toEqual(without["script-src"]);
    expect(withMaps["script-src"]!.join(" ")).not.toMatch(/google|gstatic|https:|blob:|unsafe-eval|unsafe-inline/);
  });

  it("allows map tiles, markers and logos as images", () => {
    expect(withMaps["img-src"]).toEqual([
      "'self'",
      "data:",
      "blob:",
      "https://*.googleapis.com",
      "https://*.gstatic.com",
      "https://*.google.com",
      "https://*.googleusercontent.com",
    ]);
  });

  it("allows the API requests next to our own origin and Supabase", () => {
    expect(withMaps["connect-src"]).toEqual([
      "'self'",
      "https://abcd.supabase.co",
      "wss://abcd.supabase.co",
      "https://*.googleapis.com",
      "https://*.google.com",
      "https://*.gstatic.com",
      "data:",
      "blob:",
    ]);
  });

  it("allows Google Fonts for the map controls and inline styles as before", () => {
    expect(withMaps["font-src"]).toEqual(["'self'", "https://fonts.gstatic.com"]);
    expect(withMaps["style-src"]).toEqual(["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]);
  });

  it("allows blob: workers next to the service worker", () => {
    expect(withMaps["worker-src"]).toEqual(["'self'", "blob:"]);
  });

  it("allows google.com frames only (instead of 'none')", () => {
    expect(withMaps["frame-src"]).toEqual(["https://*.google.com"]);
    expect(without["frame-src"]).toEqual(["'none'"]);
  });

  it("changes nothing else", () => {
    const changed = Object.keys(GOOGLE_MAPS_CSP_SOURCES).sort();
    expect(changed).toEqual(["connect-src", "font-src", "frame-src", "img-src", "style-src", "worker-src"]);
    for (const name of Object.keys(without).filter((n) => !changed.includes(n))) {
      expect(withMaps[name], name).toEqual(without[name]);
    }
    expect(Object.keys(withMaps).sort()).toEqual(Object.keys(without).sort());
    expect(withMaps["object-src"]).toEqual(["'none'"]);
    expect(withMaps["frame-ancestors"]).toEqual(["'none'"]);
    expect(withMaps["default-src"]).toEqual(["'self'"]);
  });

  it("only uses https hosts and the data:/blob: schemes (no wildcards, no http)", () => {
    for (const sources of Object.values(GOOGLE_MAPS_CSP_SOURCES)) {
      for (const s of sources) expect(s).toMatch(/^(https:\/\/(\*\.)?[a-z0-9.-]+\.(com)|data:|blob:)$/);
    }
  });

  it("is off by default (no key configured → the policy is as tight as before)", () => {
    expect(buildContentSecurityPolicy({ nonce: NONCE })).not.toMatch(/google|gstatic/);
    expect(buildContentSecurityPolicy({ nonce: NONCE, googleMaps: false })).toBe(buildContentSecurityPolicy({ nonce: NONCE }));
  });
});

describe("the meta copy carries the Maps sources too (Android app)", () => {
  const both = buildPageContentSecurityPolicies({ nonce: NONCE, supabaseUrl: SUPABASE, googleMaps: true });

  it("both copies list the same Maps sources", () => {
    const meta = parse(both.meta);
    const header = parse(both.header);
    for (const name of Object.keys(GOOGLE_MAPS_CSP_SOURCES)) expect(meta[name], name).toEqual(header[name]);
    expect(header["frame-ancestors"]).toEqual(["'none'"]);
    expect(meta["frame-ancestors"]).toBeUndefined();
  });

  it("the root layout still emits it for the matching nonce", () => {
    expect(metaPolicyForNonce(both.meta, NONCE)).toBe(both.meta);
  });
});
