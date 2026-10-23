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
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('zaman aşımı')), 7000);
      v.onloadeddata = () => { clearTimeout(t); res(); };
      v.onerror = () => { clearTimeout(t); rej(new Error('video okunamadı')); };
    });
    try {
      v.currentTime = Math.min(1, (v.duration || 1) / 10);
      await new Promise(res => { v.onseeked = res; setTimeout(res, 2500); });
    } catch (_) { /* ilk kare ile devam */ }
    const w = v.videoWidth, ht = v.videoHeight;
    if (!w || !ht) throw new Error('boyut okunamadı');
    const blob = await drawThumb(v, w, ht);
    v.removeAttribute('src');
    v.load();
    return { blob, w, h: ht };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function makeThumb(file, kind) {
  try { return kind === 'vid' ? await videoThumb(file) : await imageThumb(file); }
  catch (_) { return null; } // küçük resim olmazsa ızgarada yer tutucu gösterilir
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
        h: th ? th.h : 0
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

  return { add, list, thumbUrl, open, remove, deleteFolder };
}
