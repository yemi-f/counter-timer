// Bump the version whenever any cached file changes.
const CACHE = 'counter-timer-v9';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'vendor/gridstack/gridstack-all.js',
  'vendor/gridstack/gridstack.min.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/badge-96.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).pathname.startsWith('/api/')) return; // always network
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request))
  );
});

// Sent by the server when a rest reaches its target. Every push must show a
// notification (userVisibleOnly), or browsers may revoke the subscription.
// Pushes use the Declarative Web Push format: Safari 18.4+ shows them without
// running this handler, so it runs on other browsers (and older Safari).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* ignore */ }
  const n = data.notification ?? data; // declarative payload, or a plain { title, body }
  event.waitUntil(
    self.registration.showNotification(n.title || 'Rest over', {
      ...(n.body ? { body: n.body } : {}),
      tag: 'rest',
      renotify: true,
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png', // monochrome: Android uses only its alpha
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => 'focus' in w);
      return open ? open.focus() : self.clients.openWindow('./');
    })
  );
});
