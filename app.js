/* Soliss — אפליקציית האזנה למשפחה ולחברים. Vanilla JS, בלי build. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mmss(sec) {
  if (!sec || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// localStorage נופל בפרטי/תצוגה מקדימה — לעולם לא מפיל את האפליקציה
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z" fill="currentColor"/></svg>';

const audio = $('audio');
const S = {
  songs: [], byId: {}, tracking: '', updated: '',
  filter: 'all', q: '',
  queue: [], qi: -1, shuffle: false, repeat: 'off',
  family: null, current: null, name: '',
  seeking: false, beacon30: false, userScrollUntil: 0,
  heard: 0, heardSent: 0, heardMark: 0,
  lyricLines: [], activeLine: -1,
};

/**
 * לשיר יש שני צירים שונים ובלתי תלויים:
 *   עיבוד  — מקורי / אקוסטי / לייב
 *   גרסה   — האחרונה והישנות יותר, בתוך אותו עיבוד
 * ולכן גם לאקוסטי יכולות להיות כמה גרסאות משלו.
 */
function arrangementsOf(fam) {
  const main = { ...fam };
  delete main.variants;
  main.label = main.label || 'מקורי';
  return [main, ...(fam.variants || [])];
}

/** הגרסאות של עיבוד אחד, מהאחרונה לישנה. הראשונה היא ברירת המחדל. */
function versionsOf(head) {
  const newest = { ...head };
  delete newest.takes;
  newest.label = head.version || 'V1';
  return [newest, ...(head.takes || [])];
}

/** כל ההקלטות של שיר — לחיפוש טראק לפי מזהה. */
function tracksOf(fam) {
  return arrangementsOf(fam).flatMap(versionsOf);
}

/** העיבוד שאליו שייכת ההקלטה שמתנגנת כרגע. */
function arrangementOf(fam, track) {
  return arrangementsOf(fam).find((h) => versionsOf(h).some((v) => v.id === track.id))
    || arrangementsOf(fam)[0];
}

const hasLyrics = (t) => !!(t && t.lyrics && t.lyrics.some((l) => l.text));

// ---------------------------------------------------------------- טעינה

async function loadCatalog() {
  let cat = null;
  try {
    const r = await fetch('data/catalog.json', { cache: 'no-cache' });
    if (r.ok) cat = await r.json();
  } catch { /* offline */ }
  if (!cat) cat = LS.get('catalog_cache');
  if (!cat) {
    $('list').innerHTML = '<div class="empty"><b>אין חיבור</b>נסו שוב כשיש אינטרנט</div>';
    return;
  }
  LS.set('catalog_cache', cat);
  S.songs = cat.songs || [];
  S.byId = Object.fromEntries(S.songs.map((s) => [s.id, s]));
  S.tracking = cat.tracking_url || '';
  S.push = cat.push_url || '';
  S.pushKey = cat.push_key || '';
  S.updated = cat.updated || '';
  render();
  if (!openSharedSong()) restoreLast();
  syncPush();
}

function visible() {
  const q = S.q.trim().toLowerCase();
  return S.songs.filter((s) =>
    (S.filter === 'all' || s.language === S.filter) &&
    (!q || s.title.toLowerCase().includes(q)));
}

// ״חדש״ = שלושת האחרונים שעלו (הקטלוג ממוין מהחדש לישן), ורק אם עלו בחודש
// האחרון. כשהכל מסומן חדש, כלום לא חדש.
const isNew = (s) => S.songs.indexOf(s) < 3 &&
  s.added && (Date.now() - new Date(s.added).getTime()) < 30 * 864e5;

// ---------------------------------------------------------------- רינדור

function render() {
  const list = visible();
  renderHero(list);
  renderList(list);
  const he = S.songs.filter((s) => s.language === 'he').length;
  const en = S.songs.length - he;
  $('foot').textContent = S.songs.length
    ? `${S.songs.length} שירים · ${he} בעברית · ${en} באנגלית`
    : '';
}

function renderHero(list) {
  const hero = $('hero');
  const s = !S.q && list[0];
  if (!s) { hero.innerHTML = ''; return; }
  hero.innerHTML = `
    <button class="hero-card" data-play="${esc(s.id)}" style="--hero:${esc(s.accent)}">
      <img src="${esc(s.cover_sm)}" alt="">
      <div>
        <div class="lab">האחרון שעלה</div>
        <h3 dir="auto">${esc(s.title)}</h3>
        <p>Soliss · ${mmss(s.duration)}${s.synced ? ' · מילים בסנכרון' : ''}</p>
      </div>
      <span class="hero-play">${ICON_PLAY}</span>
    </button>`;
}

