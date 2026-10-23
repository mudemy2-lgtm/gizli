import { createVault, VaultError } from './vault.js';
import { idbStore } from './idb.js';

const VERSION = '0.1.0 · Faz 1';
const vault = createVault(idbStore());
const sessions = new Map(); // klasör no -> { id, key, name } (anahtarlar yalnızca bellekte)
const appEl = document.getElementById('app');
let view = { name: 'home' };
let persisted = null;

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
const DEFAULTS = { bg: 30, idle: 300, kbd: 'num' }; // kbd: parola alanında 'num' sayısal, 'text' normal klavye; // bg: arka planda kaç sn sonra kilit (0 hemen, -1 hiç); idle: boşta kilit sn (0 hiç)
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

function lockAll() {
  sessions.clear();
  closeModal();
  clearTimeout(idleTimer);
  if (view.name === 'folder') view = { name: 'home' };
  render();
}

function bump() {
  clearTimeout(idleTimer);
  if (settings.idle > 0 && sessions.size) idleTimer = setTimeout(lockAll, settings.idle * 1000);
}
['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(ev =>
  addEventListener(ev, bump, { passive: true }));

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
function openModal(title, body, actions) {
  closeModal();
  const box = h('div', { class: 'modal-box' }, h('h3', {}, title), body, h('div', { class: 'row' }, actions));
  modalEl = h('div', { class: 'modal', onclick: e => { if (e.target === modalEl) closeModal(); } }, box);
  document.body.append(modalEl);
  const first = box.querySelector('input');
  if (first) setTimeout(() => first.focus(), 60);
  return box;
}

function applyKb(input) {
  if (settings.kbd === 'num') {
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('pattern', '[0-9]*');
  } else {
    input.setAttribute('inputmode', 'text');
    input.removeAttribute('pattern');
  }
}

function setKb(mode) {
  settings.kbd = mode;
  saveSettings(settings);
  document.querySelectorAll('input[data-pw]').forEach(applyKb);
  document.querySelectorAll('button[data-kb]').forEach(b => { b.textContent = settings.kbd === 'num' ? 'ABC' : '123'; });
}

function pwField(label) {
  const input = h('input', {
    type: 'password', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off',
    spellcheck: 'false', placeholder: label, 'aria-label': label, 'data-pw': '1'
  });
  applyKb(input);
  const kb = h('button', {
    class: 'kb', type: 'button', 'data-kb': '1', 'aria-label': 'Klavye türünü değiştir',
    onclick: () => { setKb(settings.kbd === 'num' ? 'text' : 'num'); input.blur(); input.focus(); }
  }, settings.kbd === 'num' ? 'ABC' : '123');
  const eye = h('button', {
    class: 'eye', type: 'button',
    onclick: () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      eye.textContent = input.type === 'password' ? 'Göster' : 'Gizle';
    }
  }, 'Göster');
  return { input, el: h('div', { class: 'pw' }, input, kb, eye) };
}

// Yalnızca rakamlı parolada engellemeden hafif bir uyarı gösterir.
function digitsHint(input) {
  const p = h('p', { class: 'note' });
  input.addEventListener('input', () => {
    p.textContent = /^\d+$/.test(input.value)
      ? 'Sadece rakamlı parola: ne kadar uzunsa o kadar güvenli (8 veya daha fazla rakam önerilir).'
      : '';
  });
  return p;
}

function explain(e) {
  if (e instanceof VaultError) {
    const wait = e.until ? Math.max(1, Math.ceil((e.until - Date.now()) / 1000)) : 0;
    if (e.code === 'badpass') return 'Yanlış parola.' + (wait ? ' Çok fazla deneme: ' + wait + ' sn bekle.' : '');
    if (e.code === 'locked') return 'Çok fazla yanlış deneme. ' + wait + ' sn sonra tekrar dene.';
    return e.message;
  }
  return 'Hata: ' + (e && e.message ? e.message : e);
}

