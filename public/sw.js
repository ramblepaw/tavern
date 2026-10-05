// Network-first service worker: always tries the server so updates show up immediately,
// and falls back to the cached app shell when offline. API calls and uploaded media are never cached here.
const CACHE = 'tavern-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// ---- push notifications
// Every push must show a notification (iOS revokes the subscription otherwise). The server already skips
// sending when you have that chat open, so there is nothing to suppress here.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch {}
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(data.title || 'Tavern', {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        tag: data.chatId ? `chat-${data.chatId}` : 'tavern',
        renotify: true,
        data: { chatId: data.chatId || null, messageId: data.messageId || null },
      });
      try {
        if (typeof data.unread === 'number' && self.navigator.setAppBadge) await self.navigator.setAppBadge(data.unread || undefined);
      } catch {}
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { chatId, messageId } = event.notification.data || {};
  const path = chatId ? `/#/chat/${chatId}${messageId ? `/m/${messageId}` : ''}` : '/#/chats';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((w) => new URL(w.url).origin === location.origin);
      if (win) {
        await win.focus();
        win.postMessage({ type: 'navigate', path: path.slice(2) });
      } else {
        await self.clients.openWindow(path);
      }
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') || url.pathname === '/ws') return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || (request.mode === 'navigate' ? caches.match('/') : Response.error()))),
  );
});
