import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import {
  API_CONTENT_SECURITY_POLICY,
  OFFLINE_PAGE_CONTENT_SECURITY_POLICY,
  staticSecurityHeaders,
} from "./src/lib/security-headers";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Static security headers for every response. headers() is read at build time,
// so a production build carries HSTS and `next dev` does not. The page
// Content-Security-Policy needs a per-request nonce, so src/proxy.ts sets it.
// Never add a CSP for page routes here: browsers enforce every CSP header they get.
const securityHeaders = staticSecurityHeaders({ isProduction: process.env.NODE_ENV === "production" });

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The proxy skips API routes; they return JSON and need to run or embed nothing.
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: API_CONTENT_SECURITY_POLICY }] },
      // Offline fallback served by the service worker: one inline <style>, no scripts.
      { source: "/offline.html", headers: [{ key: "Content-Security-Policy", value: OFFLINE_PAGE_CONTENT_SECURITY_POLICY }] },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
