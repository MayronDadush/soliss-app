/* Soliss — service worker.
   מטמון ל"מעטפת" (html/css/js/עטיפות). אודיו נשמר רק כשהמאזין ביקש להוריד שיר
   להאזנה בלי אינטרנט (AUDIO_CACHE, מנוהל מ-app.js). שיר שלא הורד עובר ישר לרשת. */

const SHELL_CACHE = 'soliss-shell-offline1';
const IMG_CACHE = 'soliss-img-v1';
const AUDIO_CACHE = 'soliss-audio-v1';   // לא תלוי בגרסה — הורדות שורדות עדכונים
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest',
               './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  // cache: 'reload' — בלי זה הדפדפן יכול למלא את המטמון החדש בקובץ הישן מתוך מטמון ה-HTTP
  // (GitHub Pages שומר 10 דקות), והגרסה החדשה לא מגיעה לטלפון.
  e.waitUntil(caches.open(SHELL_CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== SHELL_CACHE && k !== IMG_CACHE && k !== AUDIO_CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

/* ---------- התראות על שיר חדש ---------- */

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* גוף לא תקין */ }
  e.waitUntil(self.registration.showNotification(d.title || 'Soliss', {
    body: d.body || 'עלה שיר חדש',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    // אותו tag = התראה חדשה מחליפה ישנה, במקום לערום חמש הודעות
    tag: d.tag || 'soliss-new',
    data: { url: d.url || './' },
    dir: 'rtl',
    lang: 'he',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || './', self.location.href).href;
  e.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // אם האפליקציה כבר פתוחה — מביאים אותה לחזית ומנווטים בתוכה
    for (const c of tabs) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        if ('navigate' in c) await c.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // אודיו שהורד: האפליקציה מסמנת אותו ב-?dl=1 (כך ההחלטה סינכרונית ולא צריך
  // לבדוק את המטמון על כל שיר). מגישים מהמטמון, כולל Range — בלי זה אי אפשר לדלג בשיר.
  if (url.searchParams.has('dl')) { e.respondWith(offlineAudio(req, url)); return; }

  // אודיו רגיל: לא נוגעים. הדפדפן מטפל ב-Range בעצמו.
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


/* ---------- אודיו מהטלפון ---------- */

const AUDIO_TYPES = { m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac' };

async function offlineAudio(req, url) {
  const key = url.origin + url.pathname;            // המפתח במטמון הוא בלי ה-?dl
  const hit = await (await caches.open(AUDIO_CACHE)).match(key);
  if (!hit) return fetch(key, { headers: req.headers.has('range') ? { range: req.headers.get('range') } : {} });

  const blob = await hit.blob();
  const size = blob.size;
  const type = AUDIO_TYPES[(url.pathname.split('.').pop() || '').toLowerCase()] || blob.type || 'audio/mp4';
  const range = /^bytes=(\d*)-(\d*)$/.exec((req.headers.get('range') || '').trim());
  if (!range) {
    return new Response(blob, { status: 200, headers: {
      'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  }
  let start, end;
  if (range[1] === '') {                            // bytes=-500 → 500 הבתים האחרונים
    start = Math.max(0, size - Number(range[2] || 0));
    end = size - 1;
  } else {
    start = Number(range[1]);
    end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1, type), { status: 206, headers: {
    'Content-Type': type, 'Content-Length': String(end - start + 1),
    'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' } });
}
