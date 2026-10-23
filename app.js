import { createVault, VaultError } from './vault.js';
import { idbStore } from './idb.js';
import { createMedia } from './media.js';

const VERSION = '0.4.0 · 6 haneli parola, klasör yönetimi';
const store = idbStore();
const media = createMedia(store);
const vault = createVault(store, { onReset: id => media.deleteFolder(id) });
const sessions = new Map(); // klasör no -> { id, key, name } (anahtarlar yalnızca bellekte)
const appEl = document.getElementById('app');
let view = { name: 'home' };
let persisted = null;
let thumbUrls = [];
let selecting = false;
const selected = new Set();
let viewerClose = null;
let importCancel = null;
const playing = new Set();

/* ---------- Küçük yardımcılar ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function fmt(b) {
  if (b == null || isNaN(b)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < 4) { b /= 1024; i++; }
  return b.toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
}

let toastEl = null;
function toast(msg) {
  if (toastEl) toastEl.remove();
  toastEl = h('div', { class: 'toast' }, msg);
  document.body.append(toastEl);
  const t = toastEl;
  setTimeout(() => { if (t === toastEl) { t.remove(); toastEl = null; } }, 2400);
}

/* ---------- Ayarlar ---------- */
const SETTINGS_KEY = 'gizli.settings';
// bg: arka planda kaç sn sonra kilit (0 hemen, -1 hiç); idle: hareketsizlikte kilit sn (0 hiç);
// kbd: parola alanında 'num' sayısal, 'text' normal klavye
const DEFAULTS = { bg: 30, idle: 300, kbd: 'num', cols: 3 };
function loadSettings() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
  catch (e) { return Object.assign({}, DEFAULTS); }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* önemsiz */ }
}
const settings = loadSettings();

/* ---------- Kilitleme ---------- */
let idleTimer = null;
let hiddenAt = 0;

function anyPlaying() {
  for (const v of Array.from(playing)) {
    if (!v.isConnected || v.paused || v.ended) playing.delete(v);
  }
  return playing.size > 0;
}

function revokeThumbs() {
  for (const u of thumbUrls) URL.revokeObjectURL(u);
  thumbUrls = [];
}

function lockAll() {
  if (importCancel) importCancel();
  if (viewerClose) viewerClose();
  sessions.clear();
  closeModal();
  clearTimeout(idleTimer);
  revokeThumbs();
  selecting = false;
  selected.clear();
  if (view.name === 'folder') view = { name: 'home' };
  render();
}

function bump() {
  clearTimeout(idleTimer);
  if (settings.idle > 0 && sessions.size) {
    idleTimer = setTimeout(() => {
      // video izlerken veya dosya eklerken hareketsizlik kilidi devreye girmez
      if (anyPlaying() || importCancel) bump(); else lockAll();
    }, settings.idle * 1000);
  }
}
['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(ev =>
  addEventListener(ev, bump, { passive: true }));

document.addEventListener('play', e => {
  if (e.target && e.target.tagName === 'VIDEO') playing.add(e.target);
}, true);
['pause', 'ended', 'emptied'].forEach(ev =>
  document.addEventListener(ev, e => { playing.delete(e.target); }, true));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    document.body.classList.add('cover'); // uygulama değiştiricide içeriği gizlemeye çalışır
    hiddenAt = Date.now();
    if (settings.bg === 0) lockAll();
  } else {
    document.body.classList.remove('cover');
    if (hiddenAt && settings.bg > 0 && (Date.now() - hiddenAt) / 1000 >= settings.bg) lockAll();
    hiddenAt = 0;
  }
});
addEventListener('pagehide', () => { sessions.clear(); });

/* ---------- Modal ---------- */
let modalEl = null;
function closeModal() {
  if (modalEl) { modalEl.remove(); modalEl = null; }
}
function openModal(title, body, actions, opts) {
  closeModal();
  const sticky = !!(opts && opts.sticky);
  const box = h('div', { class: 'modal-box' }, h('h3', {}, title), body, h('div', { class: 'row' }, actions));
  modalEl = h('div', { class: 'modal', onclick: e => { if (!sticky && e.target === modalEl) closeModal(); } }, box);
  document.body.append(modalEl);
  const first = box.querySelector('input');
  if (first) setTimeout(() => first.focus(), 60);
  return box;
}

function applyKb(input) {
  input.setAttribute('inputmode', 'numeric');
  input.setAttribute('pattern', '[0-9]*');
}

const PIN_RE = /^\d{6}$/;
const PIN_HELP = 'Parola tam 6 rakam olmalı.';

function pwField(label, exact) {
  const input = h('input', {
    type: 'password', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off',
    spellcheck: 'false', placeholder: label, 'aria-label': label, 'data-pw': '1'
  });
  if (exact) input.setAttribute('maxlength', '6');
  applyKb(input);
  const eye = h('button', {
    class: 'eye', type: 'button',
    onclick: () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      eye.textContent = input.type === 'password' ? 'Göster' : 'Gizle';
    }
  }, 'Göster');
  return { input, el: h('div', { class: 'pw' }, input, eye) };
}

