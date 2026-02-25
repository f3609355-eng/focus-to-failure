const CACHE_NAME = "ftf-v4.0.6";
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
  // Network-first for HTML (to get updates), cache-first for assets
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then((r) => r || fetch(e.request))
    );
  }
});
