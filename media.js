// Medya katmanı (ana iş parçacığı): şifreli meta bilgisi, küçük resimler, dosya anahtarları.
// Dosya içeriği media.worker.js içinde parça parça şifrelenip OPFS'e yazılır.
//
//  - Her dosyanın rastgele bir dosya anahtarı (FK) vardır; FK, klasör ana anahtarıyla (MK) sarılıp saklanır.
//  - Ad, tür, boyut, tarih ve parça uzunlukları şifreli meta kaydında durur; küçük resimler de MK ile şifrelenir.
const CH = 4 * 1024 * 1024;
const THUMB = 360;
const te = new TextEncoder();
const td = new TextDecoder();
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
const aadOf = (folder, kind, fid) => te.encode('gizli:v1:' + folder + ':' + kind + ':' + fid);

/* ---------- Çalışan (RPC) ---------- */
let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker('media.worker.js');
  worker.onmessage = e => {
    const d = e.data;
    const p = pending.get(d.id);
    if (!p) return;
    if (d.type === 'prog') { if (p.onProg) p.onProg(d.p); return; }
    pending.delete(d.id);
    if (d.type === 'done') p.res(d.result);
    else { const err = new Error(d.message || 'Bilinmeyen hata'); err.name = d.name || 'Error'; p.rej(err); }
  };
  worker.onerror = e => {
    const err = new Error(e.message || 'Çalışan hatası');
    for (const p of pending.values()) p.rej(err);
    pending.clear();
    worker = null;
  };
  return worker;
}

function rpc(op, payload, onProg) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej, onProg });
    getWorker().postMessage({ id, op, payload });
  });
}

/* ---------- Küçük resim ---------- */
async function drawThumb(source, w, ht) {
  const sc = Math.min(1, THUMB / Math.max(w, ht));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * sc));
  cv.height = Math.max(1, Math.round(ht * sc));
  cv.getContext('2d').drawImage(source, 0, 0, cv.width, cv.height);
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.8));
  if (!blob) throw new Error('küçük resim üretilemedi');
  return blob;
}

async function imageThumb(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth, ht = img.naturalHeight;
    if (!w || !ht) throw new Error('boyut okunamadı');
    return { blob: await drawThumb(img, w, ht), w, h: ht };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function videoThumb(file) {
  const url = URL.createObjectURL(file);
  // iOS Safari, ekranda olmayan (DOM'a eklenmemiş) video öğesini çoğu zaman çözmez; bu yüzden
  // görünmez ama sayfaya bağlı bir öğe kullanıyoruz.
  const v = document.createElement('video');
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('muted', '');
  v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.append(v);
  const waitFor = (names, ms) => new Promise(res => {
    let done = false;
    const fin = ok => { if (done) return; done = true; clearTimeout(t); names.forEach(n => v.removeEventListener(n, h)); res(ok); };
    const h = () => fin(true);
    const t = setTimeout(() => fin(false), ms);
    names.forEach(n => v.addEventListener(n, h));
  });
  try {
    v.src = url;
    v.load();
    const hasFrame = () => v.readyState >= 2 && v.videoWidth > 0;
    // 1) veri yüklenmesini bekle; gelmezse sessiz oynatmayı dene (iOS'ta kareyi çözdürür)
    if (!hasFrame()) await waitFor(['loadeddata', 'canplay'], 4000);
    if (!hasFrame()) {
      try { await v.play(); } catch (_) { /* izin verilmezse devam */ }
      await waitFor(['loadeddata', 'canplay', 'playing', 'timeupdate'], 6000);
      try { v.pause(); } catch (_) { /* yoksay */ }
    }
    if (!v.videoWidth || !v.videoHeight) throw new Error('video çözülemedi');
    // 2) birkaç saniyelik/başlangıç dışı bir kareye git (siyah ilk karelerden kaçınmak için)
    const dur = isFinite(v.duration) ? v.duration : 0;
    const target = dur > 0 ? Math.min(1, dur / 10) : 0;
    if (target > 0.05) {
      try {
        const seeked = waitFor(['seeked'], 3000);
        v.currentTime = target;
        await seeked;
      } catch (_) { /* ilk kare ile devam */ }
    }
    // 3) karenin gerçekten çizildiğinden emin ol
    if (typeof v.requestVideoFrameCallback === 'function') {
      await new Promise(res => { const t = setTimeout(res, 400); v.requestVideoFrameCallback(() => { clearTimeout(t); res(); }); });
    }
    const w = v.videoWidth, ht = v.videoHeight;
    return { blob: await drawThumb(v, w, ht), w, h: ht, dur };
  } finally {
    try { v.pause(); } catch (_) { /* yoksay */ }
    v.removeAttribute('src');
    v.load();
    v.remove();
    URL.revokeObjectURL(url);
  }
}

export let lastThumbError = '';
async function makeThumb(file, kind) {
  try { return kind === 'vid' ? await videoThumb(file) : await imageThumb(file); }
  catch (e) { lastThumbError = (e && e.message) || String(e); return null; } // küçük resim olmazsa ızgarada yer tutucu gösterilir
}

/* ---------- Şifre yardımcıları ---------- */
async function seal(key, aad, bytes) {
  const iv = rnd(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, bytes));
  return { iv, ct };
}
async function unseal(key, aad, iv, ct) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct));
}