function explain(e) {
  if (e instanceof VaultError) {
    const wait = e.until ? Math.max(1, Math.ceil((e.until - Date.now()) / 1000)) : 0;
    if (e.code === 'badpass') return 'Yanlış parola.' + (wait ? ' Çok fazla deneme: ' + wait + ' sn bekle.' : '');
    if (e.code === 'locked') return 'Çok fazla yanlış deneme. ' + wait + ' sn sonra tekrar dene.';
    return e.message;
  }
  if (e && e.name === 'QuotaExceededError') return 'Depolama alanı doldu.';
  if (e && e.name === 'OperationError') return 'Dosya çözülemedi (bozuk olabilir).';
  return 'Hata: ' + (e && e.message ? e.message : e);
}

function enterOnSubmit(inputs, submit) {
  for (const i of inputs) i.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

/* ---------- Diyaloglar ---------- */
async function setupDialog() {
  const id = await vault.nextId();
  const name = h('input', {
    type: 'text', placeholder: 'Klasör adı (isteğe bağlı)', maxlength: '40',
    autocomplete: 'off', autocorrect: 'off'
  });
  const p1 = pwField('Parola (6 rakam)', true);
  const p2 = pwField('Parolayı tekrar yaz', true);
  const err = h('p', { class: 'err' });
  const cancel = h('button', { onclick: closeModal }, 'Vazgeç');
  const go = h('button', { class: 'primary' }, 'Klasörü kur');

  async function submit() {
    if (go.disabled) return;
    err.textContent = '';
    if (!PIN_RE.test(p1.input.value)) { err.textContent = PIN_HELP; return; }
    if (p1.input.value !== p2.input.value) { err.textContent = 'Parolalar aynı değil.'; return; }
    go.disabled = true; go.textContent = 'Kuruluyor…';
    try {
      const s = await vault.setup(id, name.value.trim() || 'Klasör ' + id, p1.input.value);
      p1.input.value = ''; p2.input.value = '';
      sessions.set(id, s);
      closeModal();
      view = { name: 'folder', id };
      bump(); render();
    } catch (e) {
      err.textContent = explain(e);
      go.disabled = false; go.textContent = 'Klasörü kur';
    }
  }
  go.addEventListener('click', submit);
  enterOnSubmit([name, p1.input, p2.input], submit);
  openModal('Yeni klasör',
    h('div', {}, name, p1.el, p2.el,
      h('p', { class: 'note' }, 'Parolayı unutursan içeriği kurtarmanın yolu yok. Güvenli bir yere yaz.'), err),
    [cancel, go]);
}

function unlockDialog(id) {
  const pw = pwField('Parola');
  const err = h('p', { class: 'err' });
  const forgot = h('button', { class: 'link', onclick: () => resetDialog(id) }, 'Parolamı unuttum');
  const cancel = h('button', { onclick: closeModal }, 'Vazgeç');
  const go = h('button', { class: 'primary' }, 'Aç');

  async function submit() {
    if (go.disabled) return;
    const val = pw.input.value;
    if (!val) { err.textContent = 'Parolayı gir.'; return; }
    go.disabled = true; go.textContent = 'Açılıyor…'; err.textContent = '';
    try {
      const s = await vault.unlock(id, val);
      pw.input.value = '';
      sessions.set(id, s);
      closeModal();
      view = { name: 'folder', id };
      bump(); render();
      return;
    } catch (e) {
      pw.input.value = '';
      err.textContent = explain(e);
    }
    go.disabled = false; go.textContent = 'Aç';
  }
  go.addEventListener('click', submit);
  enterOnSubmit([pw.input], submit);
  openModal('Klasör kilitli', h('div', {}, pw.el, err, forgot), [cancel, go]);
}

function resetDialog(id) {
  const conf = h('input', { type: 'text', placeholder: 'Onaylamak için SİL yaz', autocomplete: 'off', autocapitalize: 'characters' });
  const err = h('p', { class: 'err' });
  const cancel = h('button', { onclick: closeModal }, 'Vazgeç');
  const go = h('button', { class: 'danger' }, 'Klasörü sil');
  go.addEventListener('click', async () => {
    const v = conf.value.trim().toLocaleUpperCase('tr').replace('İ', 'I');
    if (v !== 'SIL') { err.textContent = 'Onay için SİL yazmalısın.'; return; }
    go.disabled = true; go.textContent = 'Siliniyor…';
    try {
      await vault.reset(id);
      sessions.delete(id);
      closeModal();
      toast('Klasör silindi');
      render();
    } catch (e) {
      err.textContent = explain(e);
      go.disabled = false; go.textContent = 'Klasörü sil';
    }
  });
  openModal('Klasör silinsin mi?',
    h('div', {},
      h('p', {}, 'Parola kurtarılamaz. Devam edersen bu klasör ve içindeki her şey kalıcı olarak silinir.'),
      conf, err),
    [cancel, go]);
}

function renameDialog(id) {
  const s = sessions.get(id);
  const inp = h('input', { type: 'text', value: s.name, maxlength: '40', autocomplete: 'off' });
  const err = h('p', { class: 'err' });
  const cancel = h('button', { onclick: closeModal }, 'Vazgeç');
  const go = h('button', { class: 'primary' }, 'Kaydet');
  async function submit() {
    const v = inp.value.trim();
    if (!v) { err.textContent = 'Ad boş olamaz.'; return; }
    try { await vault.rename(s, v); closeModal(); toast('Ad değişti'); render(); }
    catch (e) { err.textContent = explain(e); }
  }
  go.addEventListener('click', submit);
  enterOnSubmit([inp], submit);
  openModal('Klasörün adı', h('div', {}, inp, err), [cancel, go]);
}

function changePwDialog(id) {
  const old = pwField('Şimdiki parola');
  const n1 = pwField('Yeni parola (6 rakam)', true);
  const n2 = pwField('Yeni parolayı tekrar yaz', true);
  const err = h('p', { class: 'err' });
  const cancel = h('button', { onclick: closeModal }, 'Vazgeç');
  const go = h('button', { class: 'primary' }, 'Parolayı değiştir');
  async function submit() {
    if (go.disabled) return;
    err.textContent = '';
    if (!PIN_RE.test(n1.input.value)) { err.textContent = PIN_HELP; return; }
    if (n1.input.value !== n2.input.value) { err.textContent = 'Yeni parolalar aynı değil.'; return; }
    go.disabled = true; go.textContent = 'Değiştiriliyor…';
    try {
      await vault.changePassword(id, old.input.value, n1.input.value);
      old.input.value = ''; n1.input.value = ''; n2.input.value = '';
      closeModal();
      toast('Parola değişti');
      return;
    } catch (e) { err.textContent = explain(e); }
    go.disabled = false; go.textContent = 'Parolayı değiştir';
  }
  go.addEventListener('click', submit);
  enterOnSubmit([old.input, n1.input, n2.input], submit);
  openModal('Parolayı değiştir', h('div', {}, old.el, n1.el, n2.el, err), [cancel, go]);
}

function deleteFolderDialog(id) {
  const s = sessions.get(id);
  const pw = pwField('Parola');
  const err = h('p', { class: 'err' });
  const cancel = h('button', { onclick: closeModal }, 'Vazgeç');
  const go = h('button', { class: 'danger' }, 'Klasörü sil');
  async function submit() {
    if (go.disabled) return;
    if (!pw.input.value) { err.textContent = 'Parolayı gir.'; return; }
    go.disabled = true; go.textContent = 'Siliniyor…'; err.textContent = '';
    try {
      await vault.remove(id, pw.input.value);
      pw.input.value = '';
      sessions.delete(id);
      closeModal();
      view = { name: 'home' };
      toast('Klasör silindi');
      render();
      return;
    } catch (e) { pw.input.value = ''; err.textContent = explain(e); }
    go.disabled = false; go.textContent = 'Klasörü sil';
  }
  go.addEventListener('click', submit);
  enterOnSubmit([pw.input], submit);
  openModal('“' + s.name + '” silinsin mi?',
    h('div', {}, h('p', {}, 'Klasör ve içindeki tüm fotoğraf ve videolar kalıcı olarak silinir. Bu geri alınamaz. Onaylamak için parolayı yaz.'), pw.el, err),
    [cancel, go]);
}

function folderOptions(id) {
  openModal('Klasör seçenekleri',
    h('div', { class: 'list' },
      h('button', { class: 'row-btn', onclick: () => renameDialog(id) }, 'Klasörün adını değiştir'),
      h('button', { class: 'row-btn', onclick: () => changePwDialog(id) }, 'Parolayı değiştir'),
      h('button', { class: 'row-btn danger', onclick: () => deleteFolderDialog(id) }, 'Klasörü sil')),
    [h('button', { onclick: closeModal }, 'Kapat')]);
}

function confirmDelete(id, fids, done) {
  const s = sessions.get(id);
  const err = h('p', { class: 'err' });
  const cancel = h('button', { onclick: closeModal }, 'Vazgeç');
  const del = h('button', { class: 'danger' }, 'Sil');
  del.addEventListener('click', async () => {
    del.disabled = true; del.textContent = 'Siliniyor…';
    try {
      await media.remove(s, fids);
      closeModal();
      toast(fids.length + ' öğe silindi');
      done();
    } catch (e) {
      err.textContent = explain(e);
      del.disabled = false; del.textContent = 'Sil';
    }
  });
  openModal('Silinsin mi?',
    h('div', {}, h('p', {}, fids.length + ' öğe kalıcı olarak silinecek. Bu geri alınamaz.'), err),
    [cancel, del]);
}

function showErrors(errors) {
  const ok = h('button', { class: 'primary', onclick: closeModal }, 'Tamam');
  openModal('Bazı öğeler eklenemedi',
    h('div', {},
      errors.slice(0, 6).map(e => h('p', { class: 'note' }, e)),
      errors.length > 6 ? h('p', { class: 'note' }, '… ve ' + (errors.length - 6) + ' tane daha') : null),
    [ok]);
}

/* ---------- Dosya ekleme ---------- */
async function importFiles(id, files) {
  const s = sessions.get(id);
  if (!s) return;
  let cancel = false;
  importCancel = () => { cancel = true; };
  const bar = h('progress', { max: '1', value: '0' });
  const label = h('p', {}, '');
  const stop = h('button', {
    onclick: () => { cancel = true; stop.disabled = true; stop.textContent = 'Durduruluyor…'; }
  }, 'Durdur');
  openModal('Ekleniyor', h('div', {}, label, bar,
    h('p', { class: 'note' }, 'İşlem bitene kadar uygulamadan çıkma.')), [stop], { sticky: true });
  let wake = null;
  try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { /* önemsiz */ }

  let ok = 0;
  const errors = [];
  for (let i = 0; i < files.length && !cancel; i++) {
    const f = files[i];
    label.textContent = (i + 1) + ' / ' + files.length + ' · ' + (f.name || 'öğe');
    try {
      await media.add(s, f, p => { bar.value = (i + p) / files.length; bump(); });
      ok++;
    } catch (e) {
      errors.push((f.name || 'öğe') + ': ' + explain(e));
      if (e && e.name === 'QuotaExceededError') break;
    }
    bar.value = (i + 1) / files.length;
  }
  importCancel = null;
  try { if (wake) wake.release(); } catch (e) { /* önemsiz */ }
  closeModal();
  if (sessions.has(id)) {
    toast(ok + ' öğe eklendi' + (cancel ? ' (durduruldu)' : ''));
    if (errors.length) showErrors(errors);
    render();
  }
}

/* ---------- Simgeler ---------- */
const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 017.5-1.9"/>',
  more: '<circle class="f" cx="5.5" cy="12" r="1.6"/><circle class="f" cx="12" cy="12" r="1.6"/><circle class="f" cx="18.5" cy="12" r="1.6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="3"/>',
  play: '<path class="f" d="M8 5.5v13l11-6.5z"/>',
  photo: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10.5" r="1.6"/><path d="M4 17l5-4.5 3.5 3L15 13l5 4.5"/>',
  folder: '<path d="M3.5 7.5a2 2 0 012-2h3.6l2 2.2h7.4a2 2 0 012 2V17a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/>'
};
function icon(name) {
  const s = document.createElement('span');
  s.className = 'ic';
  s.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  return s;
}
function fmtDur(sec) {
  if (!sec || !isFinite(sec)) return '';
  const t = Math.round(sec);
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}
function fmtDate(ts) {
  const d = new Date(ts);
  return {
    day: d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }),
    time: d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
  };
}

