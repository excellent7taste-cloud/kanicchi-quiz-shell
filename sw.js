const SHELL_CACHE = 'kani-usb-shell-v4';
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
      const cached = await pack.match(event.request);
      if (!cached) return new Response('教材ZIPを読み込んでください。', {status:404, headers:{'Content-Type':'text/plain; charset=utf-8'}});
      const range = event.request.headers.get('Range');
      if (!range || !url.pathname.toLowerCase().endsWith('.mp3')) return cached;
      const media = await cached.blob();
      const size = media.size;
      const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
      const invalid = () => new Response(null, {status:416, headers:{'Content-Range':`bytes */${size}`}});
      if (!match || (!match[1] && !match[2]) || !size) return invalid();
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      const end = match[2] && match[1] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return invalid();
      return new Response(media.slice(start, end + 1), {
        status:206,
        headers:{
          'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
          'Content-Range':`bytes ${start}-${end}/${size}`,
          'Content-Length':String(end - start + 1),
          'Accept-Ranges':'bytes'
        }
      });
    }
    const shell = await caches.open(SHELL_CACHE);
    const cached = await shell.match(event.request, {ignoreSearch:true});
    if (cached) return cached;
    return fetch(event.request);
  })());
});