/**
 * תגיות בשורת השיר: רק עיבודים (אקוסטי, לייב). גרסאות ישנות לא מוזכרות
 * כאן בכוונה — הן עניין של הנגן, לא של הרשימה.
 */
function rowBadges(s) {
  return (s.variants || []).map((v) => `<span class="badge var">${esc(v.label)}</span>`).join('');
}

function renderList(list) {
  const box = $('list');
  if (!list.length) {
    box.innerHTML = `<div class="empty"><b>לא נמצא</b>${S.q ? 'נסו שם אחר' : 'עוד לא הועלו שירים כאלה'}</div>`;
    return;
  }
  const rest = S.q ? list : list.slice(1);
  box.innerHTML = (rest.length && !S.q ? '<div class="list-title">כל השירים</div>' : '') +
    rest.map((s) => `
    <button class="track ${S.family?.id === s.id ? 'current' : ''}" data-play="${esc(s.id)}">
      <img src="${esc(s.cover_sm)}" alt="" loading="lazy">
      <span class="t-text">
        <span class="t-title" dir="auto">${esc(s.title)}</span>
        <span class="t-meta">
          ${S.family?.id === s.id ? `<span class="eq ${audio.paused ? 'paused' : ''}"><i></i><i></i><i></i></span>` : ''}
          ${isNew(s) ? '<span class="badge">חדש</span>' : ''}
          ${S.filter === 'all' ? `<span>${s.language === 'en' ? 'English' : 'עברית'}</span>` : ''}
          ${rowBadges(s)}
          ${s.synced ? '<span class="badge sync">מילים</span>' : ''}
        </span>
      </span>
      <span class="t-dur">${mmss(s.duration)}</span>
    </button>`).join('');
}

function paintCurrentRow() {
  document.querySelectorAll('.track').forEach((row) => {
    const on = row.dataset.play === S.family?.id;
    row.classList.toggle('current', on);
    const eq = row.querySelector('.eq');
    if (on && !eq) {
      row.querySelector('.t-meta').insertAdjacentHTML('afterbegin',
        `<span class="eq ${audio.paused ? 'paused' : ''}"><i></i><i></i><i></i></span>`);
    } else if (!on && eq) eq.remove();
    else if (eq) eq.classList.toggle('paused', audio.paused);
  });
}

// ---------------------------------------------------------------- נגינה

function buildQueue(startId) {
  const ids = visible().map((s) => s.id);
  if (!ids.includes(startId)) ids.unshift(startId);
  if (S.shuffle) {
    const rest = ids.filter((x) => x !== startId);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    S.queue = [startId, ...rest];
    S.qi = 0;
  } else {
    S.queue = ids;
    S.qi = ids.indexOf(startId);
  }
  $('fullSrc').textContent = S.q ? 'חיפוש' : ({ all: 'כל השירים', he: 'עברית', en: 'English' })[S.filter];
}

function playId(id) {
  const fam = S.byId[id];
  if (!fam) return;
  if (S.family?.id === id) {
    audio.paused ? audio.play().catch(playFailed) : audio.pause();
    return;
  }
  buildQueue(id);
  loadTrack(fam, true);
}

/**
 * טוען שיר לנגן. fam = רשומת השיר מהקטלוג (עם כל הגרסאות שלו).
 * opts.variantId — לנגן גרסה מסוימת · opts.keepPos — להישאר באותה שנייה (מעבר בין גרסאות).
 */
