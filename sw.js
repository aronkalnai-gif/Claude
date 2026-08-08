/* Service worker: caches the app shell so the icon on your home screen
   opens instantly and still opens with no signal (you'll need a connection
   to look anything up, but you won't get a browser error page).

   Network-first for same-origin requests so a deploy is picked up on the
   next launch rather than being stuck behind a stale cache. API responses
   are deliberately not touched here — net.js runs its own cache with its
   own expiry rules. */

const VERSION = 'odyssey-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/state.js',
  './js/model.js',
  './js/net.js',
  './js/config.js',
  './js/expand.js',
  './js/facts.js',
  './js/graph/layout.js',
  './js/graph/render.js',
  './js/ui/panel.js',
  './js/ui/settings.js',
  './js/sources/musicbrainz.js',
  './js/sources/wikipedia.js',
  './js/sources/lastfm.js',
  './js/sources/discogs.js',
  './js/sources/coverart.js',
  './js/sources/llm.js',
  './js/sources/youtube.js',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      // Don't let one 404 abort the whole install.
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // let the APIs through untouched

  event.respondWith(
    fetch(request)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('./index.html'))),
  );
});
