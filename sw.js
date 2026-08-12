/* Service worker for Study Aid.
 * CACHE version: bump this string (v1 -> v2, ...) whenever any app-shell
 * file (index.html, styles.css, app.js, pwa.js, manifest.json, icons)
 * changes, so clients pick up the new shell.
 */
const CACHE = "study-aid-v1";

// App shell — all paths relative so this works under the /study-aid/ subpath.
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "pwa.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch((err) => {
        // A failed precache shouldn't block install entirely.
        console.warn("[sw] precache failed:", err);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Store a copy of a successful response in the cache. Never let a cache
// failure break the response we hand back to the page.
function safePut(request, response) {
  if (!response || !response.ok) return;
  const copy = response.clone();
  caches
    .open(CACHE)
    .then((cache) => cache.put(request, copy))
    .catch(() => {
      /* cache.put failed (quota, opaque, etc.) — ignore */
    });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // (a) Non-GET requests (e.g. POSTs to the Anthropic API) pass through
  // untouched — do not call respondWith at all.
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // (b) Never intercept the Anthropic API.
  if (url.hostname === "api.anthropic.com") return;

  // (d) cdnjs (pdf.js) → stale-while-revalidate so PDF upload works
  // offline after first use.
  if (url.hostname === "cdnjs.cloudflare.com") {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            safePut(request, response);
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // (c) Same-origin GET → network-first, cache fallback when offline.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          safePut(request, response);
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => {
            if (cached) return cached;
            // Navigations fall back to the cached shell so the app
            // still opens offline.
            if (request.mode === "navigate") {
              return caches.match("./").then((shell) => {
                if (shell) return shell;
                return new Response("Offline", {
                  status: 503,
                  headers: { "Content-Type": "text/plain" }
                });
              });
            }
            return new Response("Offline", {
              status: 503,
              headers: { "Content-Type": "text/plain" }
            });
          })
        )
    );
  }
  // Other cross-origin GETs: let the browser handle them normally.
});