function loadTrack(fam, autoplay, opts = {}) {
  const heads = arrangementsOf(fam);
  // בחירה מפורשת במתג גוברת. זיכרון העיבוד (אקוסטי, לייב) נשמר לשיר —
  // אבל רק העיבוד, אף פעם לא גרסה ישנה בתוכו: ברירת המחדל היא תמיד האחרונה.
  const sticky = LS.get('variant_' + fam.id);
  const wanted = opts.variantId ||
    (heads.some((h) => h.id === sticky) ? sticky : null);
  const t = tracksOf(fam).find((x) => x.id === wanted) || heads[0];
  const sameFamily = S.family?.id === fam.id;
  const pos = opts.keepPos ? audio.currentTime : 0;

  if (S.current && S.current.id !== t.id && !audio.paused) beacon('stop');
  S.family = fam;
  S.current = t;
  S.beacon30 = false;
  S.heard = S.heardSent = S.heardMark = 0;
  S.activeLine = -1;
  audio.src = new URL(t.audio, location.href).href;
  audio.load();
  if (pos > 0) {
    const once = () => { audio.currentTime = Math.min(pos, (audio.duration || pos) - 0.5); audio.removeEventListener('loadedmetadata', once); };
    audio.addEventListener('loadedmetadata', once);
  }
  if (fam.variants?.length) LS.set('variant_' + fam.id, arrangementOf(fam, t).id);

  document.documentElement.style.setProperty('--accent', t.accent || '#7c6ce8');
  $('mini').hidden = false;
  $('miniCover').src = t.cover_sm;
  $('miniTitle').textContent = fam.title;
  $('miniTitle').dir = 'auto';
  $('fullCover').src = t.cover;
  $('fullTitle').textContent = fam.title;
  $('fullTitle').dir = 'auto';
  // הגרסה עצמה מוצגת במתג שמתחת לשורה הזו, אין צורך לחזור עליה כאן
  const head = arrangementOf(fam, t);
  $('fullMeta').textContent = (head.variant ? ` · ${head.label}` : '') +
    ` · ${fam.language === 'en' ? 'English' : 'עברית'}`;
  $('tDur').textContent = mmss(t.duration);
  $('tCur').textContent = '0:00';
  setProgress(0);
  renderVariants(fam, t);
  renderLyrics(t);
  setMediaSession(fam, t);
  paintCurrentRow();
  LS.set('last', { id: fam.id, variantId: t.id, pos: 0 });

  // שיר עם מילים נפתח על המילים — זו התצוגה המעניינת. מעבר בין גרסאות לא מחליף תצוגה.
  // רק מילים מסונכרנות שוות פתיחה אוטומטית — קיר טקסט סטטי הוא רושם ראשון גרוע
  if (!sameFamily) $('full').classList.toggle('show-lyrics', hasLyrics(t) && !!t.synced);

  if (autoplay) audio.play().catch(playFailed);
}

function renderSwitch(box, items, activeId) {
  if (items.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = items.map((t) =>
    `<button data-variant="${esc(t.id)}" class="${t.id === activeId ? 'on' : ''}">${esc(t.label)}</button>`).join('');
}

/**
 * מתג העיבוד ליד הפקדים, ומתג הגרסאות מתחת לשם. הגרסה האחרונה ראשונה —
 * כלומר בצד ימין, שם מתחילים לקרוא, וממנה אחורה V4, V3 וכן הלאה.
 */
function renderVariants(fam, active) {
  const head = arrangementOf(fam, active);
  renderSwitch($('variants'), arrangementsOf(fam), head.id);
  renderSwitch($('takes'), versionsOf(head), active.id);
}

// לחיצה על עיבוד מנגנת תמיד את הגרסה האחרונה שלו; לחיצה על גרסה נשארת בעיבוד.
['variants', 'takes'].forEach((id) => $(id).addEventListener('click', (e) => {
  const b = e.target.closest('[data-variant]');
  if (!b || !S.family || b.dataset.variant === S.current?.id) return;
  loadTrack(S.family, !audio.paused, { variantId: b.dataset.variant, keepPos: true });
}));

function playFailed(err) {
  if (err && err.name === 'NotAllowedError') toast('לחצו על נגן כדי להתחיל');
  else toast('לא הצלחתי לנגן — בדקו חיבור');
}

function next(manual = false) {
  if (!S.queue.length) return;
  if (S.repeat === 'one' && !manual) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  let i = S.qi + 1;
  if (i >= S.queue.length) {
    if (S.repeat === 'all' || manual) i = 0;
    else { audio.pause(); audio.currentTime = 0; setProgress(0); return; }
  }
  S.qi = i;
  loadTrack(S.byId[S.queue[i]], true);
}

function prev() {
  if (audio.currentTime > 3 || !S.queue.length) { audio.currentTime = 0; return; }
  S.qi = (S.qi - 1 + S.queue.length) % S.queue.length;
  loadTrack(S.byId[S.queue[S.qi]], true);
}

function togglePlay() {
  if (!S.current) { const first = visible()[0]; if (first) playId(first.id); return; }
  audio.paused ? audio.play().catch(playFailed) : audio.pause();
}

function setProgress(ratio) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  $('miniFill').style.width = pct + '%';
  if (!S.seeking) {
    $('scrub').value = Math.round(pct * 10);
    $('scrub').style.setProperty('--p', pct + '%');
  }
}

