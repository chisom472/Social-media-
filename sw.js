/* Digital Enviro service worker: caches the app shell, never caches API or logged-in data. */
const V = 'de-v1', SHELL = ['/', '/css/styles.css', '/js/core.js', '/js/components.js', '/js/app.js', '/logo.svg', '/offline.html'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/socket.io') || u.pathname.startsWith('/uploads/') || u.pathname.startsWith('/admin')) return;
  if (r.mode === 'navigate') { e.respondWith(fetch(r).catch(() => caches.match('/offline.html'))); return; }
  if (/\.(css|js|svg|png|webmanifest)$/.test(u.pathname)) {
    e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); return res; }).catch(() => caches.match(r)));
  }
});
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (x) { d = { title: 'Digital Enviro', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Digital Enviro', { body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { go: d.url || d.go || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close(); const go = (e.notification.data && e.notification.data.go) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.postMessage({ go }); return c.focus(); } }
    return self.clients.openWindow(go);
  }));
});
