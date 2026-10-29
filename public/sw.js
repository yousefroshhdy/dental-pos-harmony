/* Honest OS service worker — app-shell caching only.
 * - Static build assets (/_next/static/*, icons): cache-first (they are content-hashed).
 * - Page navigations: ALWAYS network; offline → /offline.html. Authenticated pages are
 *   never cached: on a shared field device a cached page would show the previous
 *   user's data after sign-out (audit #9). Bumping VERSION deletes old page caches.
 * - API, auth and Supabase traffic: never cached (always network).
 * The offline command queue for field reps arrives in Phase 3 (docs/ARCHITECTURE.md §6);
 * offline reads will use per-user IndexedDB that is wiped on sign-out, not this cache.
 */
const VERSION = "v2";
const STATIC_CACHE = `honest-static-${VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll([OFFLINE_URL, "/icon.svg"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))),
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
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
  }
});