function restoreLast() {
  const last = LS.get('last');
  if (!last || !S.byId[last.id]) return;
  buildQueue(last.id);
  // פתיחה של האפליקציה תמיד חוזרת לגרסה האחרונה. העיבוד (אקוסטי, לייב) כן נשמר,
  // אבל גרסה ישנה שנבחרה פעם אחת לא תישאר ברירת המחדל.
  const isHead = arrangementsOf(S.byId[last.id]).some((h) => h.id === last.variantId);
  if (last.variantId && !isHead) last.variantId = last.pos = null;
  loadTrack(S.byId[last.id], false, { variantId: last.variantId });
  if (last.pos > 5) {
    const once = () => { audio.currentTime = last.pos; audio.removeEventListener('loadedmetadata', once); };
    audio.addEventListener('loadedmetadata', once);
  }
}

// ---------------------------------------------------------------- אירועי אודיו

audio.addEventListener('play', () => {
  setPlayIcons(true);
  paintCurrentRow();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  S.heardMark = Date.now();
  if (S.current && audio.currentTime < 1) beacon('play');
});
audio.addEventListener('pause', () => {
  setPlayIcons(false);
  paintCurrentRow();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  if (S.family) LS.set('last', { id: S.family.id, variantId: S.current?.id, pos: audio.currentTime });
  stopHeardClock();
  if (!audio.ended) beacon('stop');
});
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || S.current?.duration || 0;
  if (d) setProgress(audio.currentTime / d);
  if (!S.seeking) $('tCur').textContent = mmss(audio.currentTime);
  updateLyrics(audio.currentTime);
  if (!S.beacon30 && audio.currentTime >= 30) { S.beacon30 = true; beacon('30s'); }
  if (audio.currentTime >= 15) armPush();
  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && d && isFinite(d)) {
    try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, d) }); } catch { /* ignore */ }
  }
});
audio.addEventListener('loadedmetadata', () => { $('tDur').textContent = mmss(audio.duration); });
audio.addEventListener('ended', () => { stopHeardClock(); beacon('complete'); next(false); });
audio.addEventListener('error', () => { if (S.current) toast('שגיאה בטעינת השיר'); });

function setPlayIcons(playing) {
  const ic = playing ? ICON_PAUSE : ICON_PLAY;
  $('playBtn').innerHTML = ic;
  $('miniPlay').innerHTML = ic;
}

// ---------------------------------------------------------------- מסך נעילה

