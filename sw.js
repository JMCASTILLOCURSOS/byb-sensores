/* Service worker: la app funciona sin internet (cache del "app shell"). */
const VERSION = 'byb-norte-v4.2.0';
const ARCHIVOS = [
  './', './index.html', './app.css', './app.js', './link.js', './report.js', './manifest.webmanifest',
  './lib/chart.umd.js', './lib/jspdf.umd.min.js', './lib/jspdf.plugin.autotable.min.js',
  './img/logo.png', './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon.ico'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(ARCHIVOS.map(a => c.add(a).catch(() => {})))));   // NO hace skipWaiting: la app avisa y el usuario decide
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).catch(() => caches.match('./index.html')))
  );
});
