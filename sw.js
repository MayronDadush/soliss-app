/* Soliss — service worker.
   מטמון רק ל"מעטפת" (html/css/js/עטיפות). אודיו לעולם לא נשמר — עובר ישר לרשת,
   כדי לא למלא את הטלפון ולא לשבור בקשות Range של הנגן. */

const SHELL_CACHE = 'soliss-shell-7b6cc4302f';
const IMG_CACHE = 'soliss-img-v1';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest',
               './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== SHELL_CACHE && k !== IMG_CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // אודיו: לא נוגעים. הדפדפן מטפל ב-Range בעצמו.
  if (/\.(m4a|mp3|aac|wav|flac|ogg|opus)$/i.test(url.pathname) || req.headers.has('range')) return;

  // הקטלוג: רשת קודם (תמיד הכי עדכני), מטמון כגיבוי כשאין קליטה
  if (url.pathname.endsWith('/data/catalog.json')) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then((res) => { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req))
    );
    return;
  }

  // עטיפות: מטמון קודם — לא משתנות
  if (url.origin === location.origin && url.pathname.includes('/covers/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(IMG_CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  // כל השאר (מעטפת, גופנים): מגישים מהמטמון מיד ומרעננים ברקע
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