function setMediaSession(fam, t) {
  if (!('mediaSession' in navigator)) return;
  const abs = (p) => new URL(p, location.href).href;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.variant ? `${fam.title} (${t.label})` : fam.title,
    artist: 'Soliss', album: 'Soliss',
    artwork: [
      { src: abs(t.cover_sm), sizes: '320x320', type: 'image/jpeg' },
      { src: abs(t.cover), sizes: '1024x1024', type: 'image/jpeg' },
    ],
  });
}

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* unsupported */ } };
  set('play', () => audio.play().catch(() => {}));
  set('pause', () => audio.pause());
  set('previoustrack', prev);
  set('nexttrack', () => next(true));
  set('seekto', (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
  set('seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
  set('seekforward', (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); });
  set('stop', () => { audio.pause(); audio.currentTime = 0; });
}

// ---------------------------------------------------------------- מילים

function renderLyrics(s) {
  const box = $('lyrics');
  const lines = s.lyrics || [];
  S.lyricLines = lines;
  box.dir = s.language === 'en' ? 'ltr' : 'rtl';
  if (!lines.length) {
    box.className = 'lyrics static';
    box.innerHTML = '<div class="empty"><b>אין מילים עדיין</b>לשיר הזה עוד לא הועלו מילים</div>';
    return;
  }
  box.className = 'lyrics ' + (s.synced ? 'synced' : 'static');
  box.innerHTML = lines.map((l, i) =>
    l.text
      ? `<div class="line ${l.t != null ? 'seekable' : ''}" data-i="${i}" dir="auto">${esc(l.text)}</div>`
      : '<div class="line gap"></div>'
  ).join('') + (s.synced ? '' : '<p class="lyrics-note">המילים עוד לא מסונכרנות לקצב בשיר הזה</p>');
  box.scrollTop = 0;
}

function updateLyrics(t) {
  if (!S.current?.synced || !S.lyricLines.length) return;
  let idx = -1;
  for (let i = 0; i < S.lyricLines.length; i++) {
    const lt = S.lyricLines[i].t;
    if (lt == null) continue;
    if (lt <= t + 0.12) idx = i; else break;
  }
  if (idx === S.activeLine) return;
  S.activeLine = idx;
  const box = $('lyrics');
  box.querySelectorAll('.line').forEach((n) => {
    const i = +n.dataset.i;
    if (isNaN(i)) return;
    n.classList.toggle('active', i === idx);
    n.classList.toggle('past', i < idx);
  });
  const act = box.querySelector('.line.active');
  if (act && Date.now() > S.userScrollUntil && $('full').classList.contains('show-lyrics')) {
    const top = act.offsetTop - box.clientHeight * 0.42 + act.offsetHeight / 2;
    box.scrollTo({ top, behavior: 'smooth' });
  }
}

$('lyrics').addEventListener('click', (e) => {
  const n = e.target.closest('.line.seekable');
  if (!n) return;
  const l = S.lyricLines[+n.dataset.i];
  if (l && l.t != null) { audio.currentTime = Math.max(0, l.t - 0.1); if (audio.paused) audio.play().catch(() => {}); }
});
['touchstart', 'wheel'].forEach((ev) =>
  $('lyrics').addEventListener(ev, () => { S.userScrollUntil = Date.now() + 4000; }, { passive: true }));

// ---------------------------------------------------------------- מעקב האזנה (מי שומע מה)

/**
 * כמה שניות באמת נשמעו מהשיר הנוכחי. נמדד בשעון ולא לפי המיקום בפס,
 * כדי שדילוג קדימה לא ייחשב כהאזנה ושמיעה חוזרת של אותו קטע כן תיחשב.
 * `heardMark` הוא רגע תחילת המדידה, או 0 כשלא מתנגן — אי אפשר להסתמך על
 * `audio.paused`, כי כשאירוע pause נורה הוא כבר true והשניות היו אובדות.
 */
function heardSoFar() {
  return S.heard + (S.heardMark ? (Date.now() - S.heardMark) / 1000 : 0);
}

function stopHeardClock() {
  S.heard = heardSoFar();
  S.heardMark = 0;
}

function beacon(event) {
  // כל ביקון נושא את השניות שנוספו מאז הביקון הקודם, כך שסכום כל השורות
  // הוא זמן ההאזנה האמיתי — גם אם השיר נקטע באמצע.
  const total = heardSoFar();
  const delta = Math.max(0, Math.round(total - S.heardSent));
  S.heard = total;
  if (S.heardMark) S.heardMark = Date.now();
  if ((event === 'stop' || event === 'tick') && delta < 3) return;  // נגיעה קצרה — לא אירוע
  S.heardSent += delta;

  if (!S.tracking || !S.current) return;
  // ריצה מקומית (בדיקות) לא מדווחת לעולם ליומן האמיתי — גם לא אחרי רענון
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
  const body = JSON.stringify({
    name: S.name || 'אנונימי',
    song_id: S.current.id,
    title: S.current.variant ? `${S.family.title} (${S.current.label})` : S.current.title,
    event,
    position: Math.round(audio.currentTime),
    duration: Math.round(audio.duration || S.current.duration || 0),
    heard: delta,
    ts: new Date().toISOString(),
    standalone: isStandalone(),
    device: /iPhone|iPad/.test(navigator.userAgent) ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'desktop',
  });
  try {
    fetch(S.tracking, { method: 'POST', mode: 'no-cors', keepalive: true,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body }).catch(() => {});
  } catch { /* ignore */ }
}

// סגירת האפליקציה באמצע שיר: pause לא תמיד נורה בטלפון, pagehide כן.
window.addEventListener('pagehide', () => { if (!audio.paused) beacon('stop'); });
// מסך שננעל תוך כדי ניגון — מדווח את השניות עד כאן כדי שלא יאבדו
// אם המערכת תסגור את הלשונית. 'tick' הוא דיווח זמן בלבד, לא עצירה.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && !audio.paused) beacon('tick');
});

// ---------------------------------------------------------------- ממשק

function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('on'), ms);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-play]');
  if (b) playId(b.dataset.play);
});

$('chips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  S.filter = c.dataset.filter;
  document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x === c));
  render();
});