/* ---------- Görüntüleyici ---------- */
function openViewer(id, items, start) {
  const s = sessions.get(id);
  if (!s || viewerClose) return;
  let idx = start;
  let token = 0;
  let curUrl = null;
  let closed = false;
  let needRefresh = false;
  let sc = 1, tx = 0, ty = 0;

  const stage = h('div', { class: 'stage' });
  const bg = h('div', { class: 'vbg' });
  const t1 = h('div', { class: 'vt1' });
  const t2 = h('div', { class: 'vt2' });
  const count = h('span', { class: 'vcount' });
  const top = h('div', { class: 'vtop' },
    h('button', { class: 'glass round', 'aria-label': 'Geri', onclick: () => closeV() }, icon('back')),
    h('div', { class: 'vtitle' }, t1, t2),
    h('span', { class: 'vsp' }));
  const bot = h('div', { class: 'vbot' },
    count,
    h('button', { class: 'glass round', 'aria-label': 'Sil', onclick: () => askDelete() }, icon('trash')));
  const root = h('div', { class: 'viewer' }, bg, stage, top, bot,
    h('button', { class: 'glass vnav l', 'aria-label': 'Önceki', onclick: () => go(-1) }, icon('back')),
    h('button', { class: 'glass vnav r', 'aria-label': 'Sonraki', onclick: () => go(1) }, icon('back')));
  document.body.append(root);

  const cur = () => stage.firstElementChild;
  const isImg = () => { const e = cur(); return !!e && e.tagName === 'IMG'; };
  function applyZoom(anim) {
    const el = cur();
    if (!el || el.tagName !== 'IMG') return;
    el.classList.toggle('snap', !!anim);
    el.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + sc + ')';
  }
  function resetZoom() { sc = 1; tx = 0; ty = 0; applyZoom(false); }
  function clampPan() {
    const el = cur();
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = r.width / sc, ht = r.height / sc; // ölçeksiz boyut
    const mx = Math.max(0, (w * sc - innerWidth) / 2);
    const my = Math.max(0, (ht * sc - innerHeight) / 2);
    tx = Math.max(-mx, Math.min(mx, tx));
    ty = Math.max(-my, Math.min(my, ty));
  }

  function revoke() {
    if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
  }
  function closeV() {
    if (closed) return;
    closed = true;
    token++;
    revoke();
    playing.clear();
    root.remove();
    viewerClose = null;
    if (needRefresh) render();
  }
  viewerClose = closeV;

  async function show(i) {
    const t = ++token;
    idx = i;
    const it = items[i];
    const d = fmtDate(it.taken || it.added);
    t1.textContent = d.day;
    t2.textContent = d.time;
    count.textContent = (i + 1) + ' / ' + items.length;
    root.classList.toggle('isvid', it.kind === 'vid');
    stage.classList.remove('snap');
    stage.style.transform = '';
    bg.style.opacity = '';
    revoke();
    playing.clear();
    sc = 1; tx = 0; ty = 0;
    stage.replaceChildren(h('div', { class: 'msg' }, 'Çözülüyor…'));
    try {
      const blob = await media.open(s, it);
      if (t !== token || closed) return;
      curUrl = URL.createObjectURL(blob);
      const el = it.kind === 'vid'
        ? h('video', { src: curUrl, controls: true, playsinline: true, class: 'fade' })
        : h('img', { src: curUrl, alt: '', draggable: 'false', class: 'fade' });
      if (it.kind === 'vid' && !it.w) {
        // Eklerken küçük resim üretilemediyse, ilk izleme sırasında kareyi yakalayıp kaydet
        const grab = () => {
          if (!el.videoWidth) return;
          media.saveThumb(s, it.fid, el, el.videoWidth, el.videoHeight).then(() => { it.w = el.videoWidth; it.h = el.videoHeight; needRefresh = true; }).catch(() => {});
        };
        el.addEventListener('seeked', grab, { once: true });
        el.addEventListener('loadeddata', () => { try { el.currentTime = Math.min(1, (el.duration || 1) / 10); } catch (_) { grab(); } }, { once: true });
      }
      el.addEventListener('error', () => {
        if (t === token) stage.replaceChildren(h('div', { class: 'msg' }, 'Bu dosya görüntülenemedi (biçimi desteklenmiyor olabilir).'));
      });
      stage.replaceChildren(el);
    } catch (e) {
      if (t !== token || closed) return;
      stage.replaceChildren(h('div', { class: 'msg err' }, 'Açılamadı: ' + explain(e)));
    }
  }

  function go(d) {
    const n = idx + d;
    if (n < 0 || n >= items.length) return;
    show(n);
  }

  function askDelete() {
    const it = items[idx];
    confirmDelete(id, [it.fid], () => {
      items.splice(idx, 1);
      if (!items.length) closeV(); else show(Math.min(idx, items.length - 1));
      render();
    });
  }

  /* --- Dokunma hareketleri: sağa/sola kaydır, aşağı çekip kapat, iki parmakla yakınlaştır, çift dokun --- */
  let mode = null; // 'drag' | 'pan' | 'pinch'
  let axis = null;
  let x0 = 0, y0 = 0, dx = 0, dy = 0, t0 = 0, moved = false;
  let d0 = 1, sc0 = 1, tx0 = 0, ty0 = 0;
  let lastTap = 0, tapTimer = 0;
  const dist = ts => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);

  root.addEventListener('touchstart', e => {
    if (e.target.closest('button')) { mode = null; return; }
    const el = cur();
    const vid = !!el && el.tagName === 'VIDEO';
    if (vid && (e.touches.length > 1 || e.touches[0].clientY > innerHeight - 110)) { mode = null; return; }
    if (e.touches.length === 2 && isImg()) {
      mode = 'pinch'; d0 = dist(e.touches); sc0 = sc; tx0 = tx; ty0 = ty;
      el.classList.remove('snap');
    } else if (e.touches.length === 1) {
      mode = (sc > 1.02 && isImg()) ? 'pan' : 'drag';
      axis = null; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; dy = 0; t0 = Date.now(); moved = false;
      tx0 = tx; ty0 = ty;
      stage.classList.remove('snap');
    } else { mode = null; }
  }, { passive: true });

  root.addEventListener('touchmove', e => {
    if (!mode) return;
    e.preventDefault();
    if (mode === 'pinch' && e.touches.length === 2) {
      sc = Math.max(0.7, Math.min(6, sc0 * dist(e.touches) / d0));
      applyZoom(false);
      return;
    }
    if (e.touches.length !== 1) return;
    dx = e.touches[0].clientX - x0; dy = e.touches[0].clientY - y0;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
    if (mode === 'pan') {
      tx = tx0 + dx; ty = ty0 + dy; applyZoom(false);
    } else if (mode === 'drag') {
      if (!axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (axis === 'h') {
        const edge = (dx > 0 && idx === 0) || (dx < 0 && idx === items.length - 1);
        stage.style.transform = 'translateX(' + (edge ? dx / 3 : dx) + 'px)';
      } else if (axis === 'v' && dy > 0) {
        const k = Math.min(1, dy / 350);
        stage.style.transform = 'translate(' + dx * 0.4 + 'px,' + dy + 'px) scale(' + (1 - k * 0.25) + ')';
        bg.style.opacity = String(1 - k);
        root.classList.add('nochrome');
      }
    }
  }, { passive: false });

  root.addEventListener('touchend', e => {
    if (!mode) return;
    if (mode === 'pinch') {
      if (e.touches.length >= 2) return;
      if (sc < 1.05) { sc = 1; tx = 0; ty = 0; }
      clampPan(); applyZoom(true);
      mode = null;
      return;
    }
    if (mode === 'pan') {
      clampPan(); applyZoom(true);
      if (!moved) tapAt(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      mode = null;
      return;
    }
    // drag
    mode = null;
    stage.classList.add('snap');
    if (axis === 'h' && Math.abs(dx) > innerWidth * 0.18) {
      const d = dx < 0 ? 1 : -1;
      const n = idx + d;
      if (n >= 0 && n < items.length) {
        stage.style.transform = 'translateX(' + (dx < 0 ? -innerWidth : innerWidth) + 'px)';
        setTimeout(() => { if (!closed) show(n); }, 180);
        return;
      }
    }
    if (axis === 'v' && dy > 130) {
      stage.style.transform = 'translateY(' + innerHeight + 'px) scale(.7)';
      bg.style.opacity = '0';
      setTimeout(closeV, 200);
      return;
    }
    stage.style.transform = '';
    bg.style.opacity = '';
    if (axis === 'v') root.classList.remove('nochrome');
    if (!moved && Date.now() - t0 < 350) tapAt(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
  }, { passive: true });
  root.addEventListener('touchcancel', () => {
    mode = null; stage.classList.add('snap'); stage.style.transform = ''; bg.style.opacity = '';
  }, { passive: true });

  function tapAt(x, y) {
    const now = Date.now();
    if (now - lastTap < 300 && isImg()) {
      clearTimeout(tapTimer); lastTap = 0;
      if (sc > 1.05) { sc = 1; tx = 0; ty = 0; }
      else { sc = 2.5; tx = (innerWidth / 2 - x) * 1.5; ty = (innerHeight / 2 - y) * 1.5; clampPan(); }
      applyZoom(true);
      return;
    }
    lastTap = now;
    clearTimeout(tapTimer);
    if (isImg() || !cur() || cur().tagName !== 'VIDEO') {
      tapTimer = setTimeout(() => root.classList.toggle('nochrome'), 260);
    }
  }
  // Masaüstü/test: tıklayınca da çubukları aç-kapat (dokunma yoksa)
  root.addEventListener('click', e => {
    if (e.detail === 0 || 'ontouchstart' in window) return;
    if (e.target.closest('button') || (cur() && cur().tagName === 'VIDEO')) return;
    root.classList.toggle('nochrome');
  });

  show(idx);
}

/* ---------- Ekranlar ---------- */
async function homeView() {
  const slots = await vault.slots();
  const covers = [];
  const tiles = slots.map((s, n) => {
    const open = sessions.has(s.id);
    const tmp = s.lockUntil > Date.now();
    let title = 'Klasör ' + (n + 1), sub;
    const cover = h('div', { class: 'cover' });
    if (open) {
      title = sessions.get(s.id).name; sub = 'Açık';
      cover.append(icon('photo'), h('span', { class: 'glass lk' }, icon('unlock')));
      covers.push([s.id, cover, sub]);
    } else {
      sub = tmp ? 'Geçici olarak kilitli' : 'Kilitli';
      cover.append(icon('lock'));
    }
    return h('button', {
      class: 'tile' + (open ? ' open' : ''),
      onclick: () => {
        if (sessions.has(s.id)) { view = { name: 'folder', id: s.id }; render(); }
        else unlockDialog(s.id);
      }
    }, cover, h('div', { class: 't' }, title), h('div', { class: 'sub' }, sub));
  });
  const addCover = h('div', { class: 'cover' }, icon('plus'));
  tiles.push(h('button', { class: 'tile empty new', 'aria-label': 'Yeni klasör', onclick: () => setupDialog() },
    addCover, h('div', { class: 't' }, 'Yeni klasör'), h('div', { class: 'sub' }, 'Parolayla korunur')));
  const node = h('div', { class: 'screen' },
    h('div', { class: 'top' }, h('h1', {}, 'Gizli'),
      h('button', { class: 'glass round', 'aria-label': 'Ayarlar', onclick: () => { view = { name: 'settings' }; render(); } }, icon('gear'))),
    persisted === false
      ? h('div', { class: 'banner' }, 'Kalıcı depolama verilmedi. Verilerin silinme riski var; Ayarlar bölümünden tekrar iste.')
      : null,
    h('div', { class: 'grid' }, tiles),
    sessions.size ? h('button', { class: 'row-btn', onclick: lockAll }, 'Hepsini kilitle') : null);
  // Açık klasörlerde kapak olarak son eklenen öğenin küçük resmi ve öğe sayısı
  const myR = rtoken;
  covers.forEach(([fid, cover]) => {
    const s = sessions.get(fid);
    media.list(s).then(list => {
      if (rtoken !== myR || !s) return;
      const sub = cover.parentNode && cover.parentNode.querySelector('.sub');
      if (sub) sub.textContent = list.length + ' öğe';
      const withThumb = list.find(x => x.w);
      const first = withThumb || list[0];
      if (!first) return;
      return media.thumbUrl(s, first.fid).then(url => {
        if (!url) return;
        if (rtoken !== myR) { URL.revokeObjectURL(url); return; }
        thumbUrls.push(url);
        cover.prepend(h('img', { alt: '', src: url }));
      });
    }).catch(() => { /* kapak olmadan da olur */ });
  });
  return node;
}

async function folderView(id) {
  const s = sessions.get(id);
  const myR = rtoken;
  let items = [];
  let loadErr = '';
  try { items = (await media.list(s)).reverse(); } catch (e) { loadErr = explain(e); } // en yeni en altta
  revokeThumbs();
  const total = items.reduce((a, b) => a + (b.size || 0), 0);
  const COLS = [1, 3, 5];
  let cols = COLS.includes(settings.cols) ? settings.cols : 3;

  const fileInput = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*', style: 'display:none' });
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = '';
    if (files.length) importFiles(id, files);
  });

  const grid = h('div', { class: 'mgrid' });
  const root = h('div', { class: 'photos' + (selecting ? ' selecting' : '') });
  const ctrTitle = h('b', {});
  const ctrSub = h('span', {});
  const delBtn = h('button', { class: 'glass pill danger-pill', disabled: true, 'aria-label': 'Sil' }, icon('trash'), h('span', {}, ''));

  function applyCols() {
    grid.style.setProperty('--cols', String(cols));
    grid.classList.toggle('one', cols === 1);
  }
  function refreshChrome() {
    root.classList.toggle('selecting', selecting);
    if (selecting) {
      ctrTitle.textContent = selected.size ? selected.size + ' öğe seçildi' : 'Öğeleri seç';
      ctrSub.textContent = '';
    } else {
      ctrTitle.textContent = s.name;
      ctrSub.textContent = items.length ? items.length + ' öğe · ' + fmt(total) : 'Boş';
    }
    delBtn.disabled = selected.size === 0;
    delBtn.lastChild.textContent = selected.size ? String(selected.size) : '';
  }
  function setSelecting(on) {
    selecting = on;
    selected.clear();
    grid.querySelectorAll('.m.sel').forEach(t => t.classList.remove('sel'));
    refreshChrome();
  }
  delBtn.addEventListener('click', () => {
    confirmDelete(id, Array.from(selected), () => {
      selected.clear();
      selecting = false;
      render();
    });
  });

  function loadThumb(tile) {
    media.thumbUrl(s, tile.dataset.fid).then(url => {
      if (!url) return;
      if (rtoken !== myR || !tile.isConnected) { URL.revokeObjectURL(url); return; }
      thumbUrls.push(url);
      const img = h('img', { alt: '', src: url, draggable: 'false' });
      tile.querySelector('.ic') && tile.querySelector('.ic').remove();
      tile.prepend(img);
    }).catch(() => { /* yer tutucu kalır */ });
  }
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
      for (const en of entries) {
        if (en.isIntersecting) { io.unobserve(en.target); loadThumb(en.target); }
      }
    }, { rootMargin: '600px' })
    : null;

  let swallow = false;
  items.forEach((it, i) => {
    const tile = h('button', {
      class: 'm' + (selected.has(it.fid) ? ' sel' : ''),
      'data-fid': it.fid,
      'aria-label': it.name
    },
    icon(it.kind === 'vid' ? 'play' : 'photo'),
    it.kind === 'vid' ? h('span', { class: 'badge' }, icon('play'), fmtDur(it.dur)) : null,
    h('span', { class: 'chk' }, icon('check')));
    tile.addEventListener('click', () => {
      if (swallow) { swallow = false; return; }
      if (selecting) {
        if (selected.has(it.fid)) selected.delete(it.fid); else selected.add(it.fid);
        tile.classList.toggle('sel', selected.has(it.fid));
        refreshChrome();
      } else {
        openViewer(id, items, i);
      }
    });
    // Basılı tut: seçme moduna geç
    let lp = 0, lx = 0, ly = 0;
    tile.addEventListener('touchstart', e => {
      lx = e.touches[0].clientX; ly = e.touches[0].clientY;
      lp = setTimeout(() => {
        if (!selecting) { selecting = true; refreshChrome(); }
        if (!selected.has(it.fid)) selected.add(it.fid);
        tile.classList.add('sel');
        refreshChrome();
        swallow = true;
        if (navigator.vibrate) { try { navigator.vibrate(8); } catch (_) { /* yoksay */ } }
      }, 480);
    }, { passive: true });
    const cancelLp = () => clearTimeout(lp);
    tile.addEventListener('touchmove', e => {
      if (Math.abs(e.touches[0].clientX - lx) > 8 || Math.abs(e.touches[0].clientY - ly) > 8) cancelLp();
    }, { passive: true });
    tile.addEventListener('touchend', cancelLp, { passive: true });
    tile.addEventListener('touchcancel', cancelLp, { passive: true });
    tile.addEventListener('contextmenu', e => e.preventDefault());
    grid.append(tile);
    if (io) io.observe(tile); else loadThumb(tile);
  });
  applyCols();

  // İki parmakla sıkıştır: sütun sayısını değiştir (1 – 3 – 5)
  let pd = 0;
  grid.addEventListener('touchstart', e => {
    pd = e.touches.length === 2 ? Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY) : 0;
  }, { passive: true });
  grid.addEventListener('touchmove', e => {
    if (!pd || e.touches.length !== 2) return;
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const k = COLS.indexOf(cols);
    if (d / pd > 1.3 && k > 0) { cols = COLS[k - 1]; pd = d; }
    else if (d / pd < 0.75 && k < COLS.length - 1) { cols = COLS[k + 1]; pd = d; }
    else return;
    settings.cols = cols; saveSettings(settings); applyCols();
  }, { passive: true });

  const emptyCard = h('div', { class: 'empty-lib' }, icon('photo'),
    h('p', {}, 'Bu klasör boş'),
    h('p', { class: 'note' }, 'Aşağıdaki Ekle düğmesiyle fotoğraf veya video seç. Hepsi cihazda şifreli saklanır.'));

  const selBtn = h('button', { class: 'glass pill normal', onclick: () => setSelecting(true) }, 'Seç');
  const cancelBtn = h('button', { class: 'glass pill selmode', style: 'display:none', onclick: () => setSelecting(false) }, 'Bitti');
  const nav = h('div', { class: 'nav' },
    h('button', { class: 'glass round', 'aria-label': 'Klasörler', onclick: () => { view = { name: 'home' }; render(); } }, icon('back')),
    h('div', { class: 'ctr' }, ctrTitle, ctrSub),
    h('div', { class: 'rt' },
      selBtn, cancelBtn,
      h('button', { class: 'glass round normal', 'aria-label': 'Klasör seçenekleri', onclick: () => folderOptions(id) }, icon('more'))));
  const dock = h('div', { class: 'dock' },
    h('button', { class: 'glass pill normal', 'aria-label': 'Ekle', onclick: () => fileInput.click() }, icon('plus'), 'Ekle'),
    h('button', { class: 'glass pill normal', 'aria-label': 'Kilitle', onclick: () => { sessions.delete(id); view = { name: 'home' }; render(); toast('Kilitlendi'); } }, icon('lock'), 'Kilitle'),
    h('span', { class: 'selmode', style: 'display:none' }, delBtn));
  root.append(...[nav, loadErr ? h('p', { class: 'err', style: 'padding:90px 16px 0' }, loadErr) : null,
    items.length ? grid : emptyCard, dock, fileInput].filter(Boolean));
  refreshChrome();
  root.dataset.scrollEnd = items.length ? '1' : '';
  return root;
}

