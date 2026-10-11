// Wisp's service worker caches only the app shell, so the app opens without a
// network and then reconnects. Conversations, settings, and every /api
// response stay out of the cache.

// The build fills these in with its own files and a version that changes with
// them, so each release installs its whole shell before it takes over.
const VERSION = "dev";
const ASSETS = [];

const CACHE = `wisp-shell-${VERSION}`;
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg", "/icons/icon-256.png", "/icons/icon-512.png", ...ASSETS];
// How long opening the app waits for the server before it uses the cached shell.
const NAVIGATION_TIMEOUT_MS = 4_000;
// With no cached shell, how long it waits before saying the server is not answering.
const UNCACHED_NAVIGATION_TIMEOUT_MS = 15_000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") return;
  if (request.mode === "navigate") {
    const network = fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        return caches
          .open(CACHE)
          .then((cache) => cache.put("/", copy))
          .then(() => response);
      }
      return response;
    });
    // A late answer still refreshes the cached shell for the next time.
    event.waitUntil(network.catch(() => undefined));
    event.respondWith(openApp(network));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    // Built assets are named by their content, so a cached copy is always right.
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});

/**
 * The latest app when the server answers quickly; otherwise the cached shell,
 * which shows the app at once and lets it say how connecting goes. A server
 * that accepts the connection but never answers, such as one behind a VPN that
 * is off, would otherwise leave the page blank.
 */
async function openApp(network) {
  const cached = await caches.match("/");
  const timeout = cached ? NAVIGATION_TIMEOUT_MS : UNCACHED_NAVIGATION_TIMEOUT_MS;
  const answer = await Promise.race([network.catch(() => undefined), delay(timeout)]);
  if (answer) return answer;
  return cached ?? unreachablePage();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
}

/** Shown when the server does not answer and no shell is cached yet. */
function unreachablePage() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="color-scheme" content="light dark" />
<title>Wisp</title>
<style>
  html { background: #ffffff; color: #202020; }
  @media (prefers-color-scheme: dark) { html { background: #0a0a0a; color: #ededed; } }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; font: 15px/1.4 system-ui, -apple-system, sans-serif; text-align: center; }
  main { max-width: 22rem; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { margin: 0 0 16px; opacity: 0.75; }
  a { display: inline-block; padding: 8px 16px; border-radius: 8px; border: 1px solid currentColor; color: inherit; text-decoration: none; }
</style>
</head>
<body>
<main role="alert">
  <h1>The Wisp server is not answering</h1>
  <p>Check that this device is online and can reach the server, for example over your VPN or Tailscale.</p>
  <a href="/">Try again</a>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });
}