$('searchBtn').onclick = () => {
  const row = $('searchRow');
  row.hidden = !row.hidden;
  if (!row.hidden) $('search').focus();
  else { $('search').value = ''; S.q = ''; render(); }
};
$('search').addEventListener('input', (e) => { S.q = e.target.value; render(); });

$('miniPlay').onclick = (e) => { e.stopPropagation(); togglePlay(); };
$('miniNext').onclick = (e) => { e.stopPropagation(); next(true); };
$('miniOpen').onclick = openFull;
$('miniCover').onclick = openFull;
$('fullClose').onclick = closeFull;
// שיתוף: בטלפון נפתח גיליון השיתוף (וואטסאפ וכו׳); במחשב מעתיק קישור.
$('shareBtn').onclick = async () => {
  if (!S.family) return;
  const url = new URL(location.href);
  url.hash = 'song=' + encodeURIComponent(S.family.id);
  const data = { title: `${S.family.title} · Soliss`, text: `תשמעו את ״${S.family.title}״ של Soliss`, url: url.href };
  if (navigator.share) {
    try { await navigator.share(data); beacon('share'); return; }
    catch (err) { if (err && err.name === 'AbortError') return; /* ביטל — שקט */ }
  }
  // אין גיליון שיתוף (או שנכשל) — מעתיקים קישור, ובדפדפן ישן דרך שדה זמני
  try { await navigator.clipboard.writeText(url.href); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = url.href; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    if (!ok) { toast(url.href, 6000); return; }
  }
  toast('הקישור הועתק');
};
// קישור שנפתח כשהאפליקציה כבר פתוחה (למשל מוואטסאפ ל-PWA מותקן)
addEventListener('hashchange', () => { if (S.songs.length) openSharedSong(); });
// קישור משותף פותח ישר את השיר (בלי לנגן — הדפדפן חוסם ניגון אוטומטי בכל מקרה)
function openSharedSong() {
  const m = location.hash.match(/song=([^&]+)/);
  if (!m) return false;
  const fam = S.byId[decodeURIComponent(m[1])];
  if (!fam) return false;
  buildQueue(fam.id); loadTrack(fam, false); openFull();
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}
$('playBtn').onclick = togglePlay;
$('nextBtn').onclick = () => next(true);
$('prevBtn').onclick = prev;
$('lyricsBtn').onclick = () => {
  $('full').classList.toggle('show-lyrics');
  if ($('full').classList.contains('show-lyrics')) { S.activeLine = -1; updateLyrics(audio.currentTime); }
};
$('shuffleBtn').onclick = () => {
  S.shuffle = !S.shuffle;
  $('shuffleBtn').classList.toggle('on', S.shuffle);
  if (S.family) buildQueue(S.family.id);
  toast(S.shuffle ? 'ערבוב פועל' : 'ערבוב כבוי');
};
$('repeatBtn').onclick = () => {
  S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off';
  $('repeatBtn').classList.toggle('on', S.repeat !== 'off');
  $('repeatBtn').classList.toggle('one-on', S.repeat === 'one');
  toast({ off: 'חזרה כבויה', all: 'חזרה על הכל', one: 'חזרה על השיר' }[S.repeat]);
};

const scrub = $('scrub');
scrub.addEventListener('input', () => {
  S.seeking = true;
  const d = audio.duration || S.current?.duration || 0;
  scrub.style.setProperty('--p', (scrub.value / 10) + '%');
  $('tCur').textContent = mmss(d * scrub.value / 1000);
});
scrub.addEventListener('change', () => {
  const d = audio.duration || S.current?.duration || 0;
  if (d) audio.currentTime = d * scrub.value / 1000;
  S.seeking = false;
});

function openFull() {
  if (!S.current) return;
  $('full').classList.add('open');
  $('full').setAttribute('aria-hidden', 'false');
  history.pushState({ full: true }, '');
}
function closeFull() {
  $('full').classList.remove('open', 'show-lyrics');
  $('full').setAttribute('aria-hidden', 'true');
  if (history.state && history.state.full) history.back();
}
window.addEventListener('popstate', () => {
  if ($('full').classList.contains('open')) { $('full').classList.remove('open', 'show-lyrics'); }
});

// החלקה למטה סוגרת את הנגן המלא
(() => {
  let y0 = null, x0 = null;
  const top = $('full');
  top.addEventListener('touchstart', (e) => {
    if (e.target.closest('.lyrics, #scrub, .ctl-row')) { y0 = null; return; }
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX;
  }, { passive: true });
  top.addEventListener('touchend', (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0, dx = Math.abs(e.changedTouches[0].clientX - x0);
    if (dy > 90 && dx < 80) closeFull();
    y0 = null;
  }, { passive: true });
})();

