// The Worker: what stands between the Storefront and the network once a visitor has been here.
// A Run clears storage first, so this installs fresh on every Run and never serves one. It takes
// no page it did not load (no clients.claim), and steps in front of a waiting Generation only
// when the Notice asks on the visitor's behalf (skipWaiting, in the message handler alone).

// Named for the Generation of the behaviour in the Shell, not for this file: a Rung rebuild
// changes what is kept without changing sw.js, and the two axes stay independent.
const CACHE = 'field-notes-v2';
// The Shell: what the Storefront needs to render with the network gone. `./` is the only request
// this adds to a first visit; the other two are Immutable Assets the HTTP cache already holds.
const SHELL = ['./', './app.v2.min.js', './favicon.ico'];
// An Immutable Asset's filename is its cache key, so it is answered from the cache first and kept
// as it is seen; everything else is asked of the network first and kept as a fallback.
const IMMUTABLE = /\/(?:images|icons)\/|\.min\.js$|\/favicon\.ico$/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  // Pruning only bounds growth: every Shell entry but `./` is a content-addressed immutable URL,
  // so a stale copy under an older cache name is harmless, merely unused.
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(IMMUTABLE.test(url.pathname) ? cacheFirst(request) : networkFirst(request));
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') self.skipWaiting();
  if (type === 'TOP_UP') event.waitUntil(topUp());
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

// Every Rung the visitor has not yet seen, read from the kept document's own markup so the image
// facts stay where they are. Sent by the behaviour only to a page that was already controlled: a
// first-time visitor genuinely is not a returning one, and a Run is always a first visit.
async function topUp() {
  const cache = await caches.open(CACHE);
  const document = await cache.match('./');
  if (!document) return;
  const kept = new Set((await cache.keys()).map((request) => request.url));
  const rungs = new Set((await document.text()).match(/\.\/images\/[\w-]+\.(?:webp|jpg)/g) || []);
  await Promise.all([...rungs]
    .filter((rung) => !kept.has(new URL(rung, self.location.href).href))
    .map((rung) => cache.add(rung).catch(() => {})));
}
