/* 台股 Dashboard Service Worker — App Shell 快取，離線可開啟 */
const CACHE = 'twdash-v3';
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

// 策略：
// - CDN 程式庫（Chart.js、Tesseract 固定版本）：有快取直接用，不必每次開 App 都等 CDN
// - App 本身（index.html 等）：網路優先，確保部署的新版馬上生效；但網路太慢時最多等 3 秒，
//   之後先用快取版開起來，網路那份在背景繼續下載寫進快取，下次開就是新版
// - API 請求（報價等）不經過這裡，直接走網路
const SHELL_WAIT_MS = 3000;
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isShell = url.origin === location.origin;
  const isCDN = /cdnjs\.cloudflare\.com|unpkg\.com/.test(url.host);
  if (!isShell && !isCDN) return;

  if (isCDN) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
      }
      return res;
    })));
    return;
  }

  // same-origin app shell 一定要繞過瀏覽器自己的 HTTP 快取，否則「網路優先」
  // 其實還是會從瀏覽器磁碟快取拿到舊版 index.html，造成已經部署的修正看起來沒生效
  const net = fetch(new Request(req, { cache: 'no-store' })).then(res => {
    if (res && res.ok) {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(req, clone));
    }
    return res;
  });
  e.waitUntil(net.then(() => {}, () => {}));
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => {
    if (!hit) return net;
    const slow = new Promise(r => setTimeout(() => r(hit), SHELL_WAIT_MS));
    return Promise.race([net.then(res => (res && res.ok ? res : hit), () => hit), slow]);
  }));
});
