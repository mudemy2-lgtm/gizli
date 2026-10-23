// IndexedDB saklama katmanı.
//  folders: klasör kayıtları (şifreli anahtar, tuz, vb.)
//  files:   dosya kayıtları (şifreli meta bilgisi, sarılmış dosya anahtarı)
//  thumbs:  şifreli küçük resimler
const DB_NAME = 'gizli';
const DB_VER = 2;

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) {
        const s = db.createObjectStore('files', { keyPath: 'id' });
        s.createIndex('folder', 'folder');
      }
      if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('Veritabanı güncellenemedi: uygulamanın diğer açık pencerelerini kapat.'));
  });
}

export function idbStore() {
  let dbp = null;
  const db = () => dbp || (dbp = open());
  const run = (stores, mode, fn) => db().then(d => new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    const os = stores.map(s => t.objectStore(s));
    let out;
    try { out = fn(...os); } catch (e) { try { t.abort(); } catch (_) { /* önemsiz */ } rej(e); return; }
    t.oncomplete = () => res(out && typeof out === 'object' && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('işlem iptal edildi'));
  }));

  return {
    // klasör kayıtları (vault.js bunları kullanır)
    get: id => run(['folders'], 'readonly', s => s.get(id)),
    put: rec => run(['folders'], 'readwrite', s => s.put(rec)),
    delete: id => run(['folders'], 'readwrite', s => s.delete(id)),

    // dosya kayıtları
    listFiles: folder => run(['files'], 'readonly', s => s.index('folder').getAll(IDBKeyRange.only(folder))),
    getFile: id => run(['files'], 'readonly', s => s.get(id)),
    putFile: rec => run(['files'], 'readwrite', s => s.put(rec)),
    // dosya kaydını ve küçük resmini birlikte siler
    delFile: id => run(['files', 'thumbs'], 'readwrite', (f, t) => { f.delete(id); t.delete(id); return null; }),

    // küçük resimler
    getThumb: id => run(['thumbs'], 'readonly', s => s.get(id)),
    putThumb: rec => run(['thumbs'], 'readwrite', s => s.put(rec)),

    // bir klasörün tüm dosya ve küçük resim kayıtlarını siler
    deleteFolderFiles: folder => run(['files', 'thumbs'], 'readwrite', (files, thumbs) => {
      const req = files.index('folder').openKeyCursor(IDBKeyRange.only(folder));
      req.onsuccess = () => {
        const c = req.result;
        if (c) { files.delete(c.primaryKey); thumbs.delete(c.primaryKey); c.continue(); }
      };
      return null;
    })
  };
}
