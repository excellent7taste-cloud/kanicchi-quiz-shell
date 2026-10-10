const SHELL_CACHE = 'kani-usb-shell-v3';
const PACK_CACHE = 'kani-usb-private-pack-v1';
const APP_PREFIX = new URL('./app/', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE)
    .then(cache => cache.addAll(['./', './index.html', './import.js', './style.css', './manifest.webmanifest', './icon.svg']))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    if (url.href.startsWith(APP_PREFIX)) {
      const pack = await caches.open(PACK_CACHE);
      return await pack.match(event.request) || new Response('教材ZIPを読み込んでください。', {status:404, headers:{'Content-Type':'text/plain; charset=utf-8'}});
    }
    const shell = await caches.open(SHELL_CACHE);
    const cached = await shell.match(event.request, {ignoreSearch:true});
    if (cached) return cached;
    return fetch(event.request);
  })());
});

