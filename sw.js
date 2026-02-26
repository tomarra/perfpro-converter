'use strict';

const CACHE_NAME = 'perfpro-v1';
const SHARE_FILE_KEY = 'shared-file';

const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './converter.js',
  './styles.css',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
];

// ─── Install: precache static assets ─────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// ─── Activate: clean up old caches ───────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch: intercept share-target POST and serve everything else from cache ──

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Intercept the OS share-target POST before it hits the network
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  // Cache-first for all other requests (enables offline use)
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ─── Share target handler ─────────────────────────────────────────────────────

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (file instanceof File) {
      const arrayBuffer = await file.arrayBuffer();
      const cache = await caches.open(CACHE_NAME);
      // Store file bytes as a Response with metadata headers so app.js can
      // reconstruct a File object with the correct name and type on load.
      await cache.put(
        SHARE_FILE_KEY,
        new Response(arrayBuffer, {
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name),
          },
        })
      );
    }
  } catch (err) {
    console.error('[sw] share-target error:', err);
  }

  // Redirect to the main page regardless of success/failure
  return Response.redirect('./', 303);
}
