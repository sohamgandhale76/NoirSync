// ─── NoirSync Service Worker ──────────────────────────────────────────────
// Caches the app shell for offline use.
// Audio chunks are NOT cached (they're ephemeral streaming data).

const CACHE_NAME = 'noirsync-shell-v2';

// App shell files to precache
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// ── Install: cache app shell ───────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Precaching app shell');
      return cache.addAll(SHELL_URLS);
    })
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ─────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first for API/sockets, cache-first for shell ────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept cross-origin requests (e.g. Spotify SDK, CDN, Google Fonts, YouTube)
  if (url.origin !== self.location.origin) {
    return; // let browser handle external requests natively
  }

  // Never intercept API, socket.io, or audio chunk requests
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io') ||
    url.pathname.includes('/chunks/')
  ) {
    return; // let browser handle natively
  }

  // For navigation requests: network-first, fall back to cached index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
