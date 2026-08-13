const CACHE = 'wb-v2';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        // 运行时缓存 xlsx 库，便于首次联网加载后离线导入 Excel
        if (url.includes('xlsx') && resp && resp.status === 200 && (resp.type === 'basic' || resp.type === 'cors')) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return resp;
      }).catch(() => caches.match('./index.html'));
    })
  );
});

// 接收来自页面的 23:30 睡觉提醒消息
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SLEEP_REMINDER') {
    self.registration.showNotification('🌙 睡觉提醒', {
      body: '已经 23:30 啦，该睡觉了，明天才能继续打卡赚券～',
      icon: 'icon.svg',
      badge: 'icon.svg',
    });
  }
});
