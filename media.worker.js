// Şifreli dosya çalışanı (Web Worker).
// OPFS'e yazma/okuma yalnızca burada yapılır: Safari'de createSyncAccessHandle sadece worker içinde vardır.
// Dosyalar parça parça (varsayılan 4 MB) AES-256-GCM ile şifrelenir; bellekte hiçbir zaman tüm dosya tutulmaz
// (okurken görüntülemek için parçalar çözülüp Blob yapılır).
const ROOT = 'gizli';
const te = new TextEncoder();

async function folderDir(folder, create) {
  const root = await navigator.storage.getDirectory();
  const top = await root.getDirectoryHandle(ROOT, { create: true });
  return top.getDirectoryHandle('f' + folder, { create });
}

function ivFor(nonce, i) {
  const a = new Uint8Array(12);
  a.set(nonce, 0);
  new DataView(a.buffer).setUint32(8, i);
  return a;
}

// Parça sırasını ve toplam parça sayısını bağlar: parça silme/yer değiştirme fark edilir.
const aadFor = (folder, fid, i, n) => te.encode('gizli:v1:file:' + folder + ':' + fid + ':' + i + ':' + n);

const ops = {
  async put(d, prog) {
    const key = await crypto.subtle.importKey('raw', d.fk, 'AES-GCM', false, ['encrypt']);
    d.fk.fill(0);
    const dir = await folderDir(d.folder, true);
    const name = d.fid + '.bin';
    const fh = await dir.getFileHandle(name, { create: true });
    const ah = await fh.createSyncAccessHandle();
    const total = d.file.size;
    const n = Math.max(1, Math.ceil(total / d.ch));
    const lens = [];
    let pos = 0;
    try {
      ah.truncate(0);
      for (let i = 0; i < n; i++) {
        const pt = await d.file.slice(i * d.ch, Math.min((i + 1) * d.ch, total)).arrayBuffer();
        const ct = new Uint8Array(await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: ivFor(d.nonce, i), additionalData: aadFor(d.folder, d.fid, i, n) }, key, pt));
        const w = ah.write(ct, { at: pos });
        if (w !== ct.length) throw new Error('Yazma tamamlanamadı (disk dolu olabilir).');
        lens.push(ct.length);
        pos += ct.length;
        prog((i + 1) / n);
      }
      ah.flush();
      ah.close();
    } catch (e) {
      try { ah.close(); } catch (_) { /* önemsiz */ }
      try { await dir.removeEntry(name); } catch (_) { /* önemsiz */ }
      throw e;
    }
    return { lens };
  },

  async get(d, prog) {
    const key = await crypto.subtle.importKey('raw', d.fk, 'AES-GCM', false, ['decrypt']);
    d.fk.fill(0);
    const dir = await folderDir(d.folder, false);
    const fh = await dir.getFileHandle(d.fid + '.bin');
    const ah = await fh.createSyncAccessHandle();
    const n = d.lens.length;
    const parts = [];
    let pos = 0;
    try {
      for (let i = 0; i < n; i++) {
        const buf = new Uint8Array(d.lens[i]);
        const r = ah.read(buf, { at: pos });
        if (r !== buf.length) throw new Error('Dosya eksik veya bozuk.');
        parts.push(await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: ivFor(d.nonce, i), additionalData: aadFor(d.folder, d.fid, i, n) }, key, buf));
        pos += buf.length;
        prog((i + 1) / n);
      }
    } finally {
      try { ah.close(); } catch (_) { /* önemsiz */ }
    }
    return new Blob(parts, { type: d.mime || 'application/octet-stream' });
  },

  async del(d) {
    try {
      const dir = await folderDir(d.folder, false);
      await dir.removeEntry(d.fid + '.bin');
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
    return true;
  },

  async delFolder(d) {
    const root = await navigator.storage.getDirectory();
    let top;
    try { top = await root.getDirectoryHandle(ROOT); } catch (e) { return true; }
    try { await top.removeEntry('f' + d.folder, { recursive: true }); }
    catch (e) { if (e.name !== 'NotFoundError') throw e; }
    return true;
  }
};

// İşler sırayla yürür: aynı dosyaya aynı anda iki eşzamanlı erişim tutamağı açılamaz.
let queue = Promise.resolve();
onmessage = e => {
  const { id, op, payload } = e.data;
  queue = queue.then(async () => {
    try {
      const result = await ops[op](payload, p => postMessage({ type: 'prog', id, p }));
      postMessage({ type: 'done', id, result });
    } catch (err) {
      postMessage({ type: 'err', id, name: err && err.name, message: err && err.message });
    }
  });
};
