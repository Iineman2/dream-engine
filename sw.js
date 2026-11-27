// Offline support: serve the app shell from cache, refresh it in the background.
const CACHE = 'dream-engine-v0.4.0';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/audio.js',
  './js/runner.js',
  './js/core/adaptive.js',
  './js/core/analysis.js',
  './js/core/arousal.js',
  './js/core/benefit.js',
  './js/core/compiler.js',
  './js/core/memory.js',
  './js/core/protocol.js',
  './js/core/rng.js',
  './js/core/runtime.js',
  './js/core/safety.js',
  './js/core/schema.js',
  './js/core/scoring.js',
  './js/core/stats.js',
  './js/core/study.js',
  './js/core/text.js',
  './js/core/trials.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const key = req.mode === 'navigate' ? './index.html' : req;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        e.waitUntil(network);
        return cached;
      }
      return (await network) || new Response('Offline', { status: 503 });
    })
  );
});
