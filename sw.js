/* 今天吃什么 · Service Worker
   策略：网络优先、缓存兜底——在线时总是拿最新版本，离线/弱网时用缓存打开。
   发布新版本时把 CACHE 版本号 +1 即可让旧缓存失效。 */
'use strict';

const CACHE = 'what-to-eat-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './meal-random.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })
        .then((cached) => cached || caches.match('./index.html')))
  );
});
