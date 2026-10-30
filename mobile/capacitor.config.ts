import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Honest OS Android shell (D-14 phase 2). A remote-URL WebView: the Next.js app is
 * server-rendered and uses server actions, so it is loaded from its deployment, not
 * bundled. The only native feature is background location during an open shift
 * (@capacitor-community/background-geolocation), driven by the web app's tracking
 * module through window.Capacitor (src/lib/native/).
 *
 * CAP_SERVER_URL is read when `npx cap sync android` runs (CI: the repository variable
 * of the same name). It must be an https URL; the WebView may navigate only to its host
 * (other links open in the phone's browser).
 */

const DEFAULT_SERVER_URL = "https://honest-os-staging.vercel.app";

function serverUrl(): URL {
  const raw = (process.env.CAP_SERVER_URL ?? "").trim() || DEFAULT_SERVER_URL;
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`CAP_SERVER_URL must be https (got ${url.protocol})`);
  return url;
}

const server = serverUrl();

const config: CapacitorConfig = {
  appId: "eg.honest.os",
  appName: "Honest OS",
  webDir: "www",
  server: {
    // The web app redirects / to /ar or /en (Arabic by default).
    url: server.origin,
    androidScheme: "https",
    cleartext: false,
    allowNavigation: [server.host],
    // Shown when the deployment cannot be reached (no network, DNS, TLS): mobile/www.
    errorPath: "offline.html",
  },
  android: {
    // Required by the background-geolocation plugin: with the default WebMessage bridge,
    // location callbacks stop after about 5 minutes in the background (plugin README).
    useLegacyBridge: true,
    allowMixedContent: false,
  },
};

export default config;
