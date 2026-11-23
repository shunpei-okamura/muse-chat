const CACHE = 'muse-chat-v4.4.1';
const SHELL = ['/', '/index.html', '/style.css?v=4.3.2', '/app.js?v=4.4.1', '/manifest.json', '/icon.svg', '/icon.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return; // network only for API
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'Muse対応チャット';
  const options = {
    body: data.body || '',
    icon: '/icon.png',
    badge: '/icon.png',
    tag: data.roomId || undefined, // 同じルームの通知はまとめる
    renotify: !!data.roomId,
    data: { roomId: data.roomId || null },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});
// 通知をタップしたら、そのルームを開く
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const roomId = e.notification.data && e.notification.data.roomId;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) {
          if (roomId) c.postMessage({ type: 'open-room', roomId });
          return c.focus();
        }
      }
      return self.clients.openWindow(roomId ? `/?room=${encodeURIComponent(roomId)}` : '/');
    })
  );
});