document.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  if (e.key === 'Escape') closeFull();
  if (e.key === 'ArrowLeft') next(true);
  if (e.key === 'ArrowRight') prev();
});

// ---------------------------------------------------------------- כניסה ראשונה + התקנה

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function setName(name) {
  S.name = name;
  $('greet').textContent = name ? `היי ${name}` : 'היי';
}

function initName() {
  const name = LS.get('listener_name', '');
  if (name) { setName(name); maybeIosHint(); return; }
  $('nameModal').hidden = false;
  setTimeout(() => $('nameInput').focus(), 200);
  $('nameForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('nameInput').value.trim();
    if (!v) return;
    LS.set('listener_name', v);
    setName(v);
    $('nameModal').hidden = true;
    toast(`ברוך הבא, ${v} 🎧`);
    setTimeout(maybeIosHint, 1800);
  };
}

function maybeIosHint() {
  if (!isIOS() || isStandalone()) return;
  // באייפון בלי התקנה אין התראות בכלל, אז ההצעה חוזרת כל כמה כניסות
  // במקום להיעלם לתמיד אחרי סגירה אחת.
  const opens = LS.get('opens', 0) + 1;
  LS.set('opens', opens);
  const snoozed = LS.get('ios_hint_snooze', 0);
  if (opens < snoozed) return;
  $('iosHint').hidden = false;
  const done = () => { $('iosHint').hidden = true; LS.set('ios_hint_snooze', opens + 4); };
  $('iosOk').onclick = done;
  $('iosClose').onclick = done;
}

// ---------------------------------------------------------------- התראות

/**
 * התראות על שיר חדש — דלוקות כברירת מחדל.
 *
 * אין דרך לעקוף את אישור המערכת: הדפדפן דורש שהמשתמש ילחץ "אשר" בחלון
 * שלו, ובאייפון גם דורש שהבקשה תצא מתוך נגיעה במסך. לכן אין כאן מסך
 * הסכמה משלנו — פשוט מבקשים ברגע הראשון שנוגעים בנגן, וזהו.
 *
 * באייפון זה עובד רק כשהאפליקציה מותקנת במסך הבית (iOS 16.4+);
 * בספארי רגיל PushManager בכלל לא קיים ואנחנו יוצאים בשקט.
 */
const pushReady = () =>
  S.push && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function subscribePush() {
  if (!pushReady() || !S.pushKey) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8(S.pushKey),
      });
    // נרשמים מחדש פעם בשבוע: כתובות push פגות, והשם אולי השתנה
    await fetch(S.push, {
      method: 'POST', mode: 'no-cors', keepalive: true,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({
        subscription: sub.toJSON(),
        name: S.name || 'אנונימי',
        device: isIOS() ? 'ios' : 'android',
      }),
    });
    LS.set('push_at', Date.now());
    return true;
  } catch { return false; }
}

/** רישום שקט בעליית האפליקציה — רק אם כבר אישרו פעם. */
function syncPush() {
  if (!pushReady() || Notification.permission !== 'granted') return;
  if (Date.now() - (LS.get('push_at', 0) || 0) < 7 * 864e5) return;
  subscribePush();
}

/**
 * מחכה לנגיעה הבאה ואז מבקש. בכוונה לא מבקשים באותה נגיעה שמפעילה את
 * השיר — חלון האישור היה קופץ על הפנים בשנייה הראשונה של ההאזנה.
 */
let pushArmed = false;
function armPush() {
  if (pushArmed || !pushReady() || Notification.permission !== 'default') return;
  if (isIOS() && !isStandalone()) return;
  pushArmed = true;
  addEventListener('pointerdown', askPush, { once: true, passive: true });
}

/** הבקשה עצמה — חייבת לצאת מתוך נגיעה של המשתמש. */
let pushAsked = false;
async function askPush() {
  if (pushAsked || !pushReady()) return;
  pushAsked = true;
  if (Notification.permission === 'granted') return subscribePush();
  if (Notification.permission === 'denied') return;          // נחסם — לא מציקים
  if (isIOS() && !isStandalone()) return;                    // בלי התקנה אין טעם
  try {
    if (await Notification.requestPermission() === 'granted') {
      await subscribePush();
      toast('נעדכן אותך כששיר חדש עולה 🔔', 4000);
    }
  } catch { /* דפדפן ישן */ }
}

