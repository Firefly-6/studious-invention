const CACHE = 'wb-v3';
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

  // 页面（导航请求）走「网络优先」：保证俄国新闻/中文标题等更新即时生效，不再被 SW 缓存卡住
  const isPage = event.request.mode === 'navigate' ||
                 url.endsWith('/') || url.endsWith('/index.html');
  if (isPage) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
          return resp;
        })
        .catch(() => caches.match(event.request).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  // 其它静态资源（图标、xlsx 库等）走「缓存优先」，便于离线使用
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp && resp.status === 200 && (resp.type === 'basic' || resp.type === 'cors')) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return resp;
      }).catch(() => cached);
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
