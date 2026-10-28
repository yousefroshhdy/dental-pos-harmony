/* Honest OS service worker — Phase 2: app-shell caching only.
 * - Static build assets (/_next/static/*, icons): cache-first (they are content-hashed).
 * - Page navigations: network-first; offline → last cached copy of that page, else /offline.html.
 * - API, auth and Supabase traffic: never cached (always network).
 * The offline command queue for field reps arrives in Phase 3 (docs/ARCHITECTURE.md §6).
 */
const VERSION = "v1";
const STATIC_CACHE = `honest-static-${VERSION}`;
const PAGE_CACHE = `honest-pages-${VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll([OFFLINE_URL, "/icon.svg"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![STATIC_CACHE, PAGE_CACHE].includes(k)).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase etc.
  if (url.pathname.startsWith("/api/") || url.pathname.includes("/auth/")) return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/icon.svg") {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(request, copy));
            return res;
          }),
      ),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          // Only cache successful, non-redirected pages (never login redirects).
          if (res.ok && !res.redirected) {
            const copy = res.clone();
            caches.open(PAGE_CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match(OFFLINE_URL))),
    );
  }
});
