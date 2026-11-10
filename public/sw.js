/* Bijoux Debt service worker: browser push for unread book events. */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Bijoux Debt', body: event.data?.text?.() || 'Something changed in the book.' };
  }
  const title = data.title || 'Bijoux Debt';
  const options = {
    body: data.body || '',
    data: { href: data.href || '/', noticeId: data.noticeId || null },
    tag: data.noticeId || data.kind || 'bijouxdebt',
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = event.notification.data?.href || '/';
  const scope = self.registration.scope;
  const target = new URL(`#${href.startsWith('/') ? href : `/${href}`}`, scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) {
          try { await client.navigate(target); } catch { /* hash update below */ }
        }
        client.postMessage({ type: 'bijouxdebt-open', href });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
