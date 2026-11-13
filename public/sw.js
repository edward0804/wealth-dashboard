const CACHE_NAME = "wealth-pwa-shell-v8";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/apple-touch-icon.png?v=3",
  "./icons/icon-192.png?v=3",
  "./icons/icon-512.png?v=3"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never intercept local /api/* or external Apps Script API calls
  if (url.pathname.startsWith("/api/") || url.origin !== self.location.origin) return;

  // Network-first with instant cache fallback so updates arrive immediately while offline opens in 0.1s
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("./index.html")))
  );
});