/* ---------- Genel API ---------- */
export function createMedia(store) {
  const recId = (folder, fid) => folder + ':' + fid;

  // Bir dosyayı şifreleyip ekler. onProgress(0..1) dosya içeriği yazılırken çağrılır.
  async function add(session, file, onProgress) {
    const folder = session.id;
    const fid = hex(rnd(12));
    const fk = rnd(32);
    const nonce = rnd(8);
    const kind = (file.type || '').startsWith('video/') ? 'vid' : 'img';
    const th = await makeThumb(file, kind);

    const res = await rpc('put', { folder, fid, file, fk: fk.slice(), nonce, ch: CH }, onProgress);
    try {
      const wrap = await seal(session.key, aadOf(folder, 'fk', fid), fk);
      const meta = {
        name: file.name || 'öğe',
        mime: file.type || 'application/octet-stream',
        size: file.size,
        added: Date.now(),
        taken: file.lastModified || Date.now(),
        kind,
        lens: res.lens,
        w: th ? th.w : 0,
        h: th ? th.h : 0,
        dur: th && th.dur ? th.dur : 0
      };
      const sm = await seal(session.key, aadOf(folder, 'meta', fid), te.encode(JSON.stringify(meta)));
      if (th) {
        const st = await seal(session.key, aadOf(folder, 'thumb', fid), new Uint8Array(await th.blob.arrayBuffer()));
        await store.putThumb({ id: recId(folder, fid), iv: st.iv, ct: st.ct });
      }
      await store.putFile({
        id: recId(folder, fid), folder, fid, nonce,
        wrapIv: wrap.iv, wrapped: wrap.ct, metaIv: sm.iv, metaCt: sm.ct
      });
    } catch (e) {
      // kayıt tamamlanamadıysa yarım kalan şifreli dosyayı temizle
      await rpc('del', { folder, fid }).catch(() => {});
      await store.delFile(recId(folder, fid)).catch(() => {});
      throw e;
    } finally {
      fk.fill(0);
    }
    return fid;
  }

  // Klasördeki tüm öğelerin çözülmüş meta bilgisi (yeniden eskiye). Bozuk kayıtlar atlanır.
  async function list(session) {
    const recs = await store.listFiles(session.id);
    const out = [];
    for (const r of recs) {
      try {
        const m = JSON.parse(td.decode(await unseal(session.key, aadOf(r.folder, 'meta', r.fid), r.metaIv, r.metaCt)));
        out.push(Object.assign({ fid: r.fid }, m));
      } catch (_) { /* bozuk/yabancı kayıt */ }
    }
    out.sort((a, b) => (b.taken || b.added) - (a.taken || a.added));
    return out;
  }

  // Şifreli küçük resmi çözüp bir blob: adresi döndürür (çağıran revoke etmeli). Yoksa null.
  async function thumbUrl(session, fid) {
    const rec = await store.getThumb(recId(session.id, fid));
    if (!rec) return null;
    const bytes = await unseal(session.key, aadOf(session.id, 'thumb', fid), rec.iv, rec.ct);
    return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  }

  // Sonradan (ör. izlerken) yakalanan kareyi küçük resim olarak kaydeder.
  async function saveThumb(session, fid, source, w, ht) {
    const blob = await drawThumb(source, w, ht);
    const st = await seal(session.key, aadOf(session.id, 'thumb', fid), new Uint8Array(await blob.arrayBuffer()));
    await store.putThumb({ id: recId(session.id, fid), iv: st.iv, ct: st.ct });
  }

  // Dosyanın tamamını çözüp Blob olarak döndürür.
  async function open(session, item, onProgress) {
    const rec = await store.getFile(recId(session.id, item.fid));
    if (!rec) throw new Error('Kayıt bulunamadı.');
    const fk = await unseal(session.key, aadOf(session.id, 'fk', item.fid), rec.wrapIv, rec.wrapped);
    return rpc('get', {
      folder: session.id, fid: item.fid, fk, nonce: rec.nonce, lens: item.lens, mime: item.mime
    }, onProgress);
  }

  async function remove(session, fids) {
    for (const fid of fids) {
      await rpc('del', { folder: session.id, fid });
      await store.delFile(recId(session.id, fid));
    }
  }

  // Klasör sıfırlanırken çağrılır: tüm şifreli dosyalar ve kayıtlar silinir.
  async function deleteFolder(folder) {
    await rpc('delFolder', { folder });
    await store.deleteFolderFiles(folder);
  }

  return { add, list, thumbUrl, saveThumb, open, remove, deleteFolder };
}