let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('installBtn').hidden = false;
});
$('installBtn').onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  const { outcome } = await installEvt.userChoice;
  if (outcome === 'accepted') { $('installBtn').hidden = true; toast('Soliss הותקן 🎉'); }
  installEvt = null;
};
window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; });

// ---------------------------------------------------------------- service worker

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            const t = $('toast');
            toast('יש גרסה חדשה — לחצו לרענון', 8000);
            t.onclick = () => location.reload();
          }
        });
      });
    }).catch(() => {});
  });
}

// ---------------------------------------------------------------- רענון

/**
 * מושך קטלוג טרי ומצייר מחדש — בלי לגעת בנגן.
 * בכוונה לא קורא ל-restoreLast, שהיה קוטע שיר שמתנגן עכשיו.
 * מחזיר true אם הגיע קטלוג חדש, false אם אין שינוי, null אם אין רשת.
 */
async function refreshCatalog() {
  let cat = null;
  try {
    const r = await fetch('data/catalog.json', { cache: 'no-store' });
    if (r.ok) cat = await r.json();
  } catch { /* אין רשת */ }
  if (!cat || !Array.isArray(cat.songs)) return null;

  const changed = (cat.updated || '') !== S.updated;
  LS.set('catalog_cache', cat);
  S.songs = cat.songs;
  S.push = cat.push_url || S.push;
  S.pushKey = cat.push_key || S.pushKey;
  S.byId = Object.fromEntries(S.songs.map((s) => [s.id, s]));
  S.tracking = cat.tracking_url || '';
  S.updated = cat.updated || '';
  render();
  paintCurrentRow();
  return changed;
}

/* משיכה למטה בראש הרשימה = רענון. */
(() => {
  const ptr = $('ptr');
  const TRIG = 62;        // כמה פיקסלים צריך למשוך כדי להפעיל
  const MAX = 96;         // מעבר לזה האצבע כבר לא מזיזה את הסמל
  let y0 = 0, pulling = false, dist = 0, busy = false;

  const setP = (p) => ptr.style.setProperty('--p', Math.min(1, p).toFixed(3));

  const reset = () => {
    ptr.classList.add('snap');
    ptr.classList.remove('ready');
    setP(0);
    dist = 0;
    pulling = false;
  };

  // בנגן המלא יש גלילה משלו, ובזמן חיפוש המשיכה הייתה מפריעה
  const blocked = () => busy || $('full').classList.contains('open');

  addEventListener('touchstart', (e) => {
    if (blocked() || e.touches.length !== 1 || window.scrollY > 0) return;
    y0 = e.touches[0].clientY;
    pulling = true;
    dist = 0;
    ptr.classList.remove('snap');   // בזמן משיכה הסמל צמוד לאצבע
  }, { passive: true });

  addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - y0;
    // גלילה רגילה כלפי מעלה, או שהדף כבר זז — לא המקרה שלנו
    if (dy <= 0 || window.scrollY > 0) { if (!dist) pulling = false; return; }
    dist = Math.min(MAX, dy * 0.5);   // התנגדות, כמו גומי
    setP(dist / TRIG);
    ptr.classList.toggle('ready', dist >= TRIG);
    e.preventDefault();               // מונע מהדף לזוז יחד עם האצבע
  }, { passive: false });

  const release = async () => {
    if (!pulling) return;
    if (dist < TRIG) return reset();

    pulling = false;
    busy = true;
    ptr.classList.add('snap', 'busy');
    ptr.classList.remove('ready');

    const t0 = Date.now();
    const changed = await refreshCatalog();
    // חצי שנייה מינימום — רענון מיידי מדי נראה כאילו כלום לא קרה
    await new Promise((r) => setTimeout(r, Math.max(0, 450 - (Date.now() - t0))));

    ptr.classList.remove('busy');
    reset();
    busy = false;
    toast(changed === null ? 'אין חיבור' : changed ? 'יש שירים חדשים' : 'הכל מעודכן');
  };

  addEventListener('touchend', release, { passive: true });
  addEventListener('touchcancel', reset, { passive: true });
})();

// חזרה לאפליקציה אחרי שהייתה ברקע — בדיקה שקטה אם יש משהו חדש
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.updated) refreshCatalog();
});

// ---------------------------------------------------------------- התחלה

setPlayIcons(false);
initName();
loadCatalog();
