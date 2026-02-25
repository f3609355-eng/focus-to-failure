const CACHE_NAME = "ftf-v4.1.0";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./charts.js",
  "./config.js",
  "./utils.js",
  "./analytics.js",
  "./storage.js",
  "./planner.js",
  "./engine/metricsEngine.js",
  "./engine/blendEngine.js",
  "./engine/floorEngine.js",
  "./engine/goalEngine.js",
  "./engine/waveEngine.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // Network-first for all same-origin requests — prevents stale JS/CSS cache mismatches
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          // Update cache with fresh response
          const clone = r.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
          return r;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(fetch(e.request));
  }
});