async function settingsView() {
  let est = {};
  try { est = await navigator.storage.estimate(); } catch (e) { /* önemsiz */ }
  try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (e) { /* önemsiz */ }

  const sel = (key, opts) => {
    const s = h('select', {
      onchange: () => { settings[key] = Number(s.value); saveSettings(settings); bump(); }
    }, opts.map(([v, l]) => h('option', { value: String(v), selected: settings[key] === v }, l)));
    return s;
  };

  const persistBtn = h('button', {
    class: 'row-btn',
    onclick: async () => {
      try { persisted = await navigator.storage.persist(); } catch (e) { persisted = false; }
      toast(persisted ? 'Kalıcı depolama verildi' : 'Kalıcı depolama verilmedi');
      render();
    }
  }, 'Kalıcı depolamayı iste');

  return h('div', { class: 'screen' },
    h('div', { class: 'bar' }, h('button', { class: 'ghost', onclick: () => { view = { name: 'home' }; render(); } }, '‹ Geri')),
    h('h1', {}, 'Ayarlar'),
    h('div', { class: 'card' },
      h('span', { class: 'lbl' }, 'Arka plana geçince kilitle'),
      sel('bg', [[0, 'Hemen'], [30, '30 saniye sonra'], [120, '2 dakika sonra'], [-1, 'Kilitleme']]),
      h('span', { class: 'lbl' }, 'Hareketsiz kalınca kilitle'),
      sel('idle', [[60, '1 dakika'], [300, '5 dakika'], [900, '15 dakika'], [0, 'Hiçbir zaman']])),
    h('div', { class: 'card' },
      h('div', { class: 'kv' }, h('span', {}, 'Kalıcı depolama'), h('span', {}, persisted === true ? 'Evet' : persisted === false ? 'Hayır' : '?')),
      h('div', { class: 'kv' }, h('span', {}, 'Kullanım'), h('span', {}, fmt(est.usage))),
      h('div', { class: 'kv' }, h('span', {}, 'Kota'), h('span', {}, fmt(est.quota))),
      persisted === true ? null : persistBtn),
    h('div', { class: 'card' },
      h('div', { class: 'kv' }, h('span', {}, 'Sürüm'), h('span', {}, VERSION))),
    sessions.size ? h('button', { class: 'row-btn', onclick: lockAll }, 'Hepsini şimdi kilitle') : null);
}