function enterOnSubmit(inputs, submit) {
  for (const i of inputs) i.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

/* ---------- Diyaloglar ---------- */
function setupDialog(id) {
  const name = h('input', {
    type: 'text', placeholder: 'Klasör adı (isteğe bağlı)', maxlength: '40',
    autocomplete: 'off', autocorrect: 'off'
  });
  const p1 = pwField('Parola (en az 6 karakter)');
  const p2 = pwField('Parolayı tekrar yaz');
  const err = h('p', { class: 'err' });
  const cancel = h('button', { onclick: closeModal }, 'Vazgeç');
  const go = h('button', { class: 'primary' }, 'Klasörü kur');

  async function submit() {
    if (go.disabled) return;
    err.textContent = '';
    if (p1.input.value.length < 6) { err.textContent = 'Parola en az 6 karakter olmalı.'; return; }
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
  openModal('Klasör ' + id + ' kur',
    h('div', {}, name, p1.el, p2.el, digitsHint(p1.input),
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
  openModal('Klasör ' + id + ' kilitli', h('div', {}, pw.el, err, forgot), [cancel, go]);
}

function resetDialog(id) {
  const conf = h('input', { type: 'text', placeholder: 'Onaylamak için SİL yaz', autocomplete: 'off', autocapitalize: 'characters' });
  const err = h('p', { class: 'err' });
  const cancel = h('button', { onclick: closeModal }, 'Vazgeç');
  const go = h('button', { class: 'danger' }, 'Sıfırla ve sil');
  go.addEventListener('click', async () => {
    const v = conf.value.trim().toLocaleUpperCase('tr').replace('İ', 'I');
    if (v !== 'SIL') { err.textContent = 'Onay için SİL yazmalısın.'; return; }
    try {
      await vault.reset(id);
      sessions.delete(id);
      closeModal();
      toast('Klasör ' + id + ' sıfırlandı');
      render();
    } catch (e) { err.textContent = explain(e); }
  });
  openModal('Klasör ' + id + ' sıfırlansın mı?',
    h('div', {},
      h('p', {}, 'Parola kurtarılamaz. Devam edersen bu klasördeki her şey kalıcı olarak silinir ve klasör boş hale gelir.'),
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
  const n1 = pwField('Yeni parola (en az 6 karakter)');
  const n2 = pwField('Yeni parolayı tekrar yaz');
  const err = h('p', { class: 'err' });
  const cancel = h('button', { onclick: closeModal }, 'Vazgeç');
  const go = h('button', { class: 'primary' }, 'Parolayı değiştir');
  async function submit() {
    if (go.disabled) return;
    err.textContent = '';
    if (n1.input.value.length < 6) { err.textContent = 'Yeni parola en az 6 karakter olmalı.'; return; }
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
  openModal('Parolayı değiştir', h('div', {}, old.el, n1.el, n2.el, digitsHint(n1.input), err), [cancel, go]);
}

/* ---------- Ekranlar ---------- */
async function homeView() {
  const slots = await vault.slots();
  const tiles = slots.map(s => {
    const open = sessions.has(s.id);
    const tmp = s.lockUntil > Date.now();
    let ico = '＋', title = 'Klasör ' + s.id, sub = 'Boş · kurmak için dokun';
    if (s.exists) {
      ico = open ? '🔓' : '🔒';
      if (open) { title = sessions.get(s.id).name; sub = 'Açık'; }
      else sub = tmp ? 'Geçici olarak kilitli' : 'Kilitli';
    }
    return h('button', {
      class: 'tile' + (open ? ' open' : '') + (s.exists ? '' : ' empty'),
      onclick: () => {
        if (!s.exists) setupDialog(s.id);
        else if (sessions.has(s.id)) { view = { name: 'folder', id: s.id }; render(); }
        else unlockDialog(s.id);
      }
    }, h('span', { class: 'ico' }, ico), h('span', {}, h('div', { class: 't' }, title), h('div', { class: 'sub' }, sub)));
  });
  return h('div', { class: 'screen' },
    h('div', { class: 'top' }, h('h1', {}, 'Gizli'),
      h('button', { class: 'ghost', 'aria-label': 'Ayarlar', onclick: () => { view = { name: 'settings' }; render(); } }, '⚙︎ Ayarlar')),
    persisted === false
      ? h('div', { class: 'banner' }, 'Kalıcı depolama verilmedi. Verilerin silinme riski var; Ayarlar bölümünden tekrar iste ve yedek al.')
      : null,
    h('div', { class: 'grid' }, tiles),
    sessions.size ? h('button', { class: 'row-btn', onclick: lockAll }, 'Hepsini kilitle') : null);
}

function folderView(id) {
  const s = sessions.get(id);
  return h('div', { class: 'screen' },
    h('div', { class: 'bar' },
      h('button', { class: 'ghost', onclick: () => { view = { name: 'home' }; render(); } }, '‹ Klasörler'),
      h('button', { class: 'ghost', onclick: () => { sessions.delete(id); view = { name: 'home' }; render(); toast('Kilitlendi'); } }, 'Kilitle')),
    h('h1', {}, s.name),
    h('div', { class: 'card' },
      h('p', {}, 'Bu klasör hazır ve şifreli.'),
      h('p', { class: 'note' }, 'Fotoğraf ve video ekleme bir sonraki aşamada (Faz 2) gelecek.')),
    h('div', { class: 'list' },
      h('button', { class: 'row-btn', onclick: () => renameDialog(id) }, 'Klasörün adını değiştir'),
      h('button', { class: 'row-btn', onclick: () => changePwDialog(id) }, 'Parolayı değiştir')));
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

  const kbSel = h('select', { onchange: () => setKb(kbSel.value) },
    h('option', { value: 'num', selected: settings.kbd === 'num' }, 'Sayısal (rakam klavyesi)'),
    h('option', { value: 'text', selected: settings.kbd !== 'num' }, 'Normal (harf ve rakam)'));

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
      sel('idle', [[60, '1 dakika'], [300, '5 dakika'], [900, '15 dakika'], [0, 'Hiçbir zaman']]),
      h('span', { class: 'lbl' }, 'Parola klavyesi'),
      kbSel),
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
  let node;
  try {
    if (view.name === 'folder') node = folderView(view.id);
    else if (view.name === 'settings') node = await settingsView();
    else node = await homeView();
  } catch (e) {
    node = h('div', { class: 'card' }, h('p', {}, 'Bir hata oluştu: ' + (e && e.message ? e.message : e)));
  }
  if (t !== rtoken) return;
  appEl.replaceChildren(node);
}

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
