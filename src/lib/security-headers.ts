/**
 * Security headers (docs/TESTING.md §2.8). Pure functions, no Next or Node
 * imports, so the same module serves `next.config.ts` (static headers, read at
 * build time), `src/proxy.ts` (per-request CSP with a nonce) and unit tests.
 *
 * Where each header comes from:
 * - Pages (everything the proxy matches): `Content-Security-Policy` with a fresh
 *   nonce per request, set by the proxy. Next.js reads the nonce from the
 *   request's CSP header and stamps it on its own inline and bundle scripts.
 * - Every response (pages, API, static files): the static headers below, set in
 *   `next.config.ts`.
 * - API routes (the proxy skips them): a locked-down static CSP, because they
 *   return JSON and never need to run or embed anything.
 * - Pages again, as `<meta http-equiv="Content-Security-Policy">` in the root layout:
 *   the same policy and nonce minus the directives a meta policy may not carry. The
 *   Android app (Capacitor, remote `server.url`) fetches top-level HTML itself and
 *   drops every response header, so the meta copy is the only CSP it enforces.
 *   Browsers enforce both copies; policies intersect, so the copies must not differ
 *   in anything else (tests/unit/security-headers-meta.test.ts).
 */

export type HeaderEntry = { key: string; value: string };

export type CspOptions = {
  /** Per-request nonce (base64). */
  nonce: string;
  /** `NEXT_PUBLIC_SUPABASE_URL`; its origin (and the matching ws/wss origin) is allowed in connect-src. */
  supabaseUrl?: string;
  /** `next dev`: React needs `eval` for its debugging overlays. Never in production. */
  isDev?: boolean;
  /**
   * Adds `upgrade-insecure-requests`. The proxy turns it on only for production
   * requests that arrived over HTTPS: on plain-http hosts (local `next start`,
   * the e2e server) it would rewrite same-origin asset URLs to https and break the page.
   */
  upgradeInsecureRequests?: boolean;
  /**
   * "header" (default): the `Content-Security-Policy` response header.
   * "meta": the `<meta http-equiv>` copy, without META_UNSUPPORTED_DIRECTIVES.
   */
  delivery?: "header" | "meta";
};

/** Directives a policy delivered by `<meta http-equiv>` must not carry (CSP3: ignored there, with a console warning). */
export const META_UNSUPPORTED_DIRECTIVES = ["frame-ancestors", "report-uri", "sandbox"] as const;

/** Request headers the proxy sets for the render (it overwrites any copy the client sent). */
export const NONCE_REQUEST_HEADER = "x-nonce";
export const CSP_META_REQUEST_HEADER = "x-csp-meta";

const NONCE_PATTERN = /^[A-Za-z0-9+/=_-]+$/;

/** Unpredictable per-request nonce: 128 random bits, base64. Works in Node and edge runtimes. */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** `https://x.supabase.co/rest/v1` → ["https://x.supabase.co", "wss://x.supabase.co"]. Invalid or non-http(s) input → []. */
export function supabaseConnectSources(url: string | undefined): string[] {
  if (!url) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];
  const socket = parsed.protocol === "https:" ? "wss:" : "ws:";
  return [parsed.origin, `${socket}//${parsed.host}`];
}

/**
 * The page CSP. Notes per directive:
 * - script-src: only scripts carrying this request's nonce run; 'strict-dynamic'
 *   lets those load their own chunks. 'self' is ignored by CSP3 browsers (because
 *   of 'strict-dynamic') and is only a fallback for very old ones. No 'unsafe-inline'.
 * - style-src 'unsafe-inline': React `style={…}` attributes, Next.js's injected
 *   styles and Tailwind-driven inline styles (e.g. progress widths) cannot carry
 *   nonces. Inline *styles* cannot execute code; scripts stay nonce-only.
 * - worker-src 'self': the service worker (/sw.js). Without it the browser falls
 *   back to script-src, where 'strict-dynamic' disables 'self' and blocks registration.
 * - manifest-src 'self': /manifest.webmanifest (PWA install).
 * - img-src data: blob:: inline icons and local photo previews.
 * - connect-src: our own origin (server actions, RSC, /api) and Supabase (https + wss for realtime).
 * - frame-ancestors 'none': never embedded (clickjacking); X-Frame-Options DENY mirrors it for old browsers.
 */
export function buildContentSecurityPolicy(options: CspOptions): string {
  const { nonce, supabaseUrl, isDev = false, upgradeInsecureRequests = false, delivery = "header" } = options;
  if (!NONCE_PATTERN.test(nonce)) throw new Error("CSP nonce must be base64");

  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(isDev ? ["'unsafe-eval'"] : [])]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", ...supabaseConnectSources(supabaseUrl)]],
    ["worker-src", ["'self'"]],
    ["manifest-src", ["'self'"]],
    ["frame-src", ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  const unsupported: readonly string[] = delivery === "meta" ? META_UNSUPPORTED_DIRECTIVES : [];
  const parts = directives
    .filter(([name]) => !unsupported.includes(name))
    .map(([name, values]) => `${name} ${values.join(" ")}`);
  if (upgradeInsecureRequests) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

/** Both copies of the page policy from one options object (the proxy's only entry point), so they cannot drift. */
export function buildPageContentSecurityPolicies(options: Omit<CspOptions, "delivery">): { header: string; meta: string } {
  return {
    header: buildContentSecurityPolicy({ ...options, delivery: "header" }),
    meta: buildContentSecurityPolicy({ ...options, delivery: "meta" }),
  };
}

/**
 * The root layout's `<meta>` content, from the request headers the proxy set
 * (CSP_META_REQUEST_HEADER, NONCE_REQUEST_HEADER). Null, so no meta is emitted, unless
 * the policy carries that exact nonce and no meta-invalid directive. A meta policy can
 * only add restrictions to the header one, never lift them.
 */
export function metaPolicyForNonce(policy: string | null, nonce: string | null): string | null {
  if (!policy || !nonce || !NONCE_PATTERN.test(nonce)) return null;
  const names = policy.split(";").map((d) => d.trim().split(/\s+/)[0]?.toLowerCase() ?? "");
  if (names.some((n) => (META_UNSUPPORTED_DIRECTIVES as readonly string[]).includes(n))) return null;
  return policy.includes(`'nonce-${nonce}'`) ? policy : null;
}

/** CSP for API routes: JSON only, nothing to run, load or embed. */
export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** CSP for public/offline.html: one inline <style>, no scripts. */
export const OFFLINE_PAGE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Headers for every response. HSTS only in production builds (it would pin localhost to https in dev). */
export function staticSecurityHeaders({ isProduction }: { isProduction: boolean }): HeaderEntry[] {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    // Legacy twin of frame-ancestors 'none' for browsers without CSP2.
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Geolocation only for our own origin (visit check-ins, route tracking). No camera or microphone yet.
    { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=(), payment=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    ...(isProduction ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] : []),
  ];
}

/** True when the request reached us over HTTPS (directly or via a TLS-terminating proxy such as Vercel). */
export function isHttpsRequest(url: string, forwardedProto: string | null): boolean {
  const proto = forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  return url.startsWith("https:");
}