/* ---------- Çizim ---------- */
let rtoken = 0;
async function render() {
  const t = ++rtoken;
  if (view.name === 'folder' && !sessions.has(view.id)) view = { name: 'home' };
  if (view.name !== 'folder') { revokeThumbs(); selecting = false; selected.clear(); }
  let node;
  try {
    if (view.name === 'folder') node = await folderView(view.id);
    else if (view.name === 'settings') node = await settingsView();
    else node = await homeView();
  } catch (e) {
    node = h('div', { class: 'card' }, h('p', {}, 'Bir hata oluştu: ' + (e && e.message ? e.message : e)));
  }
  if (t !== rtoken) return;
  const key = view.name + ':' + (view.id || '');
  const y = window.scrollY;
  appEl.replaceChildren(node);
  if (key === lastKey) window.scrollTo(0, y);
  else if (node.dataset && node.dataset.scrollEnd) window.scrollTo(0, document.documentElement.scrollHeight);
  else window.scrollTo(0, 0);
  lastKey = key;
}
let lastKey = '';

async function startPersist() {
  try {
    if (navigator.storage && navigator.storage.persisted) {
      persisted = await navigator.storage.persisted();
      if (!persisted && navigator.storage.persist) persisted = await navigator.storage.persist();
    }
  } catch (e) { /* önemsiz */ }
  if (view.name === 'home') render();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* çevrimdışı önbellek olmadan da çalışır */ });
}
render();
startPersist();
