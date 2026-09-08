/* Only the build's public assets are cached. API responses and history never enter CacheStorage. */
const CACHE_NAME = __WISP_CACHE_NAME__;
const ASSETS = __WISP_STATIC_ASSETS__;
const ALLOWED = new Set(ASSETS.map((asset) => new URL(asset, self.location.origin).pathname));
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { credentials: "omit", cache: "reload" })))),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith("wisp-assets-") && key !== CACHE_NAME).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.search ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/health/")
  )
    return;
  if (event.request.mode === "navigate" && ["/", "/index.html"].includes(url.pathname)) {
    event.respondWith(fetch(event.request).catch(async () => (await caches.match("/index.html")) || Response.error()));
  } else if (ALLOWED.has(url.pathname)) {
    event.respondWith(caches.match(event.request).then((response) => response || fetch(event.request)));
  }
});
