/* 台股 Dashboard Service Worker — App Shell 快取，離線可開啟 */
const CACHE = 'twdash-v1';
const SHELL = [
  './',
  './index.html',
  './ipo_patch.js',
  './scoring_patch.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 策略：App Shell 與 CDN 腳本 → 網路優先、失敗回快取（確保更新即時、離線可用）
// API 請求（報價等）不快取，直接走網路
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isShell = url.origin === location.origin;
  const isCDN = /cdnjs\.cloudflare\.com|unpkg\.com/.test(url.host);
  if (!isShell && !isCDN) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: isShell }))
  );
});
