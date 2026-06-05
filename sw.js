// ─── Service Worker ───────────────────────────────────────────────────────────

/**
 * Install event — fires once when the SW is first registered.
 * No caching strategy here; extend this handler to pre-cache assets if needed.
 */
self.addEventListener('install', () => {
  console.log("Service Worker: Installed")
})

/**
 * Fetch event — network-first strategy with a cache fallback.
 * On network failure, attempts to serve the request from the cache.
 * @param {FetchEvent} e
 */
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)))
})